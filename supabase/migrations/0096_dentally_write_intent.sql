-- 0096_dentally_write_intent.sql
-- THE SYNC LEDGER: one row for every outbound Dentally write this platform makes,
-- attempts, simulates or refuses.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, the same convention as 0078-0083 and 0094 and for the
-- same reason: a migration file is written by the build and applied by a human
-- who has read it.
--
-- RUNNING IT CHANGES NOTHING THAT IS LIVE. One new table, three indexes, no
-- backfill, no seed, no change to any existing table's columns or RLS posture,
-- and no system_toggle row (this is not a system an owner switches — see below).
--
-- AND UNTIL IT IS APPLIED, THE PLATFORM STILL WORKS. Every insert goes through
-- recordWriteIntent in src/lib/dentally/sync-ledger.ts, which is fail-soft BY
-- CONSTRUCTION: it catches its own error, logs it loudly and returns null. That
-- is not laziness, it is the whole ordering decision of this lane — a ledger
-- write must never be the reason a patient's booking fails. On an un-migrated
-- database PostgREST answers "relation does not exist", the ledger records
-- nothing, the Sync Status page renders its empty state saying so, and every
-- write path behaves exactly as it did before this file existed.
-- ============================================================================
--
-- WHY A LEDGER AT ALL, WHILE WRITES ARE OFF.
--
-- The practice's question is "does what I do in this platform show up in
-- Dentally?" Today the honest answer is "no, and here is exactly what would
-- have gone across". This table is that answer, in rows rather than in prose:
-- every write the platform WOULD make is recorded with its kind, its target
-- ids, a payload SUMMARY and a status, so the day the write key arrives the
-- practice can read what has been queued up against what actually landed
-- instead of taking a promise on trust.
--
-- ============================================================================
-- WHAT IS DELIBERATELY NOT IN HERE: THE PATIENT.
--
-- payload_summary is a SUMMARY, not the payload. It is built by
-- summariseWritePayload (src/lib/dentally/write-gate.ts) on an ALLOW-LIST:
-- a key's VALUE is copied only when that key is on a fixed list of non-personal
-- fields (ids, times, duration, the whitelisted booking reason, the boolean
-- flags). Every other key contributes its NAME and nothing else — so the ledger
-- can say "this registration carried a first_name, a date_of_birth and a
-- mobile_phone" without holding one character of any of them.
--
-- An allow-list, never a deny-list, because a deny-list is wrong the first time
-- somebody adds a field: a new `nhs_number` or `address_line_1` would flow
-- straight into a table nobody thinks of as holding patient data. Under an
-- allow-list an unknown field is summarised as a name and is silent about its
-- value, which is the safe default and needs nobody to remember anything.
--
-- Dentally ids ARE stored (dentally_patient_id, dentally_appointment_id). They
-- are what makes a row actionable — "this is the write we would have made
-- against THAT record" — and the platform already stores Dentally patient ids on
-- every module's own target/opportunity table. No name, no date of birth, no
-- phone number, no email address, no clinical free text and no note body is
-- stored here by any path.
--
-- `error` is SANITISED before it lands: a Dentally 422 body can echo the fields
-- it rejected, so the recorder truncates and strips anything that looks like an
-- email address or a phone number (sanitiseWriteError).
--
-- ============================================================================
-- THE MASTER SWITCH, SEEDED OFF AT THE FOOT OF THIS FILE.
--
-- The TABLE needs no toggle of its own: it starts nothing, sweeps nothing,
-- messages nobody, and has no work to halt — it is the RECORD of what the systems
-- that DO write have done.
--
-- What DOES need one is the writing. Until now the only levers over an outbound
-- Dentally write were the agency's environment (DENTALLY_WRITE_*) and the switch
-- on whichever module happened to be writing, so a practice owner who wanted
-- everything to stop reaching their book had to find and flip nine of them. So
-- this file also seeds 'dentally-write-back': ONE owner lever above all five write
-- kinds, which the gate checks before it checks the module's own switch.
--
-- DEFAULT-OFF TWICE, the platform's rule for anything that acts on a patient:
-- `defaultEnabled: false` in src/lib/systems/catalog.ts means the ABSENCE of a row
-- is OFF for every client in every environment (including one where this migration
-- has not run), and the seed at the foot of this file is the second, independent
-- mechanism for the pilot client. Neither is sufficient alone: the catalog default
-- covers databases the seed never reached, and the seed is what an owner sees and
-- can flip.
--
-- IT COMPOSES WITH THE ENVIRONMENT, IT DOES NOT REPLACE IT. The agency arms the
-- deployment and the owner arms the practice; both must be on before one write
-- leaves this platform, and either alone stops all of them.
--
-- POST-0012 LOCKED POSTURE: RLS enabled, NO anon/authenticated grants. All
-- access is server-only through the service-role client, consistent with
-- 0026/0034/0049/0085/0090/0091/0093.

