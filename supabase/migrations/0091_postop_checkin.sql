-- 0091_postop_checkin.sql
-- Post-op check-in: the day-after aftercare check on flagged procedures
-- (extractions, implants, anything surgical).
--
-- WHAT THIS MODULE IS ALLOWED TO DO, IN ONE LINE: ask one question and route the
-- answer to a person. It TRIAGES, it never advises. There is no drafter and no
-- model call anywhere in it; every patient-facing string is a fixed template in
-- src/lib/postop/copy.ts, which is why no jailbreak, no injected appointment
-- reason and no model slip can produce clinical guidance in its name.
--
-- WHY ITS OWN TABLES. Every module in this platform owns its touch + outbox pair
-- because each *_outbox.touch_id is a hard FK to its OWN *_touch (see 0010's
-- header, and note that the generically named `outbox` from 0001 is in fact the
-- COORDINATOR's, FK'd to coordinator_touch). A post-op row written into another
-- module's outbox would violate that FK. Beyond the FK, the separation is what
-- makes this module switchable on its own: system_toggle is DEFAULT-ON by the
-- absence of a row, so folding post-op sends into an existing module's sweep
-- would silently ARM a brand new send surface for every client that has never
-- opened the control panel.
--
-- SAFE GATING (two independent OFFs, deliberately belt-and-braces, exactly the
-- treatment-closer precedent from 0085)
--   1. CODE: 'postop-checkin' is declared defaultEnabled:false in
--      src/lib/systems/catalog.ts. src/lib/systems/repository.ts consults
--      defaultEnabledFor(slug), so the ABSENCE of a row means DISABLED for this
--      slug, for EVERY client, in every environment, including one where this
--      migration has not run. Its fail-open error branches are suppressed too: a
--      toggle-read blip can never arm it.
--   2. DATA: the explicit seed row at the foot of this file, for parity with how
--      0041/0047/0071/0077/0085 seeded outreach / whatsapp / fp17 / staff-esign /
--      the closer OFF. `on conflict do nothing` is essential: re-running this
--      migration must never stamp OFF over an owner's later deliberate ON.
-- Mechanism 2 alone would NOT be sufficient (it covers only client 'vitality',
-- and only once the migration has run), which is exactly why mechanism 1 exists.
--
-- NO CLINICAL DATA IS STORED HERE. `procedure_source` is the SANITISED Dentally
-- appointment text the flag was derived from, kept so a practice can see why a
-- patient was flagged; it is never sent to a patient and never put in a prompt.
-- The patient's reply body IS stored (as an inbound touch and on the escalation
-- row) because a person has to read it in order to act on it, which is the entire
-- purpose of the escalation.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client, consistent with 0026/0034/0049/0085.

-- ---------------------------------------------------------------------------
-- One row per flagged, completed appointment.
--
-- The primary key is `${site_id}:${appointment_id}`, which is derivable without a
-- database read, so the sweep can upsert idempotently: re-running it over the same
-- day's book cannot create a second check-in for the same procedure.
--
--   pending            flagged; the check-in has not been drafted
--   awaiting_approval  a draft exists and a human has not acted on it
--   in_flight          approved and queued; the shared drain owns it now
--   sent               delivered; we are waiting on a reply
--   escalated          the patient replied with something a human must handle
--   closed             the patient replied and the reply was an all-clear
--   stopped            terminal without a check-in (no consent / opted out / stale)
--
-- 'escalated' is deliberately NOT terminal. A patient who has already been
-- escalated can text again with more detail, and that must escalate again rather
-- than be swallowed by a status check.
-- ---------------------------------------------------------------------------
create table if not exists postop_target (
  id text primary key,
  site_id text not null,
  dentally_patient_id text not null,
  appointment_id text not null,
  patient_name text not null,
  procedure_flag text not null
    check (procedure_flag in ('extraction', 'implant', 'surgical')),
  -- The sanitised Dentally text the flag came from. Audit only, never sent.
  procedure_source text not null default '',
  procedure_at timestamptz not null,
  -- Earliest the check-in may be sent: the configured delay after the procedure,
  -- clamped into 08:00-20:00 Europe/London (src/lib/postop/schedule.ts).
  due_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'awaiting_approval', 'in_flight', 'sent', 'escalated', 'closed', 'stopped')),
  stop_reason text,
  consent_sms boolean not null default false,
  consent_email boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_postop_target_due on postop_target (site_id, status, due_at);
create index if not exists idx_postop_target_patient on postop_target (site_id, dentally_patient_id);

