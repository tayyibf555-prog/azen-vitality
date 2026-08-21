-- register-anomaly-cron.sql  —  register the proactive anomaly pass on pg_cron
-- ---------------------------------------------------------------------------
-- STATUS: NOT YET APPLIED, and deliberately not registered by this build. Run it
-- once when the module is wanted (Fable applies cron SQL; the app's Supabase role
-- is read-only on the cron.job TABLE, so use the cron.* FUNCTIONS, which are
-- SECURITY DEFINER — the same method as supabase/ops/enable-24-7-cron.sql).
--
-- WHAT IT RUNS: /api/anomaly/sweep, which LOOKS and WRITES ONE TABLE.
--   It reads the dashboard's own assembled takings strip, the no-show risk
--   table, the speed-to-lead uncontacted-enquiry query, and bounded counts over
--   the per-module approval and outbox tables. It then writes rows to
--   anomaly_alert and nothing else. No patient record, no diary, no cadence, no
--   touch, no outbox, no message. There is no path from this job to a patient.
--
-- CADENCE: HOURLY, at minute 40.
--   Hourly rather than daily because two of the four conditions are perishable:
--   an enquiry uncontacted for an hour and a cluster of no-show risks in
--   TOMORROW's diary are both worth knowing about the same working day, and a
--   once-a-morning job would routinely be eleven hours late on them. Hourly
--   rather than */10 because none of them are perishable by the minute, and the
--   takings read goes through the shared dashboard cache which is only worth
--   waking once an hour anyway.
--
--   The dedupe key is what makes an hourly job quiet rather than deafening: a
--   condition that persists is REFRESHED, not re-raised, so a takings dip that
--   lasts a fortnight is one row on the owner's feed for a fortnight, not 336.
--
-- MINUTE 40 deliberately: the lifecycle sweeps run on */10 (minutes 0, 10, 20,
-- 30...), post-op takes :25 and the Meta insights pull takes the top of the hour,
-- so :40 lands this job in a gap rather than alongside the Dentally readers.
--
-- DENTALLY COST: one dashboard read per hour, at BACKGROUND priority
-- (runWithDentallyPriority in src/lib/anomaly/collect.ts), and usually a cache
-- hit rather than a scan. A refusal from the shared budget guard is not an error
-- here: it produces an unavailable takings cell, the detector refuses, and the
-- run reports the refusal in its `refused` array rather than inventing a figure.
--
-- SAFE TO REGISTER BEFORE THE SYSTEM IS SWITCHED ON. 'anomaly-alerts' is
-- DEFAULT-OFF in the systems catalog, so until an owner deliberately enables it
-- every run returns {"ok":true,"skipped":"system off"} having made no read of
-- any kind — the switch is checked before the lease is even taken.
--
-- CRON_SECRET is NOT written here; it lives inside public.trigger_app_cron(),
-- exactly as the other jobs rely on.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'app-sweep-anomaly',
  '40 * * * *',
  $$select public.trigger_app_cron('/api/anomaly/sweep')$$
);

-- cron.schedule() on an existing job named 'app-sweep-anomaly' updates its
-- schedule/command but KEEPS the current active flag. If it was ever created
-- inactive, activate it explicitly (find the id in cron.job first):
--   select cron.alter_job(job_id := (select jobid from cron.job
--                                    where jobname = 'app-sweep-anomaly'),
--                         active := true);

-- Verify after applying:
--   select jobname, schedule, active from cron.job where jobname = 'app-sweep-anomaly';
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--     where jobname = 'app-sweep-anomaly'
--     order by start_time desc limit 5;
--
-- A healthy run with the system OFF returns HTTP 200 and
-- {"ok":true,"skipped":"system off"} — that is the correct shipping state.
-- With it ON, the body carries {detected, raised, refreshed, held, resolved,
-- refused}. Read `refused` first: it names every reading the pass could not
-- prove, and a run with detected:0 and a long `refused` list is a blind pass,
-- not a quiet practice.

-- TO REMOVE:
--   select cron.unschedule('app-sweep-anomaly');
