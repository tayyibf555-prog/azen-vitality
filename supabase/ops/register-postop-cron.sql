-- register-postop-cron.sql  —  register the post-op check-in sweep on pg_cron
-- ---------------------------------------------------------------------------
-- STATUS: NOT YET APPLIED. Run this once (Fable applies cron SQL; the app's
-- Supabase role is read-only on the cron.job TABLE, so use the cron.* FUNCTIONS,
-- which are SECURITY DEFINER — same method as supabase/ops/enable-24-7-cron.sql).
--
-- WHAT IT RUNS: /api/postop/sweep, which does two things and sends nothing.
--   PASS 1  reads the last two days of appointments, keeps the ones whose state
--           says the patient turned up AND whose free text says a procedure
--           happened (extraction / implant / surgical), and records each ONE time.
--   PASS 2  for every recorded procedure now due, composes the fixed check-in and
--           stores it as a DRAFT for a human to release.
-- Nothing this job produces can be delivered: the route writes postop_touch and
-- never postop_outbox, and the shared drain lists only postop_outbox rows with
-- status 'queued'. A human approving the draft is the only thing that queues one.
--
-- CADENCE: HOURLY, not */10. This is the one lifecycle sweep where a tighter
-- schedule buys nothing. The check-in is due roughly twenty hours after the
-- procedure and is then clamped into 08:00–20:00 Europe/London, so the earliest a
-- ten-minute tick could beat an hourly one by is a few minutes on a message a
-- human still has to release. Against that, pass 1 costs one appointment page per
-- site plus one patient read per flagged procedure, all on the practice's shared
-- 3,600/hour Dentally budget at BACKGROUND priority. Hourly keeps that cost at a
-- sixth of what */10 would spend for no clinical benefit.
--
-- MINUTE 25 deliberately: the existing lifecycle sweeps run on */10 (minutes 0,
-- 10, 20, 30…), so :25 lands this job in a gap rather than alongside five other
-- Dentally readers.
--
-- SAFE TO REGISTER BEFORE THE SYSTEM IS SWITCHED ON. 'postop-checkin' is
-- DEFAULT-OFF in the systems catalog, so until an owner deliberately enables it
-- every run returns {"ok":true,"skipped":"system off"} and makes no Dentally read
-- at all. Registering the job early is what makes the switch-on a one-click
-- decision rather than a deployment.
--
-- CRON_SECRET is NOT written here; it lives inside public.trigger_app_cron(),
-- exactly as the other jobs rely on.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'app-sweep-postop',
  '25 * * * *',
  $$select public.trigger_app_cron('/api/postop/sweep')$$
);

-- cron.schedule() on an existing job named 'app-sweep-postop' updates its
-- schedule/command but KEEPS the current active flag. If it was ever created
-- inactive, activate it explicitly (find the id in cron.job first):
--   select cron.alter_job(job_id := (select jobid from cron.job
--                                    where jobname = 'app-sweep-postop'),
--                         active := true);

-- Verify after applying:
--   select jobname, schedule, active from cron.job where jobname = 'app-sweep-postop';
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--     where jobname = 'app-sweep-postop'
--     order by start_time desc limit 5;
--
-- A healthy run with the system OFF returns HTTP 200 and {"ok":true,"skipped":
-- "system off"} — that is the correct shipping state. With it ON, the body carries
-- {examined, flagged, flagCounts, drafted, waiting, stopped, refused, queued:0}.
-- `queued` is always 0 and always will be: this route has no path to the outbox.
--
-- THERE IS NO SEPARATE DRAIN JOB TO ADD. The post-op outbox is registered as a
-- source in the shared /api/messaging/drain (already on pg_cron), and its quiet
-- hours live on the row (postop_outbox.not_before_at), so nothing about this
-- module needs a second schedule.
