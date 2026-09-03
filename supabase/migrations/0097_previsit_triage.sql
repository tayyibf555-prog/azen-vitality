-- 0097_previsit_triage.sql
-- Pre-appointment triage + treatment-interest capture.
--
-- WHAT THIS MODULE IS, IN ONE LINE: a short questionnaire a patient answers on
-- their phone before an appointment, plus a tick-grid of treatments they might
-- want to hear about. The answers reach the clinician ("this is what the patient
-- shared"); the ticks accrue on per-treatment lists the practice can follow up.
--
-- ---------------------------------------------------------------------------
-- THE ONE RULE THIS SCHEMA IS SHAPED AROUND: previsit_target.fork
-- ---------------------------------------------------------------------------
-- Under the NHS contract a symptom a patient volunteers has to be treated under
-- that contract, so an NHS-plan patient must never be ASKED a pain / symptom /
-- treatment-need question before their visit. Asking creates the obligation, so
-- the guard is on the QUESTION, not on the answer.
--
-- `fork` is that decision, made SERVER-SIDE from the patient's Dentally payment
-- plan (src/lib/triage/fork.ts) and written once, by the sweep. It is never taken
-- from a request: the public form resolves it from the target the link points at,
-- and the submitted response copies it, so a patient cannot ask for the other
-- bank and a plan change between the send and the submit cannot rewrite history.
--
-- IT IS 'full' / 'brief', NOT 'private' / 'nhs', AND THAT IS DELIBERATE. The
-- patient must never see the words NHS or private (the funding-jargon rule), and
-- this column is projected into staff screens beside patient-facing previews. A
-- funding word cannot leak from a column that never holds one. src/lib/triage/
-- types.ts carries the full reasoning; a crawl over every patient-facing string
-- in the module pins it.
--
-- ---------------------------------------------------------------------------
-- SAFE GATING (two independent OFFs, the 0085/0090/0091/0093 precedent)
--   1. CODE: 'pre-visit-triage' is declared defaultEnabled:false in
--      src/lib/systems/catalog.ts, so the ABSENCE of a system_toggle row means
--      DISABLED for this slug, for EVERY client, in every environment, including
--      one where this migration has not run. Its fail-open error branches are
--      suppressed too: a toggle-read blip can never arm it.
--   2. DATA: the explicit seed row at the foot of this file, for parity with how
--      0041/0047/0071/0077/0085/0090/0091/0093 seeded their surfaces OFF.
--      `on conflict do nothing` is essential: re-running this migration must
--      never stamp OFF over an owner's later deliberate ON.
-- Mechanism 2 alone would NOT be sufficient (it covers only client 'vitality',
-- and only once the migration has run), which is exactly why mechanism 1 exists.
--
-- ---------------------------------------------------------------------------
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client, consistent with 0026/0034/0049/
-- 0085/0090/0091. That matters more here than usual: previsit_response holds a
-- patient's own words about their mouth, and treatment_interest is a marketing
-- list keyed to a named patient.

-- ---------------------------------------------------------------------------
-- The two question banks, as EDITABLE DEFAULTS.
--
-- At most two rows per client. A client with NO row is running the shipped
-- defaults (src/lib/triage/bank.ts defaultConfigFor), and that is a real state
-- rather than a missing one: writing a default row on first read would turn "we
-- ship these questions" into "somebody once chose these questions", and the
-- practice would silently stop picking up improvements to the defaults.
--
-- The config is jsonb and therefore untrusted by the code that reads it: a
-- partial or corrupted blob falls back to the defaults rather than being
-- repaired, and the projection filters symptom questions out of the brief bank
-- whatever this column says. See src/lib/triage/project.ts.
-- ---------------------------------------------------------------------------
create table if not exists previsit_bank (
  client_id text not null,
  fork text not null check (fork in ('full', 'brief')),
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (client_id, fork)
);

-- ---------------------------------------------------------------------------
-- One row per upcoming appointment the link is sent for.
--
-- The primary key is `${site_id}:${appointment_id}`, derivable with no database
-- read, so the sweep upserts idempotently: re-reading the same window cannot
-- create a second target for the same appointment or re-text a patient who has
-- already filled the form in.
--
--   pending    flagged; nothing composed yet
--   queued     an outbox row exists; the shared drain owns it now
--   sent       the link went out
--   answered   the patient submitted; the link is SPENT
--   stopped    terminal without a send (no consent / opted out / stale / off)
--
-- 'answered' IS TERMINAL, unlike post-op's 'escalated'. There is one form per
-- appointment and one submit per form: the conditional transition in
-- recordResponse is what makes a double submit impossible, and a spent link stops
-- opening the form at all.
--
-- link_token IS THE PUBLIC LINK. 22 base64url characters of CSPRNG randomness
-- (128 bits), unique, minted on the row. NOT a signed patient token, and that is
-- a decision with three reasons, in src/lib/triage/link.ts: a signed token is
-- ~170 characters and would blow the one-SMS-credit brief on its own; it cannot
-- express "this link has been used"; and it CARRIES { siteId, patientRef } in a
-- readable base64 payload, which a link sitting in a phone's message list should
-- not.
-- ---------------------------------------------------------------------------
create table if not exists previsit_target (
  id text primary key,
  site_id text not null,
  dentally_patient_id text not null,
  appointment_id text not null,
  patient_name text not null,
  fork text not null check (fork in ('full', 'brief')),
  appointment_at timestamptz not null,
  -- Earliest the link may be sent: the appointment minus the configured lead,
  -- clamped into 08:00-20:00 Europe/London (src/lib/triage/schedule.ts).
  due_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'sent', 'answered', 'stopped')),
  stop_reason text,
  consent_sms boolean not null default false,
  link_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- UNIQUE, and it is the whole authorisation model for the public page: a link
