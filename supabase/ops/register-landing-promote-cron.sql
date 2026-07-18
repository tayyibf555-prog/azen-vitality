-- register-landing-promote-cron.sql  —  register the landing-page split-test
-- auto-promotion sweep on pg_cron
-- ---------------------------------------------------------------------------
-- STATUS: NOT YET APPLIED. Run this once (Fable applies cron SQL; the app's
-- Supabase role is read-only on the cron.job TABLE, so use the cron.* FUNCTIONS,
-- which are SECURITY DEFINER — same method as supabase/ops/enable-24-7-cron.sql
-- and register-outreach-cron.sql).
--
-- WHY: landing-page auto-promotion used to fire ONLY when an owner opened the
-- split-test results card (GET /api/funnel-event/summary). With auto-promote on
-- but nobody viewing, a settled winner was never promoted. This job runs the
-- IDENTICAL decision (the shared maybeAutoPromote / decideAutoPromotion) on a
-- schedule, so promotion no longer depends on anyone viewing the card. It is
-- idempotent: pages that already have a winner are skipped, so extra runs are safe.
--
-- CADENCE: daily. A split test needs a fair sample (>=100 views per variant) before
-- the decision promotes anything, so it moves on the scale of days, not minutes — a
-- daily pass is ample and keeps this well clear of the */10 lifecycle sweeps.
-- CRON_SECRET is NOT written here; it lives inside public.trigger_app_cron(),
-- exactly as the other jobs rely on.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'app-sweep-landing-promote',
  '17 3 * * *',
  $$select public.trigger_app_cron('/api/landing-pages/promote-sweep')$$
);

-- cron.schedule() on an existing job named 'app-sweep-landing-promote' updates its
-- schedule/command but KEEPS the current active flag. If it was ever created
-- inactive, activate it explicitly (find the id in cron.job first):
--   select cron.alter_job(job_id := (select jobid from cron.job
--                                    where jobname = 'app-sweep-landing-promote'),
--                         active := true);

-- Verify after applying:
--   select jobname, schedule, active from cron.job where jobname = 'app-sweep-landing-promote';
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--     where jobname = 'app-sweep-landing-promote'
--     order by start_time desc limit 5;
-- A healthy run returns HTTP 200 with a JSON body: {"ok":true,"scanned":N,
-- "promoted":M,"results":[...]}. scanned is the number of eligible LIVE pages, and
-- promoted is how many had a settled winner this run (usually 0 until a test settles).
