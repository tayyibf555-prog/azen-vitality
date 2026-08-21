-- register-winning-ads-ingest-cron.sql — register the weekly winning-ads refresh
-- ---------------------------------------------------------------------------
-- STATUS: NOT YET REGISTERED. This is an activation-day step. Run it once (Fable
-- applies cron SQL; the app's Supabase role is read-only on the cron.job TABLE, so
-- use the cron.* FUNCTIONS, which are SECURITY DEFINER — same method as
-- register-outreach-cron.sql / register-meta-insights-cron.sql / enable-24-7-cron.sql).
--
-- WHY: POST /api/meta-ads/winning-ads/ingest re-scrapes the public Meta Ad Library
-- for UK dental ads via Apify, ranks them (src/lib/meta-ads/ingest.ts) and upserts
-- the fresh top slice into winning_ads. That keeps the "library of winning dental
-- ads" current: ads that have kept running climb, ads that have stopped fall away.
--
-- ============================================================================
-- COST: EACH RUN COSTS ~£1.50 / ~$1.50 ON APIFY.
--
-- Unlike every other job in this folder, this one is NOT free to run: when it has no
-- datasetId it triggers a FRESH Apify actor scrape of the Ad Library, and that scrape
-- is a paid Apify run (~$1.50 at the current ~1000-ad scope). That is the whole reason
-- the cadence below is WEEKLY, not hourly or daily: winning ads are a slow-moving
-- signal (runtime measured in months), so weekly resolution is plenty, and twelve
-- runs a quarter is roughly £18 — a deliberate, bounded spend. Do not shorten the
-- cadence without accepting the linear cost increase.
--
-- If APIFY_TOKEN is not set in the app environment, the route is an honest 200 no-op
-- ({"skipped":"apify_token_not_set"}) and NO Apify run is triggered, so registering
-- this job before the token is provisioned costs nothing and simply idles.
-- ============================================================================
--
-- CADENCE: weekly, Monday 04:00 UTC (off-peak, before the working week). The route
-- is idempotent (upsert on (niche, dedup_key)), so a double-fire only rewrites the
-- same rows; a missed week is harmless (the next run catches up).
--
-- PREREQUISITES before this does real work:
--   * migration 0088_winning_ads.sql applied
--   * supabase/ops/seed-winning-ads.sql loaded once (the initial top 120)
--   * APIFY_TOKEN set in the app environment
--   * WINNING_ADS_APIFY_ACTOR set to the Ad Library scraper actor id (for the fresh
--     scrape path), OR WINNING_ADS_DATASET_ID set to re-ingest a fixed dataset (free)
-- CRON_SECRET is NOT written here; it lives inside public.trigger_app_cron(), exactly
-- as every other job relies on.
-- ---------------------------------------------------------------------------

select cron.schedule(
  'app-sweep-winning-ads-ingest',
  '0 4 * * 1',
  $$select public.trigger_app_cron('/api/meta-ads/winning-ads/ingest')$$
);

-- cron.schedule() on an existing job of this name updates its schedule/command but
-- KEEPS the current active flag. If it was ever created inactive, activate it:
--   select cron.alter_job(job_id := (select jobid from cron.job
--                                    where jobname = 'app-sweep-winning-ads-ingest'),
--                         active := true);

-- Verify after applying:
--   select jobname, schedule, active from cron.job where jobname = 'app-sweep-winning-ads-ingest';
--   select jobname, status, return_message, start_time
--     from cron.job_run_details
--     where jobname = 'app-sweep-winning-ads-ingest'
--     order by start_time desc limit 5;
-- Before APIFY_TOKEN is set, a healthy run returns HTTP 200 with body
-- {"ok":true,"skipped":"apify_token_not_set","upserted":0} — correct: registered and
-- idle, and NOT incurring the ~$1.50 scrape cost until the token is provisioned.

-- To remove:
--   select cron.unschedule('app-sweep-winning-ads-ingest');
