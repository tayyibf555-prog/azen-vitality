-- 0089_meta_campaign_creative.sql
-- Give a Meta campaign DRAFT a place to carry a generated creative.
--
-- ============================================================================
-- WHY.
--
-- The "recreate this ad" flow (POST /api/meta-ads/recreate) turns a competitor's
-- winning ad into an ORIGINAL, compliance-scanned Vitality ad: original copy PLUS a
-- generated creative (via the image-gen provider, gpt-image-1 today). That result
-- lands as a DRAFT in the campaign builder, reusing the existing meta_campaign draft
-- seam (0048). A draft could already hold the copy; this adds the one thing it could
-- not: the creative image.
--
-- The value is either a hosted URL or a data: URI (gpt-image-1 returns base64, which
-- the route stores as a data URI). It is NULLABLE and defaults to null: every
-- hand-built draft, and every co-pilot-created campaign, leaves it null. The
-- co-pilot's create tool does not set it, so its insert is byte-for-byte what it was
-- before this migration; only the recreate flow ever writes this column.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, same convention as 0048 / 0084 / 0088: the build writes
-- the migration file and a human who has read it applies it. Running it adds one
-- nullable column and changes nothing that is live. The recreate flow only writes
-- this column once the migration is applied; until then it simply never sets it (and
-- the create seam omits the key entirely), so nothing else is affected.
--
-- POST-0012 LOCKED POSTURE is unchanged: meta_campaign keeps RLS on with no
-- anon/authenticated grants; all access stays server-only via the service-role client.
-- ============================================================================

alter table meta_campaign
  add column if not exists creative_image_url text;

comment on column meta_campaign.creative_image_url is
  'Generated creative for a recreated-ad draft (a hosted URL, or a data: URI for a base64 image). Null for hand-built and co-pilot-created drafts. Written only by /api/meta-ads/recreate.';
