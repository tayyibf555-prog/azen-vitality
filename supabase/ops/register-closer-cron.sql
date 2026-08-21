-- register-closer-cron.sql  —  register the treatment-plan CLOSER sweep on pg_cron
-- ---------------------------------------------------------------------------
-- STATUS: NOT APPLIED, AND DELIBERATELY SO. Do not run this until the closer has
-- an approval surface and the practice has agreed to switch it on.
--
-- Fable applies cron SQL; the app's Supabase role is read-only on the cron.job
-- TABLE ("permission denied for table job"), so use the cron.* FUNCTIONS, which
-- are SECURITY DEFINER. Same method as supabase/ops/enable-24-7-cron.sql.
--
-- WHAT THIS JOB DOES, AND WHAT IT CANNOT DO
-- The sweep DRAFTS follow-ups on treatment plans that were planned and never
-- completed, and stores them in closer_touch with status 'draft'. It writes
-- NOTHING to closer_outbox. The shared messaging drain lists only closer_outbox
-- rows with status 'queued', so registering this job cannot, on its own, cause a
-- single message to be sent to a single patient. The only path from a draft to a
-- send is a human approving it.
--
-- IT IS ALSO GATED TWICE BEFORE IT DOES ANYTHING AT ALL
--   1. Code: 'treatment-closer' is declared defaultEnabled:false in
--      src/lib/systems/catalog.ts, so the ABSENCE of a system_toggle row means
--      DISABLED, for every client, in every environment.
--   2. Data: migration 0085 seeds an explicit `enabled = false` row for
--      'vitality'.
-- With either gate closed the route returns {"ok":true,"skipped":"system off"}
-- immediately, having read nothing and drafted nothing. That is the expected and
-- correct result of running this job today.
--
-- CADENCE: hourly, not */10. The closer's own schedule is measured in DAYS (its
-- first touch waits for a plan to be at least 21 days old, then 7 and 14 days
-- between steps), so a ten-minute tick would buy nothing and would re-read the
-- whole open-opportunity set 144 times a day for work that changes daily. Hourly
-- keeps the drafts fresh enough for a morning worklist and keeps the read load
-- proportionate to the decision it is making.
--
-- WHY :17 PAST. Offset from the top of the hour so this sweep does not contend
-- with the hourly Dentally syncs, which do carry a real quota cost.
--
-- CRON_SECRET is NOT written here; it lives inside public.trigger_app_cron(),
-- exactly as the other jobs rely on.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'app-sweep-closer',
  '17 * * * *',
  $$select public.trigger_app_cron('/api/closer/sweep')$$
);

-- cron.schedule() on an existing job named 'app-sweep-closer' updates its
-- schedule/command but KEEPS the current active flag. To create it PAUSED (the
-- safer option while the approval surface is still being built), run the schedule
-- above and then immediately deactivate it:
--   select cron.alter_job(job_id := (select jobid from cron.job
--                                    where jobname = 'app-sweep-closer'),
--                         active := false);
-- and activate it the same way when the practice is ready.

-- Verify after applying:
--   select jobname, schedule, active from cron.job where jobname = 'app-sweep-closer';
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--     where jobname = 'app-sweep-closer'
--     order by start_time desc limit 5;
--
-- A healthy run with the switch OFF returns HTTP 200 and
--   {"ok":true,"skipped":"system off"}
-- A healthy run with the switch ON returns HTTP 200 and a summary of the form
--   {"ok":true,"examined":N,"drafted":N,"stopped":N,"skipped":N,"refused":N,
--    "queued":0, ...}
-- "queued" is always 0 by construction. If it is ever anything else, the sweep has
-- grown a send path it must not have.

-- TO UNREGISTER:
--   select cron.unschedule('app-sweep-closer');
