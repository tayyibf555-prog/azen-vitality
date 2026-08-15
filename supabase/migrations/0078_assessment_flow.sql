-- 0078_assessment_flow.sql
-- The AUTHORED FUNNEL: an owner-drawn question graph attached to a Smile Assessment
-- campaign, plus which version of it a submission came through.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, AND THAT IS THE POINT OF THIS HEADER.
--
-- Unlike 0066/0070, the reason here is NOT clinical risk. It is simply that this
-- repo's convention is that a migration file is written by the build and applied
-- by a human who has read it. So: do not apply this file to demonstrate the
-- feature. What makes that safe is the second half of this header.
--
-- RUNNING IT CHANGES NOTHING THAT IS LIVE. There is no new table, no RLS change
-- (both parent tables are already server-only under 0017/0018/0012), no backfill
-- and no seed. Every existing campaign lands with flow = null, flow_version = 0
-- and flow_published = false, which is exactly the state the code reads as "this
-- campaign has no authored funnel", i.e. the ADAPTIVE funnel it already runs. The
-- four live campaigns (0060) keep working, byte for byte, either way.
--
-- AND UNTIL IT IS APPLIED, THE CODE STILL WORKS. rowToCampaign
-- (src/lib/smile-assessment/campaign-repository.ts) defaults all three fields for
-- a row that predates this file, because `select("*")` on an un-migrated table
-- simply does not return them. So the deploy order is free: the code can ship
-- first and every campaign stays adaptive until someone applies this and then
-- publishes a funnel on purpose.
-- ============================================================================
--
-- WHY A jsonb COLUMN AND NOT A NEW TABLE.
--
-- The exact sibling already exists: onboarding_form.config (0032) is an
-- owner-authored jsonb config hanging off a shareable public slug, coerced on
-- every read by normaliseFormConfig. That is the house pattern for this shape,
-- and this is the same shape. The alternative, a flow table joined at read time,
-- would put a join on /assess/<client>/<slug>, which is a public force-dynamic
-- page that ad spend points at. A snapshot table (the rota_publication shape,
-- 0074) is not warranted either: that table exists because a rota DISPUTE turns
-- on what a person was told and when. Nobody is told a funnel.
--
-- WHY flow_published IS A SEPARATE BOOLEAN AND NOT A status VALUE.
--
-- smile_assessment_campaign.status is 'active' | 'paused' only, and the internal
-- live preview requires 'active' to render at all (0060). So there is no draft
-- state to borrow: without this column, saving a half-built funnel onto an active
-- campaign would put it in front of real ad traffic the instant it saved. The
-- runtime therefore requires BOTH flow_published = true AND a graph that
-- re-validates on read; anything else falls back to the adaptive funnel, which
-- always works.

alter table smile_assessment_campaign
  -- The graph itself: { schemaVersion, entry, nodes[], edges[] } as described in
  -- src/lib/smile-assessment/flow.ts. null = no authored funnel, stay adaptive.
  -- Deliberately unconstrained here: the shape is enforced in one place
  -- (normaliseFlow + validateFlow, 11 numbered rules with a test each), and a
  -- second, weaker copy of those rules expressed as a CHECK would only ever drift
  -- from the real one. Same call 0059 made about `goal`.
  add column if not exists flow jsonb,
  -- Monotonic, bumped on every save. Never reused, never reset. It is what lets a
  -- response be attributed to the funnel version that produced it (below), and
  -- what a save can be reported against ("saved as version 4").
  add column if not exists flow_version int not null default 0,
  -- The publish gate. Default FALSE on purpose: an existing campaign gaining this
  -- column must not gain a live funnel, and a newly saved draft must not go live
  -- until the owner says so.
  add column if not exists flow_published boolean not null default false;

alter table smile_assessment_response
  -- Which version of the funnel this submission came through; null for every
  -- response captured by the adaptive funnel, which is all of them today. Soft,
  -- nullable and unindexed, matching campaign_id's soft link in 0018: it answers
  -- "did the new funnel convert better than the old one" and nothing depends on
  -- it, so it can never break a submission.
  add column if not exists flow_version int;

-- NO SEED, and no update. Running this authors no funnel, publishes no funnel and
-- changes no live URL. The first published funnel is an act an owner performs on
-- purpose, in the builder, on a campaign they chose.
