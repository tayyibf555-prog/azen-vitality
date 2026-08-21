-- 0088_winning_ads.sql
-- THE WINNING-ADS LIBRARY: niche-level competitor ad intelligence, deduplicated and
-- ranked, for the Meta Ads section's "library of winning dental ads".
--
-- ============================================================================
-- WHAT THIS IS, AND WHAT IT IS NOT.
--
-- This is REFERENCE data scraped from the public Meta Ad Library (Facebook /
-- Instagram): real ads that other UK dental advertisers are running right now. It
-- is NOT patient data, NOT per-client data, and NOT campaign data. It is the same
-- kind of public marketing intelligence a strategist would gather by hand from the
-- Ad Library, kept in one place, deduplicated (40 variants of one creative collapse
-- to ONE library entry with a variant count) and RANKED by a computed
-- `winning_score` so the ads most likely to be winners float to the top.
--
-- The score is a pure function of two public signals, computed in code, never by a
-- model (see src/lib/meta-ads/ingest.ts):
--   * RUNTIME  - how long the ad has been continuously running (end - start, or
--                now - start while it is still active). An advertiser who keeps
--                paying to run one creative for six months is telling you it works.
--                Saturates at ~180 days: six months of continuous spend is already
--                a fully proven winner and longer does not earn more.
--   * VARIANTS - how many variants of the same creative are running (the Ad
--                Library's collation count). Running many variants at once is the
--                signal of an advertiser SCALING a winner.
--
-- Because it is a niche-level library and not a client's own data, the tenancy
-- column is `niche` (e.g. 'uk-dental'), not `client_id`. Every client's Meta Ads
-- section reads the SAME library.
--
-- ============================================================================
-- HOW IT IS FILLED.
--
--   * SEEDED once from a completed scrape via supabase/ops/seed-winning-ads.sql
--     (the top ~120 ranked entries; idempotent upsert on (niche, dedup_key)).
--   * REFRESHED weekly by POST /api/meta-ads/winning-ads/ingest, which re-runs an
--     Apify scrape (given APIFY_TOKEN) and upserts the fresh top slice. The route
--     is owner/cron gated and is an honest no-op when APIFY_TOKEN is not set.
--
-- Both paths upsert on (niche, dedup_key), so re-running either is idempotent: an
-- ad already in the library is UPDATED (fresh runtime, variant count, score and
-- creative URLs), never duplicated.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, same convention as 0062 / 0078-0084: a migration file
-- is written by the build and applied by a human who has read it. Running it adds
-- one empty table and changes nothing that is live until the seed is loaded.
--
-- POST-0012 LOCKED POSTURE: RLS enabled, NO anon/authenticated grants, consistent
-- with 0048 / 0084. This is public ad-library data rather than patient data, but
-- the posture is kept identical across every table so "server-only via the
-- service-role client" is the one rule, with no per-table exceptions to remember.
-- All reads and writes go through src/lib/meta-ads/winning-repository.ts on the
-- service-role client (which bypasses RLS); the browser anon key can neither read
-- nor write this table.
-- ============================================================================

create table if not exists winning_ads (
  id uuid primary key default gen_random_uuid(),

  -- TENANCY / SCOPE. Not a client: this is shared, niche-level reference data. The
  -- keyword is the derived treatment tag (implants, invisalign, whitening, ...) so
  -- the UI can filter the library to one treatment. Both are part of how a row is
  -- read; `niche` is half of the dedup/upsert key.
  niche   text not null default 'uk-dental',
  keyword text not null default 'general-dentistry',

  -- DEDUP IDENTITY. `dedup_key` is the Ad Library collation id when the ad has one
  -- (all variants of a creative share it), else a stable page+body key built in
  -- ingest.ts. It is what makes seeding and the weekly refresh idempotent: the same
  -- creative always maps to the same row. `collation_id` / `ad_archive_id` are kept
  -- for traceability back to the Ad Library.
  dedup_key       text not null,
  collation_id    text,
  ad_archive_id   text,
  collation_count integer,                 -- the Ad Library's own variant count (nullable there)
  variant_count   integer not null default 1,  -- max(collation_count, rows sharing the group); the SCALING signal

  -- THE AD ITSELF (the representative variant's creative). body_text is the copy a
  -- strategist actually studies; it is stored verbatim as PUBLIC competitor copy.
  -- It is reference only: recreating an ad for Vitality goes through the meta-ads
  -- compliance path and produces ORIGINAL copy, never a copy of any of this.
  page_name        text,
  page_id          text,
  title            text,
  body_text        text,
  cta_text         text,
  cta_type         text,
  link_url         text,
  display_format   text,                       -- IMAGE | VIDEO | CAROUSEL | DCO | ...
  publisher_platform jsonb not null default '[]'::jsonb,  -- string[] e.g. ["FACEBOOK","INSTAGRAM"]

  -- The creative thumbnail. NB: Meta CDN URLs are SIGNED and EXPIRE (the oe= query
  -- param is an expiry stamp), so a seeded URL goes stale within days; the weekly
  -- ingest refreshes it. A stale URL is a broken <img>, never a wrong answer, so it
  -- is a nice-to-have the UI must fall back on, not a dependency.
  image_url text,
  currency  text,

  -- THE SCORE INPUTS, stored so the ranking is reproducible and the UI can show the
  -- WHY behind the score (runtime + variant count) instead of a bare number.
  start_date    timestamptz,
  end_date      timestamptz,
  is_active     boolean not null default true,
  runtime_days  integer not null default 0,

  categories      jsonb not null default '[]'::jsonb,  -- the Ad Library's own category tags
  ad_library_url  text,

  -- THE RANK. 0..100, computed in ingest.ts from runtime_days + variant_count. The
  -- library is read ordered by this, desc.
  winning_score integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One row per creative per niche. This is the idempotency guarantee the seed and
  -- the weekly refresh both rely on (upsert ON CONFLICT (niche, dedup_key)).
  unique (niche, dedup_key)
);

-- The read path is "the top N for a niche, best first", optionally filtered to one
-- treatment keyword. Index the ranked scan; the unique (niche, dedup_key) index
-- already serves the upsert.
create index if not exists idx_winning_ads_niche_score
  on winning_ads (niche, winning_score desc);
create index if not exists idx_winning_ads_niche_keyword
  on winning_ads (niche, keyword);

-- POST-0012 LOCKED POSTURE: RLS on, no anon/authenticated grants. All access is
-- server-only via the service-role client (which bypasses RLS), consistent with
-- 0048 / 0084. Public ad-library data, but the posture is kept identical to every
-- other table so there is one rule, not a per-table judgement.
alter table winning_ads enable row level security;
revoke all on winning_ads from anon, authenticated;

-- NO SEED HERE. The top ~120 ranked entries load from supabase/ops/seed-winning-ads.sql
-- (idempotent). Until then, and if this is never applied, the Meta Ads section falls
-- back to its existing curated library exactly as it does today.
