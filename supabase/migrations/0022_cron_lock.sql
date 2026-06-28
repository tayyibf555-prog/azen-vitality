-- 0022_cron_lock.sql
-- A tiny lease-lock table so a cron job (the messaging drain, the sweeps) never
-- runs concurrently with itself. pg_cron can overlap a slow run with the next
-- tick, or double-fire; without a lock two drains list the same 'queued' rows and
-- BOTH send, double-texting the patient. An advisory lock is unreliable through a
-- pooled (pgbouncer) connection, so we use a row lease instead: a single atomic
-- conditional UPDATE (`... WHERE locked_until < now()`) that exactly one caller
-- can win. The lease auto-expires, so a crashed run never deadlocks the job.
--
-- Post-0012 locked posture: RLS on, no grants; service-role only.

create table if not exists cron_lock (
  name text primary key,
  locked_until timestamptz not null default to_timestamp(0)
);

alter table cron_lock enable row level security;
