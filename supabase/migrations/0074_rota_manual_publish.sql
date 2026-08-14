-- 0074_rota_manual_publish.sql
-- Manual rota editing, nurse/dentist pairing, and a PUBLISHED version of the week.
--
-- ---------------------------------------------------------------------------
-- WHY THIS MIGRATION EXISTS: THE GENERATOR WAS FIGHTING THE MANAGER, SILENTLY.
-- ---------------------------------------------------------------------------
-- Before this, a rota shift was a row the generator owned outright. There was no
-- way to record that a HUMAN decided something, so:
--
--   * a manually moved shift was indistinguishable from a generated one, and the
--     next generation (which runs on every page load AND every sweep tick, 24/7)
--     re-derived the slot from the config and put it back;
--   * a manually deleted shift was simply an ABSENT ROW, which is exactly what an
--     ungenerated slot looks like, so the next run re-created it.
--
-- Neither failure produced an error. The manager's edit just quietly undid itself,
-- which is the worst shape a bug can take on a rota: the practice believes the
-- screen and staffs the day wrong. Three columns close it and all three are needed:
--
--   origin      'manual' marks a row a person decided. generateShifts is given the
--               stored rows as pure input and treats a manual row as coverage that
--               is already met, so it never writes a second person into the slot.
--   status      gains 'removed' -- a TOMBSTONE. A deletion has to leave something
--               behind, or "deleted" and "never existed" are the same state and the
--               generator cannot tell them apart.
--   paired_staff_id  the nurse's dentist (and vice versa), which the generator has
--               never modelled: it fills each role independently, so who works with
--               whom was not a fact the system held at all.
--
-- ---------------------------------------------------------------------------
-- AND WHY rota_publication IS A SNAPSHOT AND NOT A SUMMARY.
-- ---------------------------------------------------------------------------
-- Publishing a rota is the moment the practice TELLS people when they are working.
-- If a shift is later moved, the question a dispute turns on is not "what does the
-- rota say now" but "what was this person told, and when". A count cannot answer
-- that; the rows themselves can. So each publication carries an IMMUTABLE jsonb
-- snapshot of exactly the shifts that were published, and the next version diffs
-- against it. Same reasoning as 0068_staff_clock.sql (store the taps, not the
-- conclusion) and 0066_perio.sql (the record of what was recorded beats a tidy
-- summary of it).
--
-- Created in the POST-0012 locked posture: RLS enabled, NO grants/policies to
-- anon/authenticated, `revoke all` for good measure. All access is server-only via
-- the service-role client, consistent with 0030/0031 (rota), 0067, 0068 and 0071.
--
-- NOT APPLIED BY THIS BUILDER. Written only; the orchestrator applies it.
--
-- British English throughout. No NHS vs private framing. No dash characters in copy.

-- ---------------------------------------------------------------------------
-- 1) The shift columns.
-- ---------------------------------------------------------------------------
alter table rota_shift
  add column if not exists origin text not null default 'generated',
  add column if not exists paired_staff_id uuid,
  add column if not exists note text,
  add column if not exists published_at timestamptz,
  add column if not exists published_version int;

-- 'generated' is the default so every existing row keeps its exact current meaning:
-- nobody has edited anything yet, and this migration changes no behaviour on its own.
alter table rota_shift drop constraint if exists rota_shift_origin_check;
alter table rota_shift add constraint rota_shift_origin_check
  check (origin in ('generated', 'manual'));

-- ---------------------------------------------------------------------------
-- 2) The tombstone status.
--
-- 'cancelled' already existed and means something DIFFERENT, which is why this is a
-- fourth value rather than a reuse: updateStaff() cancels the future shifts of a
-- deactivated staff member precisely so the slot is FREED and somebody else is
-- generated into it. 'removed' is the opposite instruction -- a person decided this
-- shift should not happen, and the slot must stay empty until a person says
-- otherwise. Collapsing the two would make every manual deletion self-heal into a
-- replacement, which is the bug this migration exists to kill.
-- ---------------------------------------------------------------------------
alter table rota_shift drop constraint if exists rota_shift_status_check;
alter table rota_shift add constraint rota_shift_status_check
  check (status in ('scheduled', 'notified', 'cancelled', 'removed'));