-- ---------------------------------------------------------------------------
-- Touches. A touch is created in 'draft' and NOTHING is written to postop_outbox
-- until it is approved, so the shared messaging drain (which lists only outbox
-- rows with status 'queued') is structurally incapable of sending a draft.
--
-- THE THREE INDEPENDENT REASONS A DRAFT CANNOT BE SENT, each provable on its own:
--   1. postop_outbox.status has NO 'draft' value in its CHECK constraint below, so
--      a draft row cannot even exist in the outbox;
--   2. insertDraft (src/lib/postop/repository.ts) writes postop_touch ONLY, and
--      the single function that writes postop_outbox is approveDraft;
--   3. the drain filters status = 'queued', so a row that somehow existed in any
--      other state would still not be listed.
-- Break any one of the three and the other two still hold.
--
-- 'discarded' is the exit a rejected draft needs; without it a rejected draft is
-- neither sent nor failed and wedges the target forever.
-- ---------------------------------------------------------------------------
create table if not exists postop_touch (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references postop_target (id) on delete cascade,
  site_id text not null,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'queued', 'sending', 'sent', 'failed', 'discarded')),
  actioned_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_postop_touch_target on postop_touch (target_id);
create index if not exists idx_postop_touch_awaiting on postop_touch (site_id, status);

-- ---------------------------------------------------------------------------
-- Outbox. Same shape as diary_outbox (not closer_outbox) because this module
-- needs the one column the closer does not: `not_before_at`.
--
-- The shared drain has NO time-of-day gate; it sends whatever is queued whenever
-- pg_cron wakes it. Quiet hours for this module therefore live on the row, exactly
-- as they do for the diary, and listQueuedOutbox filters `not_before_at <= now()`.
-- Approving a draft at 22:30 queues a row the drain will not pick up until 08:00.
--
-- 'draft' is deliberately ABSENT from this CHECK. See the touch table's header.
-- 'delivered' is present because the Twilio status webhook writes it.
-- ---------------------------------------------------------------------------
create table if not exists postop_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references postop_touch (id) on delete cascade,
  site_id text not null,
  channel text not null,
  to_ref text not null,
  body text not null,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'delivered', 'failed')),
  not_before_at timestamptz not null default now(),
  provider text,
  to_address text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_postop_outbox_msgid on postop_outbox (provider_message_id);
create index if not exists idx_postop_outbox_queued on postop_outbox (site_id, status, not_before_at, created_at);
create index if not exists idx_postop_outbox_address on postop_outbox (to_address, created_at desc);

-- ---------------------------------------------------------------------------
-- Escalations. The output of the module, and the reason it exists.
--
-- One row per reply that a human must handle. The reply body is stored verbatim
-- (a person has to read what the patient actually said) alongside the triage
-- reason, which is a LABEL and not a severity grade: grading how serious a symptom
-- is would be exactly the clinical judgement this module refuses to make, so every
-- row is urgent and there is no priority column to sort them by.
--
-- `resolved_at` / `resolved_by` are the only mutable fields: an escalation is
-- closed by the person who dealt with it, never by the software.
-- ---------------------------------------------------------------------------
create table if not exists postop_escalation (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references postop_target (id) on delete cascade,
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null,
  channel text not null,
  -- The patient's own words. Stored so a person can read them, never re-sent.
  reply_body text not null,
  -- One of: symptom | distress | question | media | unreadable | ambiguous |
  -- too_long. Deliberately NOT constrained by a CHECK: the triage classifier is
  -- expected to gain categories, and a new one must surface as a task rather than
  -- fail an insert and lose the escalation entirely.
  triage_reason text not null,
  -- The token or phrase the classifier matched, for the person picking it up.
  matched text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
create index if not exists idx_postop_escalation_open on postop_escalation (site_id, resolved_at, created_at);
create index if not exists idx_postop_escalation_target on postop_escalation (target_id);

-- Server-only: RLS on, no anon/authenticated grants (0012 posture).
alter table postop_target enable row level security;
alter table postop_touch enable row level security;
alter table postop_outbox enable row level security;
alter table postop_escalation enable row level security;
revoke all on postop_target from anon, authenticated;
revoke all on postop_touch from anon, authenticated;
revoke all on postop_outbox from anon, authenticated;
revoke all on postop_escalation from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ship the switch OFF (mechanism 2 of the two described in the header).
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled, updated_by)
values ('vitality', 'postop-checkin', false, 'migration:0091')
on conflict (client_id, module_slug) do nothing;
