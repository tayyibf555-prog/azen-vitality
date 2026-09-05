-- register-outreach-cron.sql  —  register the Segment-outreach sweep on pg_cron
-- ---------------------------------------------------------------------------
-- STATUS: APPLIED (verify against cron.job).
--
-- This header used to deny that, and denied it for months while the job it
-- registers was running every ten minutes. A read-only `select jobname, schedule,
-- active from cron.job` against production on 4 September 2026 found
-- 'app-sweep-outreach' registered, active, on */10, with 6,949 successful runs in
-- cron.job_run_details, the last at 19:30 UTC that day. Ruling W3/22 corrects the
-- header rather than the job: never move a working job in a review round.
-- `cron.job` is the evidence; a header is only a claim, so verify before acting
-- on either:
--
--   select jobname, schedule, active from cron.job where jobname = 'app-sweep-outreach';
--
-- The statement below is now a RE-REGISTRATION of a job that already exists. It
-- is safe (identical name, identical */10 schedule, identical command, and
-- cron.schedule keeps the current active flag), but it is not needed. Run it only
-- to rebuild the job on a fresh project, or after somebody has unscheduled it.
--
-- Method, when it IS run: Fable applies cron SQL; the app's Supabase role is
-- read-only on the cron.job TABLE, so use the cron.* FUNCTIONS, which are
-- SECURITY DEFINER — same method as supabase/ops/enable-24-7-cron.sql.
--
-- WHY: app-sweep-outreach was never registered (see enable-24-7-cron.sql's job
-- list — outreach is absent). Two things depend on it running on the schedule:
--   1. SENDING: a launched (running) campaign only drafts + queues its daily
--      cadence when the sweep runs. Gated by the outreach send kill switch.
--   2. BUILDING (new): the sweep now advances any campaign left in status
--      'building' to 'ready' via an UNGATED build-continuation pass at the top of
--      the route (BEFORE the send kill switch). This is what lets a campaign
--      created purely through the co-pilot finish its patient scan on the 24/7
--      schedule WITHOUT the Campaigns UI loop. Without this job, a co-pilot-built
--      campaign over a large base stays 'building' forever and can never launch.
--
-- There is NO separate app-sync-outreach job: outreach does not pull a Dentally
-- feed like recall/reactivation do. Its "sync" IS the segment build, and that now
-- runs inside app-sweep-outreach (the build-continuation pass). So this one job
-- covers both building and sending; nothing else to register.
--
-- CADENCE: */10, matching the other lifecycle sweeps (coordinator/noshow/recall/
-- reactivation). The build pass is rate-limit aware (it stops and resumes on a
-- Dentally 403/429) and bounded per run, so a large build simply finishes over
-- several ticks. CRON_SECRET is NOT written here; it lives inside
-- public.trigger_app_cron(), exactly as the other jobs rely on.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'app-sweep-outreach',
  '*/10 * * * *',
  $$select public.trigger_app_cron('/api/outreach/sweep')$$
);

-- cron.schedule() on an existing job named 'app-sweep-outreach' updates its
-- schedule/command but KEEPS the current active flag. If it was ever created
-- inactive, activate it explicitly (find the id in cron.job first):
--   select cron.alter_job(job_id := (select jobid from cron.job
--                                    where jobname = 'app-sweep-outreach'),
--                         active := true);

-- Verify after applying:
--   select jobname, schedule, active from cron.job where jobname = 'app-sweep-outreach';
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--     where jobname = 'app-sweep-outreach'
--     order by start_time desc limit 5;
-- A healthy run returns HTTP 200 with a JSON body carrying a "build" summary
-- ({campaigns,ticks,completed}); with the send switch OFF it also has
-- "skipped":"system off" — that is correct: builds still advance, sends do not.