-- ---------------------------------------------------------------------------
-- 3) The pairing FK, COMPOSITE -- the 0031 lesson, again.
--
-- A bare `paired_staff_id references rota_staff (id)` is not tenant-scoped: a shift
-- could name another practice's nurse while carrying our own client_id, and the
-- schema would not object. The composite (client_id, paired_staff_id) makes the
-- tenant boundary a schema guarantee, targeting rota_staff_client_id_id_key
-- (0031_rota_tenant_hardening.sql:19).
--
-- MATCH SIMPLE (the default) is what we want here: when paired_staff_id is null the
-- constraint is simply not checked, so an unpaired shift is legal. That is the
-- normal state -- most shifts have no partner, and "leave it unpaired rather than
-- invent a pairing" is the rule the pure module follows.
--
-- ON DELETE SET NULL, not cascade: removing a nurse from the practice must unpair
-- the dentist's shift, never delete the dentist's shift.
-- ---------------------------------------------------------------------------
alter table rota_shift drop constraint if exists rota_shift_pair_fkey;
alter table rota_shift add constraint rota_shift_pair_fkey
  foreign key (client_id, paired_staff_id) references rota_staff (client_id, id)
  on delete set null;

-- Nobody is their own nurse. Cheap, and it stops a whole class of confusing UI.
alter table rota_shift drop constraint if exists rota_shift_pair_not_self;
alter table rota_shift add constraint rota_shift_pair_not_self
  check (paired_staff_id is null or paired_staff_id <> staff_id);

-- The read route pages a week at a time and the generator asks for the same window,
-- both filtered by status. The existing idx_rota_shift_client_date covers the range;
-- this one lets the "what is still live here" scan skip the tombstones.
create index if not exists idx_rota_shift_client_date_status
  on rota_shift (client_id, shift_date, status);

-- ---------------------------------------------------------------------------
-- 4) The publication log.
--
-- One row per (client, site, week, version). site_id is nullable and means "every
-- site": a single-site practice, or a manager publishing the whole group at once.
-- It is part of the unique key, so publishing site A and then site B for the same
-- week produces two independent version streams rather than one that interleaves.
-- ---------------------------------------------------------------------------
create table if not exists rota_publication (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text,
  -- The Monday of the published week, as a London calendar day.
  week_start date not null,
  version int not null check (version >= 1),
  published_by uuid references app_user (id) on delete set null,
  published_at timestamptz not null default now(),
  shift_count int not null default 0,
  -- THE EVIDENCE ARTEFACT. Exactly the shifts that were published, in a stable
  -- order, as they stood at that moment. Never updated after insert.
  snapshot jsonb not null,
  -- How many staff were actually TEXTED or EMAILED as a result of this publish...
  notified_count int not null default 0,
  -- ...and how many would have been, but were simulated because MESSAGING_DRY_RUN
  -- is on. Kept separate and honest: a dry run must never be recorded as a send, or
  -- the first real publish would look like a repeat and the practice would believe
  -- staff had already been told.
  simulated_count int not null default 0,
  unique (client_id, site_id, week_start, version)
);

-- "What is the latest version of this week" is the only read that matters, and it
-- runs on every rota page load.
create index if not exists idx_rota_publication_client_week
  on rota_publication (client_id, week_start, version desc);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0030 /
-- 0067 / 0068 / 0071).
alter table rota_publication enable row level security;
revoke all on rota_publication from anon, authenticated;

-- NO SEED. Running this migration publishes nothing, edits nothing and texts nobody.
-- Every existing shift stays 'generated' and unpublished, which is exactly what it
-- was before. The first publication is an act a practice manager performs on purpose.
