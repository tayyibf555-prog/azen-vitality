-- Exact per-site patient counts, refreshed by a nightly scan (Dentally's index
-- meta.total gives the whole book but ignores active/archived filters, so the
-- active number has to be counted by paging the book once a day off-hours).
create table if not exists patient_count (
  site_id text primary key,
  total integer not null,
  active integer not null,
  counted_at timestamptz not null default now()
);

-- Service-role only, matching the platform's locked posture (0012/0019):
-- RLS on with no policies; the app reads/writes via the service client.
alter table patient_count enable row level security;
