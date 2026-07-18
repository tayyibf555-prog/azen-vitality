-- 0050_meta_publish.sql
-- The REAL Meta (Facebook / Instagram) publish adapter's persistence, shipped DORMANT.
--
-- 0048 stored campaign DRAFTS the owner co-pilot assembles. This migration adds the
-- columns the publish adapter writes when it creates the campaign on Meta, plus the
-- table the hourly insights sweep fills once a campaign is live.
--
-- Publishing NEVER sets a campaign live-spending: every object is created on Meta in
-- PAUSED status and the client reviews + activates it in Ads Manager. So a published
-- row means "created on Meta, paused", not "spending". Today nothing publishes at all:
-- metaConnection() is not-connected until the client's Meta account is linked (see
-- src/lib/meta-ads/connection.ts), so these columns/table simply stay empty.
--
-- publish_error is the HONESTY channel: on a Graph failure it holds the error and the
-- status stays 'ready' (never 'published'); on success it may hold a non-fatal note
-- (e.g. radius targeting could not be applied because the site has no coordinates, so
-- a UK-wide fallback was used), else null.
--
-- POST-0012 locked posture, matching 0048: RLS enabled, NO anon/authenticated grants.
-- All access is server-only via the service-role client. British English, GBP.

-- The three Meta object refs (campaign / ad set / ad), when + why of publishing.
alter table meta_campaign add column if not exists meta_campaign_ref text;
alter table meta_campaign add column if not exists meta_adset_ref text;
alter table meta_campaign add column if not exists meta_ad_ref text;
alter table meta_campaign add column if not exists published_at timestamptz;
alter table meta_campaign add column if not exists publish_error text;

-- One row per insights capture for a published campaign. Money is GBP; the raw Graph
-- payload is kept in `raw` so a later, richer read never has to re-query Meta for it.
create table if not exists meta_campaign_insight (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references meta_campaign(id) on delete cascade,
  captured_at timestamptz not null default now(),
  spend_gbp numeric,
  impressions bigint,
  clicks bigint,
  leads bigint,
  raw jsonb
);
-- The sweep inserts newest captures; the UI reads the latest per campaign. Index the
-- (campaign, most-recent-first) access path.
create index if not exists idx_meta_campaign_insight_campaign_captured
  on meta_campaign_insight (campaign_id, captured_at desc);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0048).
alter table meta_campaign_insight enable row level security;
