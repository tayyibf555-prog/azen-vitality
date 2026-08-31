-- 0095_patient_recent_view.sql
-- Recently-accessed patients: the one table this feature owns.
--
-- ===========================================================================
-- WHAT IT IS. The practice owner, on the 27 Aug call, about Dentally's own
-- recents tab: "that is a really useful tab... we'll get that in". This is that
-- tab. A strip above the patients list showing the last handful of patients THIS
-- USER opened, so returning to the record you were on two minutes ago is one
-- click rather than a name typed into a search box for the fourth time.
--
-- ===========================================================================
-- WHY A TABLE AND NOT A COOKIE, WHICH WAS THE OBVIOUS CHEAP ANSWER.
--
-- A recents list is small, per-person and disposable, which is the exact shape a
-- cookie is for. It is still the wrong store here, for three reasons and the
-- first one is disqualifying on its own:
--
--   1. A COOKIE IS PER-BROWSER, NOT PER-USER. The reception desk at N15 is a
--      SHARED WORKSTATION: a coordinator signs in, opens six patients, signs
--      out, and the next person to sign in on that machine inherits the cookie.
--      A list of patient names IS patient data. Recents in a cookie is a patient
--      data leak across logins, on the one machine in the practice most likely
--      to be used by several people in a day.
--   2. A COOKIE DOES NOT FOLLOW A USER. The same person on the surgery machine,
--      or at home on the laptop, starts with an empty list, which is precisely
--      when a "where was I" list is most wanted.
--   3. THE ROW IS TINY AND THE HOUSE ALREADY HAS THIS PATTERN. One narrow row
--      per (user, client, patient), server-owned, service-role only — the same
--      shape as patient_note (0064) and patient_status_override (0049). There is
--      no new mechanism to design, review or get wrong.
--
-- ===========================================================================
-- NO KILL SWITCH, AND NO CATALOG ENTRY. THIS IS A DECISION, NOT AN OVERSIGHT.
--
-- Every module that SENDS something carries a `system_toggle` row and a
-- src/lib/systems/catalog.ts entry, because an owner flipping it off has to stop
-- something leaving the building. This feature has no outbound behaviour at all:
-- nothing here reaches a patient, no sweep reads it, no agent consults it. It is
-- a record-keeping primitive, exactly as src/app/api/patient-notes/route.ts
-- argues for notes, and a gate over it would only ever be able to break a
-- navigation shortcut. If recents ever gains an outbound behaviour, that
-- behaviour gets the gate — not this table.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client, consistent with
-- 0026/0034/0049/0085/0090/0091/0093.

-- ---------------------------------------------------------------------------
-- One row per (USER, CLIENT, PATIENT) — never one row per opening.
--
-- THE UNIQUE CONSTRAINT IS THE DEDUPE, and it is the whole design. An access log
-- (one row per open) would be the naive shape and it is wrong twice over: a
-- coordinator who tabs between two patients all morning would push everyone else
-- out of an eight-slot list with the same two names, and the table would grow
-- without bound for a list that only ever shows eight rows.
--
-- So the write is an UPSERT on this constraint: re-opening a patient MOVES them
-- to the top by bumping viewed_at, rather than adding a duplicate. The row count
-- is therefore bounded by the number of DISTINCT patients a user has ever opened,
-- and the read is "newest eight" with no grouping.
--
-- The constraint carries client_id as well as user_id even though a user belongs
-- to one client: an agency_admin spans clients (see AuthedUser.clientId being
-- nullable in src/lib/auth/session.ts), and their recents at one practice must
-- not surface while they are looking at another.
--
-- The dedupe is ALSO re-applied in pure, tested code at read time
-- (src/lib/patient-recents/cap.ts). That is not redundancy for its own sake: a
-- display rule that decides which patient names appear on screen must be provable
-- without a database, and a constraint in a migration file is not a test.
-- ---------------------------------------------------------------------------
create table if not exists patient_recent_view (
  id uuid primary key default gen_random_uuid(),

  -- The practice. Scopes the list, and keeps an agency_admin's two practices apart.
  client_id text not null,

  -- WHOSE list this is. app_user.id, the same id patient_note.author_id carries.
  -- No foreign key, matching every other table in this schema: app_user rows are
  -- provisioned outside migrations and a cascade on a deprovisioned member of
  -- staff would be a silent delete of nothing anyone would miss anyway.
  --
  -- There is no such thing as an unattributed row here. When no user can be
  -- resolved (the un-enforced pilot), the writer records NOTHING rather than
  -- filing the opening under a placeholder id — a shared "anonymous" bucket would
  -- pool every user's recents into one list and reintroduce, in the database, the
  -- exact cross-user leak the cookie was rejected for.
  user_id uuid not null,

  -- The patient, by Dentally's id. Text, like every other dentally_patient_id in
  -- this schema.
  dentally_patient_id text not null,

  -- The name AS IT READ WHEN IT WAS OPENED, denormalised on purpose.
  --
  -- Dentally is the system of record for a patient's name and this platform holds
  -- a read-only key, so the alternative is a Dentally fetch per strip entry —
  -- eight live API calls to paint a navigation convenience above a list that has
  -- already spent its budget fetching the list itself. A name that has since been
  -- corrected shows the old spelling on the strip until the record is next opened,
  -- and the record page it links to shows the live one. For a "where was I" list
  -- that is the right trade; for anything clinical it would not be.
  patient_name text not null,

  -- The site the patient was read at. The strip filters on it so that a user
  -- scoped by the site switcher to one site is not offered a name from another —
  -- which would both leak a name outside the current selection and produce a dead
  -- link, since the record shell 404s a patient outside scope.
  site_id text not null,

  -- The last time this user opened this patient. What the list sorts on, and the
  -- only column an upsert moves.
  viewed_at timestamptz not null default now(),

  -- One row per patient per user per practice. THIS CONSTRAINT IS THE DEDUPE:
  -- see the block above. Named so the upsert can quote it as its conflict target.
  constraint patient_recent_view_unique unique (user_id, client_id, dentally_patient_id)
);

-- The one read this table has: this user's list, at this practice, newest first.
-- Column order matches the query's shape (two equalities then the sort), so the
-- index answers it outright rather than sorting a filtered set.
create index if not exists idx_patient_recent_view_read
  on patient_recent_view (user_id, client_id, viewed_at desc);

alter table patient_recent_view enable row level security;
revoke all on patient_recent_view from anon, authenticated;
