-- 0085_treatment_closer.sql
-- Treatment-plan closer: the conversational follow-up on treatment that was
-- planned and never completed. The Treatment Coordinator module already SURFACES
-- these opportunities and runs a short 0/3/7-day nudge; the closer is the slower,
-- approval-first conversation that runs AFTER that nudge has had its chance.
--
-- WHY ITS OWN TABLES (and not the coordinator's)
-- Every module in this platform owns its touch + outbox pair because each
-- *_outbox.touch_id is a hard FK to its OWN *_touch (see 0010's header, and note
-- that the generically named `outbox` table from 0001 is in fact the
-- COORDINATOR's, FK'd to coordinator_touch). A closer row written into `outbox`
-- would violate that FK. Beyond the FK, the separation is what makes the closer
-- switchable on its own: the coordinator's kill switch is DEFAULT-ON by the
-- absence of a system_toggle row, so folding closer behaviour into the
-- coordinator's sweep would silently ARM a brand new send surface for every
-- client that has never touched the control panel. A separate module with its
-- own default-OFF slug cannot do that.
--
-- SAFE GATING (two independent OFFs, deliberately belt-and-braces)
--   1. CODE: 'treatment-closer' is declared defaultEnabled:false in
--      src/lib/systems/catalog.ts. src/lib/systems/repository.ts consults
--      defaultEnabledFor(slug) instead of a hard-coded `true`, so the ABSENCE of
--      a row means DISABLED for this slug, for EVERY client, in every
--      environment, including one where this migration has not run. Its
--      fail-open error branches are also suppressed for a default-off slug: a
--      toggle-read blip can never arm the closer.
--   2. DATA: the explicit seed row below, for parity with how 0041/0047/0071/0077
--      seeded outreach / whatsapp / fp17 / staff-esign OFF. `on conflict do
--      nothing` is essential: re-running this migration must never stamp OFF over
--      an owner's later deliberate ON.
-- Mechanism 2 alone would NOT be sufficient (it only covers client 'vitality',
-- and only once the migration has run), which is exactly why mechanism 1 exists.
--
-- No clinical data is stored here. The figure the closer talks about is the
-- REMAINING TREATMENT VALUE carried on treatment_opportunity.amount_outstanding,
-- which live Dentally derives from the plan's private_treatment_value (Dentally
-- exposes no billed balance at all). It is NOT money the patient owes, and the
-- drafter refuses any wording that says it is.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client, consistent with 0026/0034/0049.

-- ---------------------------------------------------------------------------
-- Per-opportunity closer state.
--
-- The coordinator derives its cadence position by COUNTING sent touches, which
-- has two failure modes we deliberately do not inherit: a permanently failing
-- channel replays step 1 forever, and a draft that a human rejects leaves the
-- opportunity with a non-sent, non-failed touch that its pending-guard reads as
-- "still in flight" forever. The closer stores its position and its lifecycle
-- explicitly instead, so every exit is representable.
--   active            -- eligible; the next due step may be drafted
--   awaiting_approval -- a draft exists and a human has not yet acted on it
--   in_flight         -- approved and queued; the shared drain owns it now
--   stopped           -- terminal, with stop_reason (replied / dispute / opted out / ...)
--   exhausted         -- terminal, every cadence step has been sent
-- ---------------------------------------------------------------------------
create table if not exists closer_state (
  opportunity_id text primary key references treatment_opportunity (id) on delete cascade,
  site_id text not null,
  status text not null default 'active'
    check (status in ('active', 'awaiting_approval', 'in_flight', 'stopped', 'exhausted')),
  -- Highest cadence step actually SENT (0 = nothing has gone out yet). Advanced
  -- only by a confirmed send, never by drafting and never by approving.
  step integer not null default 0,
  stop_reason text,
  first_qualified_at timestamptz not null default now(),
  -- When the last closer message was SENT (not drafted). Drives the next due date.
  last_touch_at timestamptz,
  last_drafted_at timestamptz,
  -- No draft may be created before this instant. Set by a compliance refusal (so a
  -- systematically-refusing opportunity cannot burn the AI budget every tick), by a
  -- human discarding a draft, and by a failed/blocked send.
  retry_not_before timestamptz,
  -- Consecutive non-deliveries (failed or blocked). Reset to 0 by a confirmed send.
  -- At the configured ceiling the opportunity is retired 'undeliverable', which is
  -- the fix for the coordinator's latent "a permanently failing channel replays the
  -- same step forever" behaviour.
  consecutive_failures integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists idx_closer_state_site_status on closer_state (site_id, status);

-- ---------------------------------------------------------------------------
-- Closer touches. A touch is created in 'draft' and NOTHING is written to
-- closer_outbox until it is approved, so the shared messaging drain (which lists
-- only outbox rows with status 'queued') is structurally incapable of sending a
-- draft. 'discarded' is the exit a rejected draft needs; without it a rejected
-- draft is neither sent nor failed and wedges the opportunity forever.
-- ---------------------------------------------------------------------------
create table if not exists closer_touch (
  id uuid primary key default gen_random_uuid(),
  opportunity_id text not null references treatment_opportunity (id) on delete cascade,
  site_id text not null,
  step integer not null default 0,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  drafted_by text not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'queued', 'sending', 'sent', 'failed', 'discarded')),
  approved_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_closer_touch_opp on closer_touch (opportunity_id);
-- The worklist counts drafts awaiting a human per site.
create index if not exists idx_closer_touch_awaiting on closer_touch (site_id, status);

-- ---------------------------------------------------------------------------
-- Closer outbox. Same shape as recall_outbox / review_outbox so the shared drain,
-- the Twilio status webhook and the inbound webhook handle it with identical
-- logic. 'delivered' is in the check because the status webhook writes it.
-- ---------------------------------------------------------------------------
create table if not exists closer_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references closer_touch (id) on delete cascade,
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
create index if not exists idx_closer_outbox_msgid on closer_outbox (provider_message_id);
-- The shared drain lists queued rows for the site set, oldest first.
create index if not exists idx_closer_outbox_queued on closer_outbox (site_id, status, created_at);

-- Server-only: RLS on, no anon/authenticated grants (0012 posture).
alter table closer_state enable row level security;
alter table closer_touch enable row level security;
alter table closer_outbox enable row level security;
revoke all on closer_state from anon, authenticated;
revoke all on closer_touch from anon, authenticated;
revoke all on closer_outbox from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ship the switch OFF (mechanism 2 of the two described in the header).
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled, updated_by)
values ('vitality', 'treatment-closer', false, 'migration:0085')
on conflict (client_id, module_slug) do nothing;
