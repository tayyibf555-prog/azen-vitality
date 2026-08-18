-- register-dentally-prewarm-cron.sql  —  register the Dentally display-cache
-- pre-warm on pg_cron
-- ---------------------------------------------------------------------------
-- STATUS: NOT YET APPLIED. Run this once (Fable applies cron SQL; the app's
-- Supabase role is read-only on the cron.job TABLE, so use the cron.* FUNCTIONS,
-- which are SECURITY DEFINER — same method as supabase/ops/enable-24-7-cron.sql
-- and register-outreach-cron.sql).
--
-- WHY: the L2 display cache (dentally_display_cache, migration 0084) plus
-- stale-while-revalidate mean no user waits ONCE a row exists — but the FIRST read
-- after a row is gone (a brand-new deploy, a quiet overnight, an invalidation) still
-- pays the full ~40s cold scan. This job keeps a warm row present at all times for
-- every LIVE client, so even that first read is a warm read. It recomputes the two
-- heavy DISPLAY reads — the practice dashboard (six 90-day scans) and the outstanding
-- book — and stamps them into L2 with a 20-minute ttl (see PREWARM_TTL_MS in the
-- route), which OUTLIVES this schedule so the pre-warmed rows stay FRESH between runs.
-- It is idempotent and self-locking (cron_lock lease "dentally-prewarm"): overlapping
-- ticks skip rather than double the Dentally load.
--
-- CADENCE: */15. This is the ONLY path that pays the full scan on live Dentally now
-- (user reads are served from L2), and it runs on ONE cron instance, so it does not
-- fan out across the fleet the way the uncoordinated cold navigations did that caused
-- the July rate-limit incident. Worst case is one full assembly per live client per
-- run — far less in practice, because every page walk stops early on a short page —
-- which at */15 sits comfortably inside the 3,600/hour Dentally budget for the single
-- live client, leaving headroom for the lifecycle sweeps and hourly syncs. The ttl
-- (20 min) is deliberately > the interval (15 min) + a slack for a slow/lock-skipped
-- run. IF a SECOND live client is onboarded, or 429s appear in cron.job_run_details,
-- widen to '*/20' or '*/30' here AND raise PREWARM_TTL_MS in the route in lockstep so
-- the ttl still outlives the interval. CRON_SECRET is NOT written here; it lives
-- inside public.trigger_app_cron(), exactly as the other jobs rely on.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'app-prewarm-dentally',
  '*/15 * * * *',
  $$select public.trigger_app_cron('/api/dentally/prewarm')$$
);

-- cron.schedule() on an existing job named 'app-prewarm-dentally' updates its
-- schedule/command but KEEPS the current active flag. If it was ever created
-- inactive, activate it explicitly (find the id in cron.job first):
--   select cron.alter_job(job_id := (select jobid from cron.job
--                                    where jobname = 'app-prewarm-dentally'),
--                         active := true);

-- Verify after applying:
--   select jobname, schedule, active from cron.job where jobname = 'app-prewarm-dentally';
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--     where jobname = 'app-prewarm-dentally'
--     order by start_time desc limit 5;
-- A healthy run returns HTTP 200 with a JSON body: {"ok":true,"ttlMs":1200000,
-- "warmed":[{"clientId":"vitality","dashboard":"fulfilled","outstanding":"fulfilled"}]}.
-- "skipped":"another run in progress" is also healthy — the previous tick was still
-- warming when this one fired.
