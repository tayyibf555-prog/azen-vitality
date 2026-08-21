-- 0090_collection_agent.sql
-- The outstanding-balance collection agent: polite, capped, approval-only
-- reminders about an invoice a patient has not paid.
--
-- ===========================================================================
-- WHAT THIS AGENT IS BUILT ON, AND WHAT IT IS DELIBERATELY NOT BUILT ON.
--
-- There are two "outstanding" figures in this platform and they mean opposite
-- things. treatment_opportunity.amount_outstanding is derived from a treatment
-- plan's private_treatment_value: live Dentally publishes NO balance on a plan
-- (see the calibration block in src/app/api/sync/coordinator/route.ts), so for an
-- incomplete plan that figure is the cost of treatment STILL TO BE DONE, not money
-- owed. The treatment-plan closer refuses any wording that calls it a debt, and
-- this module never reads it.
--
-- The only thing in Dentally that represents money a patient actually owes is an
-- UNPAID INVOICE (GET /v1/invoices, amount_outstanding on the invoice), which is
-- what the Payments page already totals. This agent is built on that and on
-- nothing else, and it verifies every figure TWICE before a word is drafted: once
-- from the practice-wide debtors scan and once from a fresh read of that patient's
-- own invoices. The two must agree to the penny or nothing is written.
--
-- ===========================================================================
-- DRAFT FOR APPROVAL, ALWAYS, WITH NO PATH TO ANYTHING ELSE.
--
-- The treatment-plan closer ships approval-first and is intended to earn an
-- auto-send mode later. This module has no such plan and no such switch. Money
-- plus patients is the one combination where a wrong message is not a tone problem
-- but a false statement about somebody's finances, made by a machine, on the
-- practice's letterhead. A person reads every message before it leaves, for good.
--
-- THAT IS STRUCTURAL HERE, NOT A CONVENTION. Three independent reasons, any one of
-- which alone would stop it:
--   1. collection_outbox.status has NO 'draft' value in its check constraint, so a
--      draft cannot even be represented as an outbox row;
--   2. the insert path (src/lib/collection/repository.ts insertDraft) writes
--      collection_touch and nothing else, and the ONLY function that writes
--      collection_outbox is approveDraft, which does so inside the same conditional
--      update that transitions the touch out of 'draft';
--   3. the shared messaging drain lists collection_outbox rows with status
--      'queued' only.
--
-- ===========================================================================
-- SAFE GATING (two independent OFFs, deliberately belt-and-braces)
--   1. CODE: 'balance-reminders' is declared defaultEnabled:false in
--      src/lib/systems/catalog.ts, so the ABSENCE of a system_toggle row means
--      DISABLED for EVERY client, in every environment, including one where this
--      migration has not run. Its fail-open error branches are suppressed too: a
--      toggle-read blip can never arm it.
--   2. DATA: the explicit seed row at the foot of this file, for parity with how
--      0041 / 0047 / 0071 / 0077 / 0085 seeded their modules OFF. `on conflict do
--      nothing` is essential: re-running this migration must never stamp OFF over
--      an owner's later deliberate ON.
-- Mechanism 2 alone would NOT be sufficient (it covers one client, once), which is
-- exactly why mechanism 1 exists.
--
-- WHY ITS OWN TABLES. Every lifecycle module owns its touch + outbox pair because
-- each *_outbox.touch_id is a hard FK to its OWN *_touch (see 0010's header, and
-- note that the generically named `outbox` from 0001 is in fact the COORDINATOR's).
-- A collection row written into another module's outbox would violate that FK.
--
-- NO CLINICAL DATA IS STORED HERE, and none is drafted into a message either: the
-- drafter is never told what the invoice is for, and its compliance scan refuses
-- any named procedure outright. An SMS reading "your root canal invoice is unpaid"
-- is legible on a lock screen and on a shared handset.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client, consistent with 0026/0034/0049/0085.

-- ---------------------------------------------------------------------------
-- Per-patient collection state. ONE conversation per patient, not per invoice: a
-- patient with three unpaid invoices is one person with one balance, and three
-- parallel cadences would be three messages a week from the same practice.
--
-- The primary key is the Dentally patient id, which is why there is no foreign key
-- on it: patients are not mirrored into a local table, they live in Dentally. The
-- site is stored alongside so every read is site-scoped like the rest of the
-- platform.
--
--   active            -- eligible; the next due step may be drafted
--   awaiting_approval -- a draft exists and a human has not yet acted on it
--   in_flight         -- approved and queued; the shared drain owns it now
--   stopped           -- terminal, with stop_reason
--   exhausted         -- terminal, every cadence step has been sent
-- ---------------------------------------------------------------------------
create table if not exists collection_state (
  patient_id text primary key,
  site_id text not null,
  status text not null default 'active'
    check (status in ('active', 'awaiting_approval', 'in_flight', 'stopped', 'exhausted')),
  -- Highest cadence step actually SENT (0 = nothing has gone out yet). Advanced
  -- only by a confirmed send, never by drafting and never by approving.
  step integer not null default 0,
  stop_reason text,
  -- THE ESCALATION. Not a log line: a work item. Set whenever the agent has
  -- deliberately stopped and handed the conversation to a person — any inbound
  -- reply at all, a credit balance, an invoice we could not read, a balance too
  -- large to text about. Cleared by a person picking it up.
  escalated_at timestamptz,
  escalation_reason text,
  first_qualified_at timestamptz not null default now(),
  -- When the last reminder was SENT (not drafted). Drives the next due date.
  last_touch_at timestamptz,
  last_drafted_at timestamptz,
  -- No draft may be created before this instant. Set by a compliance refusal, by a
  -- human discarding a draft, by a failed send and by a blocked one.
  retry_not_before timestamptz,
  -- Consecutive non-DELIVERIES: the provider could not deliver. Reset by a send.
  consecutive_failures integer not null default 0,
  -- Consecutive BLOCKED sends, counted separately on purpose. The shared drain
  -- calls markBlocked for four different things, and one of them is the
  -- cross-module once-per-day frequency cap doing exactly its job. Folding that
  -- into consecutive_failures (which is what every other module does) retires a
  -- perfectly reachable patient as "undeliverable" because their daily slot kept
  -- going to a recall invite. So a block cools the conversation off without
  -- counting as a failure, and carries its own higher ceiling so a genuinely stuck
  -- row still cannot loop forever.
  consecutive_blocks integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists idx_collection_state_site_status on collection_state (site_id, status);
-- The "needs a person" list: escalated rows for a site, newest first.
create index if not exists idx_collection_state_escalated
  on collection_state (site_id, escalated_at)
  where escalated_at is not null;

-- ---------------------------------------------------------------------------
-- Collection touches. A touch is created in 'draft' and NOTHING is written to
-- collection_outbox until a human approves it. 'discarded' is the exit a rejected
-- draft needs; without it a rejected draft is neither sent nor failed and wedges
-- the conversation forever.
-- ---------------------------------------------------------------------------
create table if not exists collection_touch (
  id uuid primary key default gen_random_uuid(),
  patient_id text not null,
  site_id text not null,
  step integer not null default 0,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  drafted_by text not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'queued', 'sending', 'sent', 'failed', 'discarded')),
  approved_by text,
  discard_reason text,
  -- The balance IN WHOLE PENCE that this draft was written against, or NULL when
  -- the draft quotes no figure at all (which is every draft written while
  -- COLLECTION_QUOTE_AMOUNT is off — see src/lib/collection/draft.ts for why the
  -- figure is withheld until the live money unit has been reconciled once).
  --
  -- Whole pence, never a float: money summed as a floating-point number is money
  -- that eventually prints a rounding tail at a patient. The approval route
  -- re-scans a HUMAN's edit against this column rather than against a fresh read,
  -- so an edit is held to the figure the draft was written against and cannot
  -- smuggle in a different one.
  amount_pence bigint,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_collection_touch_patient on collection_touch (patient_id);
-- The worklist counts drafts awaiting a human per site.
create index if not exists idx_collection_touch_awaiting on collection_touch (site_id, status);

-- ---------------------------------------------------------------------------
-- Collection outbox. Same shape as recall_outbox / closer_outbox so the shared
-- drain, the Twilio status webhook and the inbound webhook handle it with
-- identical logic. 'delivered' is in the check because the status webhook writes
-- it. THERE IS NO 'draft' VALUE, and its absence is reason 1 of the three above.
-- ---------------------------------------------------------------------------
create table if not exists collection_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references collection_touch (id) on delete cascade,
  site_id text not null,
  channel text not null,
  to_ref text not null,
  body text not null,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'delivered', 'failed')),
  provider text,
  to_address text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_collection_outbox_msgid on collection_outbox (provider_message_id);
-- The shared drain lists queued rows for the site set, oldest first.
create index if not exists idx_collection_outbox_queued on collection_outbox (site_id, status, created_at);

-- Server-only: RLS on, no anon/authenticated grants (0012 posture).
alter table collection_state enable row level security;
alter table collection_touch enable row level security;
alter table collection_outbox enable row level security;
revoke all on collection_state from anon, authenticated;
revoke all on collection_touch from anon, authenticated;
revoke all on collection_outbox from anon, authenticated;

comment on column collection_touch.amount_pence is
  'Whole pence the draft was written against, or NULL when it quotes no figure. The approval route re-scans a human edit against THIS, not against a fresh balance read.';
comment on column collection_state.escalation_reason is
  'Why a person must pick this patient up. Any inbound reply at all sets one, including a reply the classifier could not place (unclear_reply) - see src/lib/collection/cadence.ts.';

-- ---------------------------------------------------------------------------
-- Ship the switch OFF (mechanism 2 of the two described in the header).
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled, updated_by)
values ('vitality', 'balance-reminders', false, 'migration:0090')
on conflict (client_id, module_slug) do nothing;