-- resolves to at most one target, and a caller without one cannot address any row.
create unique index if not exists idx_previsit_target_token on previsit_target (link_token);
create index if not exists idx_previsit_target_due on previsit_target (site_id, status, due_at);
create index if not exists idx_previsit_target_patient on previsit_target (site_id, dentally_patient_id);

-- ---------------------------------------------------------------------------
-- Touches + outbox. THIS MODULE'S OWN PAIR, because every module owns its own:
-- previsit_outbox.touch_id is a hard FK to previsit_touch (see 0010's header, and
-- note that the generically named `outbox` from 0001 is in fact the COORDINATOR's,
-- FK'd to coordinator_touch). Beyond the FK, the separation is what makes this
-- module switchable on its own — system_toggle is default-ON by the absence of a
-- row, so folding these sends into an existing module's sweep would silently ARM
-- a brand new send surface for every client that has never opened the panel.
--
-- THERE IS NO 'draft' STATE, AND THAT IS A DECISION RATHER THAN AN OMISSION.
-- The closer, the balance reminder and the post-op check-in are draft-for-approval
-- because a human is deciding WHETHER to say something to a particular patient
-- about their clinical or financial situation. This message says nothing about the
-- patient at all: a fixed template with a first name and a link, sent to everybody
-- with an appointment. Asking a receptionist to approve four hundred identical
-- texts a week is not a safety control, it is a guarantee the feature is never
-- used. The no-show confirmation — the other appointment-relative, fixed-template,
-- everybody-gets-one message — queues directly for exactly this reason.
--
-- What replaces the approval is the COMPOSITION SCAN: checkTriageMessage refuses
-- to store a body that breaks a rule, so there is never a queued row a human would
-- have had to catch. And the outbox CHECK below has no 'draft' value at all, so if
-- a future change did add a draft state it could not be queued by accident.
-- ---------------------------------------------------------------------------
create table if not exists previsit_touch (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references previsit_target (id) on delete cascade,
  site_id text not null,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'failed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_previsit_touch_target on previsit_touch (target_id);
create index if not exists idx_previsit_touch_site on previsit_touch (site_id, status);

-- Same shape as diary_outbox / postop_outbox, because this module needs the one
-- column the closer's does not: `not_before_at`. The shared drain has NO
-- time-of-day gate — it sends whatever is queued whenever pg_cron wakes it — so
-- quiet hours for this module live on the row, and listQueuedOutbox filters
-- `not_before_at <= now()`.
create table if not exists previsit_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references previsit_touch (id) on delete cascade,
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
create index if not exists idx_previsit_outbox_msgid on previsit_outbox (provider_message_id);
create index if not exists idx_previsit_outbox_queued on previsit_outbox (site_id, status, not_before_at, created_at);
create index if not exists idx_previsit_outbox_address on previsit_outbox (to_address, created_at desc);

-- ---------------------------------------------------------------------------
-- The completed questionnaire.
--
-- `fork` is COPIED from the target at submit rather than joined, and the
-- duplication is deliberate: it records which list this patient was ACTUALLY
-- asked, which is a historical fact. Joining would answer "which list would they
-- get today", and a patient who moved between plans would have their past answers
-- silently re-labelled.
--
-- `answers` is a jsonb array of { key, value }; `interest` a jsonb array of
-- { treatment, answer }. Both are validated key-by-key against the projected bank
-- before they are written (src/app/api/previsit/submit/route.ts), so an unknown
-- key is dropped rather than stored and a forged form cannot bloat the record.
--
-- WHAT IS HERE IS THE PATIENT'S OWN WORDS. Not a clinical assessment, not
-- reviewed by anyone, and the screen that renders it says so before it shows a
-- single answer (SUMMARY_COPY.provenance).
-- ---------------------------------------------------------------------------
create table if not exists previsit_response (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references previsit_target (id) on delete cascade,
  site_id text not null,
  dentally_patient_id text not null,
  fork text not null check (fork in ('full', 'brief')),
  answers jsonb not null default '[]'::jsonb,
  interest jsonb not null default '[]'::jsonb,
  submitted_at timestamptz not null default now()
);
create index if not exists idx_previsit_response_patient on previsit_response (site_id, dentally_patient_id, submitted_at desc);
create index if not exists idx_previsit_response_target on previsit_response (target_id);

-- ---------------------------------------------------------------------------
-- The per-treatment interest lists.
--
-- BOTH ANSWERS ARE STORED, not only the yeses. "Not right now" is a real answer
-- and not the absence of one: storing it is what lets the practice see that a
-- patient was asked and said no, rather than asking them again every six months
-- because the row was blank. The list views filter to 'yes', which is the list
-- anybody acts on; the refusals have to be asked for by name.
--
-- One row per (patient, treatment, response), so a patient who fills the form in
-- before two appointments has two rows for whitening. The COUNT the practice sees
-- is DISTINCT PATIENTS (countInterestByTreatment), because two rows is one person.
--
-- NO CONSENT COLUMN, deliberately. This table records what a patient said when
-- asked, which is not the same as permission to market to them: every send out of
-- this platform goes through the shared messaging layer, which checks Dentally
-- consent flags and the suppression list at the choke point. A consent column here
-- would be a second, staler copy of a fact that already has one home.
-- ---------------------------------------------------------------------------
create table if not exists treatment_interest (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null default '',
  treatment text not null
    check (treatment in ('whitening', 'straightening', 'implants', 'veneers-bonding')),
  answer text not null check (answer in ('yes', 'not_now')),
  response_id uuid not null references previsit_response (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_treatment_interest_list on treatment_interest (site_id, treatment, answer, created_at desc);
create index if not exists idx_treatment_interest_patient on treatment_interest (site_id, dentally_patient_id);

-- ---------------------------------------------------------------------------
-- The implant-interest mining list: 18+ patients with an extraction on record.
--
-- TWO TABLES BECAUSE THEY ARE TWO DIFFERENT FACTS, and the second is not
-- metadata. `previsit_mining_candidate` is who the scan found;
-- `previsit_mining_scan` is HOW MUCH OF THE PAST WAS ACTUALLY READ.
--
-- WHY A COVERAGE ROW EXISTS AT ALL. There is NO Dentally read that answers "every
-- patient who has ever had an extraction", and that was established by probe
-- rather than assumed: /v1/appointments is the only endpoint carrying
-- plain-English procedure text and it is date-windowed with no patient filter;
-- /v1/treatment_plan_items is practice-wide but carries no treatment NAME at all
-- (only treatment_id and a staff nomenclature code) across ~999,000 rows;
-- /v1/invoices carries line items only on the per-invoice detail route, which
-- would be one GET per invoice across ~34,000 invoices.
--
-- So the scan walks a ROLLING WINDOW backwards from today, a bounded number of
-- days per run, and this table records exactly how far it has reached. The list
-- is then a true statement ("patients with an extraction on record between D1 and
-- D2") rather than a false one, and the window is printed on the screen beside
-- the count. That is the complete-or-honest contract applied to a scan that can
-- never be complete: it does not wear a complete number's clothes.
--
-- THE EXCLUSION COUNTERS ARE PART OF THE ANSWER. A patient whose date of birth
-- cannot be read is left OFF the list (the rule is 18 and over, and unknown does
-- not satisfy it) and COUNTED, because a list that silently dropped people is a
-- list nobody can reconcile against the practice's own numbers.
--
-- THIS IS NOT A CLINICAL SHORTLIST, and MINING_CAVEATS is rendered beside it
-- rather than being available on request.
-- ---------------------------------------------------------------------------
create table if not exists previsit_mining_scan (
  site_id text primary key,
  covered_from date not null,
  covered_to date not null,
  examined integer not null default 0,
  candidates integer not null default 0,
  excluded_no_dob integer not null default 0,
  excluded_under_age integer not null default 0,
  last_run_at timestamptz not null default now(),
  more_to_read boolean not null default true
);

create table if not exists previsit_mining_candidate (
  -- `${site_id}:${dentally_patient_id}` so a re-read cannot list a patient twice.
  id text primary key,
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null default '',
  -- Whole years at the moment of the scan. Always >= 18 by construction; the
  -- CHECK is what makes that a property of the table rather than of the caller.
  age integer not null check (age >= 18),
  last_extraction_at timestamptz not null,
  -- The SANITISED diary text that produced the match, so a reader can judge the
  -- row for themselves. Audit only: never sent to a patient, never put in a
  -- prompt. Dentally free text is data, never instructions.
  matched_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_previsit_mining_site on previsit_mining_candidate (site_id, last_extraction_at desc);

-- Server-only: RLS on, no anon/authenticated grants (0012 posture).
alter table previsit_bank enable row level security;
alter table previsit_target enable row level security;
alter table previsit_touch enable row level security;
alter table previsit_outbox enable row level security;
alter table previsit_response enable row level security;
alter table treatment_interest enable row level security;
alter table previsit_mining_scan enable row level security;
alter table previsit_mining_candidate enable row level security;
revoke all on previsit_bank from anon, authenticated;
revoke all on previsit_target from anon, authenticated;
revoke all on previsit_touch from anon, authenticated;
revoke all on previsit_outbox from anon, authenticated;
revoke all on previsit_response from anon, authenticated;
revoke all on treatment_interest from anon, authenticated;
revoke all on previsit_mining_scan from anon, authenticated;
revoke all on previsit_mining_candidate from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Ship the switch OFF (mechanism 2 of the two described in the header).
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled, updated_by)
values ('vitality', 'pre-visit-triage', false, 'migration:0097')
on conflict (client_id, module_slug) do nothing;
