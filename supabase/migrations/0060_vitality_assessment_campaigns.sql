-- 0060_vitality_assessment_campaigns.sql
-- Seed three Smile Assessment campaigns for Vitality Dental, one per treatment
-- (Invisalign, Composite bonding, Hygiene), so the new treatment-tabbed
-- Assessments section (Growth > Smile Assessment) has something to show under
-- each tab. Mirrors the analogous Landing pages seeds: 0056 (invisalign),
-- 0057 (bonding), 0058 (hygiene).
--
-- These are UNLINKED quiz pages: nothing currently points an ad, a website
-- link, or a QR code at them, so they carry the same public exposure as the
-- existing generic /assess/vitality quiz (reachable if the URL is known; not
-- indexed or advertised anywhere yet). They are seeded ACTIVE (not paused)
-- because, unlike landing_page, smile_assessment_campaign has no "draft"
-- status (0018_smile_assessment_campaign.sql: status is 'active' | 'paused'
-- only) -- both the public URL and the internal live-preview iframe require
-- an active campaign to resolve (getActiveCampaignBySlug 404s a paused or
-- unknown slug), so "active" is the only status that is previewable at all.
--
-- target_budget is 'any' for all three: these are not yet linked from a
-- specific ad, so there is no basis yet to bias the scoring toward a
-- particular funding answer. goal_note / ideal_customer are left null (no
-- internal targeting persona has been supplied for these).
--
-- Idempotent on (client_id, slug) -- the same unique constraint 0018 created.
-- Applied as a FILE only in this workstream (do NOT run here).
--
-- British English. No NHS vs private framing, no dash characters, and no
-- guarantee/suitability-promise wording in the patient-facing name/headline/
-- intro (see the paired seed test, which parses this file and asserts exactly
-- that). Slugs are plain treatment words, none of which are in RESERVED_SLUGS
-- (src/lib/smile-assessment/campaign.ts: "", "api", "assess", "new", "edit",
-- "admin").

insert into smile_assessment_campaign
  (client_id, site_id, slug, name, goal, target_budget, headline, intro, status, created_by)
values
  (
    'vitality', 'site-cc', 'invisalign', 'Invisalign smile assessment', 'invisalign', 'any',
    'Could Invisalign be right for your smile?',
    'Answer a few quick questions about your smile goals and we will suggest your next step. It takes about a minute, and a clinician always confirms what is right for you.',
    'active', 'system'
  )
on conflict (client_id, slug) do nothing;

insert into smile_assessment_campaign
  (client_id, site_id, slug, name, goal, target_budget, headline, intro, status, created_by)
values
  (
    'vitality', 'site-cc', 'bonding', 'Composite bonding assessment', 'bonding', 'any',
    'Thinking about composite bonding?',
    'Tell us a little about your smile and we will suggest your next step. It takes about a minute, and a clinician always confirms what is right for you.',
    'active', 'system'
  )
on conflict (client_id, slug) do nothing;

insert into smile_assessment_campaign
  (client_id, site_id, slug, name, goal, target_budget, headline, intro, status, created_by)
values
  (
    'vitality', 'site-cc', 'hygiene', 'Hygiene visit assessment', 'hygiene', 'any',
    'Ready for a fresh, healthy smile?',
    'Answer a few quick questions and we will help you book a hygiene visit that suits you. It takes about a minute.',
    'active', 'system'
  )
on conflict (client_id, slug) do nothing;