create table if not exists dentally_write_intent (
  id uuid primary key default gen_random_uuid(),

  -- The practice. Client-level, with the site kept alongside it where the caller
  -- had one: a write is made BY a module FOR a site, and the Sync Status surface
  -- is read by an owner who thinks in practices, not in sites.
  client_id text not null,
  site_id text,

  -- WHICH OF THE FIVE SUPPORTED WRITES this is. The CHECK is the thing that stops
  -- a sixth kind appearing in the tree without anybody deciding it should: there
  -- are exactly five write methods on DentallyClient, Dentally publishes no
  -- supported create route on any other resource we use, and a row that did not
  -- match one of these would be a write nobody had reviewed.
  kind text not null check (kind in (
    'patient.create',
    'patient.update',
    'appointment.create',
    'appointment.update',
    'appointment.cancel'
  )),

  -- WHICH SURFACE ASKED FOR IT (the gate's DENTALLY_WRITE_SOURCES key, e.g.
  -- 'recall', 'diary', 'booking-agent'), and the system_toggle slug that governs
  -- it. module_slug is NULLABLE and that is a decision on the record: two sources
  -- (a manager editing a patient's details, and the active/inactive switch on the
  -- record) are staff actions on a record rather than automated systems, so no
  -- kill switch exists for them and inventing one here would put a switch in the
  -- owner's control panel that nobody asked for. The gate declares the null with
  -- a written reason and a test refuses any OTHER null.
  source text not null,
  module_slug text,

  -- The Dentally records this write is about. Ids only — see the PII block above.
  dentally_patient_id text,
  dentally_appointment_id text,

  -- The HOST the write was aimed at, resolved from the same environment variables
  -- dentallyAgentClient() resolves its base URL from ('api.dentally.co', or
  -- 'localhost:3000' for the local mock). Stored rather than inferred at read
  -- time because the environment changes and a row is a statement about the
  -- moment it was written: "this went to the live practice book" and "this went
  -- to the mock" must never become the same sentence after a redeploy.
  target text not null,

  -- Ids and non-personal fields only. See the PII block above.
  payload_summary jsonb not null default '{}'::jsonb,

  -- WHAT HAPPENED.
  --   dry_run  the write RAN, and not against the live practice book — i.e. it
  --            was performed against the local mock. It means one thing only:
  --            something happened, somewhere that is not the practice's diary.
  --   queued   a write the gate WILL perform once the write key exists. NOTHING
  --            PRODUCES THIS, deliberately, and nothing replays it: not
  --            automatically, and not from a button. It exists so the transition
  --            is modelled and tested rather than invented under time pressure on
  --            the day the key arrives. A status that implied a pending delivery
  --            while nothing was ever going to deliver would be a promise this
  --            platform has not made.
  --   sent     performed against the live practice book and accepted.
  --   failed   attempted and refused by Dentally (or the request errored).
  --   blocked  refused by US before any request. This is the whole of production
  --            today: write-back is not armed, so every staff click that would
  --            have reached Dentally lands here as blocked/writes_disabled —
  --            "this is what staff tried to send while write-back was off" —
  --            rather than vanishing into a 503 nothing recorded.
  status text not null check (status in ('dry_run', 'queued', 'sent', 'failed', 'blocked')),

  -- WHY it was blocked. The two CHECKs below are a pair and they matter: a
  -- blocked row with no reason is an unexplained refusal a practice cannot act
  -- on, and a reason on a row that was not blocked is a sentence about something
  -- that did not happen. The database refuses both rather than the UI hiding them.
  --   writes_disabled       the deployment is not armed (DENTALLY_WRITE_*).
  --   master_off            the OWNER's master Dentally write-back switch is off.
  --   system_off            the switch on the module that asked is off.
  --   invalid_target        no Dentally record was named to write to.
  --   client_read_only      our own client latch refused before any request.
  --   no_supported_endpoint Dentally publishes no way to write this at all.
  blocked_reason text check (blocked_reason in (
    'writes_disabled',
    'master_off',
    'system_off',
    'invalid_target',
    'client_read_only',
    'no_supported_endpoint'
  )),
  constraint dentally_write_intent_blocked_reason_only_when_blocked
    check (blocked_reason is null or status = 'blocked'),
  constraint dentally_write_intent_blocked_needs_a_reason
    check (status <> 'blocked' or blocked_reason is not null),

  -- WHO. A user's email/id for a staff action, or the agent slug for an automated
  -- one ('agent:booking-agent'). Nullable: the public booking page has no session,
  -- and recording 'unknown' would be a claim rather than an absence.
  actor text,

  -- Dentally's own id for what the write produced (the new appointment, the new
  -- patient), when there was one.
  response_id text,

  -- The sanitised failure text. See the PII block above.
  error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The Sync Status page's read: one practice's intents, newest first.
create index if not exists idx_dentally_write_intent_client
  on dentally_write_intent (client_id, created_at desc);

-- The count strip and the status filter.
create index if not exists idx_dentally_write_intent_status
  on dentally_write_intent (client_id, status, created_at desc);

-- "What have we tried to do to THIS patient's record?" — the question a practice
-- asks when a record looks wrong. Partial, because most rows carry a patient id
-- and the ones that do not are not worth indexing.
create index if not exists idx_dentally_write_intent_patient
  on dentally_write_intent (dentally_patient_id, created_at desc)
  where dentally_patient_id is not null;

alter table dentally_write_intent enable row level security;
revoke all on dentally_write_intent from anon, authenticated;

-- ---------------------------------------------------------------------------
-- SEED THE MASTER SWITCH OFF for the pilot client — mechanism 2 of the two
-- described above, and the same shape 0041 / 0047 / 0071 / 0077 / 0085 / 0090 /
-- 0091 / 0093 use. `on conflict do nothing` is essential: re-running this
-- migration must never stamp OFF over an owner's later deliberate ON.
--
-- Applying this file therefore changes nothing about what is live. The switch it
-- seeds is off, the code default is off, and the deployment is not armed either
-- way — three independent reasons no write reaches Dentally today, of which the
-- owner now controls one.
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled, updated_by)
values ('vitality', 'dentally-write-back', false, 'migration:0096')
on conflict (client_id, module_slug) do nothing;
