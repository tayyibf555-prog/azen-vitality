-- Owner-set reactivation daily contact limit: at most this many dormant patients
-- are messaged automatically per Europe/London day, so a large enrolled cohort can
-- never blast out an unbounded burst of texts. Absence of a row = the code default
-- (25/day), so shipping this changes behavior only when an owner sets a value.

create table if not exists reactivation_settings (
  client_id           text        primary key,
  daily_contact_limit integer     not null,
  updated_at          timestamptz not null default now()
);

-- Server-only, matching the app's other tables (migration 0012): RLS on, no
-- policies, so only the service role can read/write via guarded server routes.
alter table reactivation_settings enable row level security;
