-- purge-assessment-step-events.sql  —  register the step-drop-off telemetry
-- retention purge on pg_cron
-- ---------------------------------------------------------------------------
-- STATUS: NOT YET APPLIED, and it cannot be applied before its table exists.
-- Migration 0080_assessment_step_events.sql is itself still a FILE (see its
-- header); apply that first, then run this once. Same method as every other file
-- in supabase/ops: the app's Supabase role is read-only on the cron.job TABLE, so
-- use the cron.* FUNCTIONS, which are SECURITY DEFINER.
--
-- WHY THIS EXISTS AT ALL. assessment_step_event is the only table in the schema an
-- ANONYMOUS stranger can put rows in (the public beacon endpoint,
-- /api/smile-assessment/step-event). The app already bounds the RATE — a
-- per-campaign daily budget of 5,000 posts of up to 24 rows — so growth is capped
-- at a number somebody can reason about rather than at "however long an attacker
-- keeps posting". That is a ceiling on the slope, not on the total: without a
-- floor the table still only ever gets bigger. This is the floor.
--
-- WHY 180 DAYS. The question this data answers is "which screen of THIS funnel
-- loses people". Six months keeps a season-over-season comparison of the same
-- funnel intact (a campaign an owner ran last spring is still there to compare
-- against this spring's rewrite) and drops the rest. A drop-off chart older than
-- that is describing a funnel version nobody is running any more — flow_version
-- bumps on every save — and the submissions those sessions produced are kept
-- separately and permanently in smile_assessment_response, which is the record
-- with a patient's name on it. Nothing a practice is required to keep lives here:
-- every column is an id, a small integer or an opaque per-session nonce, and the
-- table cannot be joined to a person by anything stored in it.
--
-- WHY THIS IS SQL AND NOT A SWEEP ROUTE. Every other scheduled job in this
-- platform is an app endpoint driven by public.trigger_app_cron(), because every
-- other job makes a DECISION — who to text, which lead to retire, whether a split
-- test has settled. A retention purge makes no decision: it is one predicate on
-- one column. Putting it in the database is one moving part instead of three (no
-- route, no auth, no serverless timeout to page around), and it is the one place
-- the delete cannot half-run because a function timed out mid-scan.
--
-- CADENCE: daily, off-peak, and off the minute of every other job in the runbook.
-- A day's drift on a 180-day window is not a fact anybody can observe.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'app-purge-assessment-step-events',
  '43 4 * * *',
  $$delete from public.assessment_step_event
     where created_at < now() - interval '180 days'$$
);

-- cron.schedule() on an existing job of this name updates its schedule/command but
-- KEEPS the current active flag. If it was ever created inactive, activate it
-- explicitly:
--   select cron.alter_job(job_id := (select jobid from cron.job
--                                    where jobname = 'app-purge-assessment-step-events'),
--                         active := true);

-- IF THE FIRST RUN IS EVER SLOW (only possible if this is registered long after
-- the beacon goes live, so the first pass has months of backlog to clear in one
-- statement): run it in per-practice slices instead, which is what the table's
-- SECOND index — idx_assessment_step_event_client_created (client_id, created_at)
-- — is carried for. The steady-state daily delete is small enough not to need it.
--   do $$
--   declare c text;
--   begin
--     for c in select distinct client_id from public.assessment_step_event loop
--       delete from public.assessment_step_event
--        where client_id = c and created_at < now() - interval '180 days';
--       commit;
--     end loop;
--   end $$;

-- Verify after applying:
--   select jobname, schedule, active from cron.job
--     where jobname = 'app-purge-assessment-step-events';
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--     where jobname = 'app-purge-assessment-step-events'
--     order by start_time desc limit 5;
-- A healthy run returns status 'succeeded'. return_message carries the row count
-- ('DELETE n'), which is 0 for the first ~180 days after the beacon is wired up —
-- that is the expected reading, not a broken job.
