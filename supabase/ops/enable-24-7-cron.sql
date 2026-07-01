-- enable-24-7-cron.sql
-- ---------------------------------------------------------------------------
-- Turns the platform's 24/7 automation fully ON.
--
-- WHY THIS IS A MANUAL STEP: writing to cron.job needs a privileged role. The
-- app's Supabase MCP connection is read-only on cron.job, so these statements
-- must be run once by hand in the Supabase dashboard SQL editor (which runs as
-- the postgres superuser).
--
-- SAFE TO RUN NOW: every message still passes through the shared messaging
-- layer with MESSAGING_DRY_RUN on, so enabling the sweeps exercises the full
-- lifecycle loop (draft -> queue -> drain -> mark sent) WITHOUT sending a single
-- real SMS/email. This proves the system runs 24/7 on mock data before any real
-- Dentally key or real sends are switched on. No CRON_SECRET appears anywhere
-- below: the secret lives inside public.trigger_app_cron(), not in the jobs.
--
-- Current state (verified 2026-07-01):
--   ACTIVE : app-drain (*/5), app-sync-{coordinator,dentally,noshow,reactivation,recall}
--   OFF    : app-sweep-{coordinator,noshow,reactivation,recall} (*/10),
--            app-sweep-speed-to-lead (* * * * *)
--   MISSING: app-sweep-rota, app-sweep-reviews
-- ---------------------------------------------------------------------------

-- 1) Turn on the five lifecycle sweeps that draft + queue proactive messages.
--    Without these the syncs pull data but the agents never act.
update cron.job set active = true where jobname like 'app-sweep-%';

-- 2) Register the Staff Rota sweep: regenerates upcoming shifts from opening
--    hours + staff availability and texts each staff member their shifts once
--    (notified_at prevents double-texting). Daily at 06:00 UTC (early morning
--    London). No secret needed: the command clones the proven helper.
select cron.schedule(
  'app-sweep-rota',
  '0 6 * * *',
  $$select public.trigger_app_cron('/api/rota/sweep')$$
);

-- 3) Register the Reviews sweep: schedules one compliant Google-review request
--    per attended patient. It NO-OPS until REVIEW_LINK_URL is set in the
--    environment, so registering it now is harmless; it comes alive the moment
--    the review link is configured. Every 15 minutes.
select cron.schedule(
  'app-sweep-reviews',
  '*/15 * * * *',
  $$select public.trigger_app_cron('/api/reviews/sweep')$$
);

-- Verify:
--   select jobname, schedule, active from cron.job order by jobname;
-- Expected after running: every app-sweep-* row active = true, plus the two new
-- rows present. Watch a couple of cycles in cron.job_run_details:
--   select jobname, status, return_message, start_time
--   from cron.job_run_details order by start_time desc limit 20;
