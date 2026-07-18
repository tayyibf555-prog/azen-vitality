-- register-meta-insights-cron.sql  —  register the Meta insights sweep on pg_cron
-- ---------------------------------------------------------------------------
-- STATUS: NOT YET APPLIED. This is an ACTIVATION-DAY step. Run it once (Fable
-- applies cron SQL; the app's Supabase role is read-only on the cron.job TABLE,
-- so use the cron.* FUNCTIONS, which are SECURITY DEFINER — same method as
-- supabase/ops/register-outreach-cron.sql and enable-24-7-cron.sql).
--
-- WHY: /api/meta-ads/insights pulls the latest lifetime figures (spend,
-- impressions, clicks, leads) for every PUBLISHED Meta campaign into
-- meta_campaign_insight, so the dashboard's awaiting-data section lights up with
-- real numbers. It is READ-ONLY (no spend, no send, no patient contact) and is
-- gated ONLY on the Meta connection: while the client's Meta account is not
-- connected the route is an honest no-op, so registering this job early is safe —
-- it simply returns {"skipped":"meta_not_connected"} until the account links.
--
-- CADENCE: hourly (0 * * * *). Insights do not change minute to minute, and Meta
-- rate-limits the Insights endpoint, so hourly is the right resolution. The route
-- takes a cron lease (sweep-meta-insights) so overlapping ticks never double-write.
-- CRON_SECRET is NOT written here; it lives inside public.trigger_app_cron(),
-- exactly as the other jobs rely on.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'app-sweep-meta-insights',
  '0 * * * *',
  $$select public.trigger_app_cron('/api/meta-ads/insights')$$
);

-- cron.schedule() on an existing job named 'app-sweep-meta-insights' updates its
-- schedule/command but KEEPS the current active flag. If it was ever created
-- inactive, activate it explicitly (find the id in cron.job first):
--   select cron.alter_job(job_id := (select jobid from cron.job
--                                    where jobname = 'app-sweep-meta-insights'),
--                         active := true);

-- Verify after applying:
--   select jobname, schedule, active from cron.job where jobname = 'app-sweep-meta-insights';
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--     where jobname = 'app-sweep-meta-insights'
--     order by start_time desc limit 5;
-- Before the Meta account connects, a healthy run returns HTTP 200 with body
-- {"ok":true,"connected":false,"skipped":"meta_not_connected","captured":0} — that
-- is correct: the job is registered and idle until Meta connects.
