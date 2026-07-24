-- 0058_vitality_hygiene_landing.sql
-- Seed the DB record for a GENERIC (non-bespoke) Vitality Dental hygiene
-- ("professional clean") landing page, so a Hygiene tab appears in
-- Growth > Landing pages (that section groups landing pages by treatment).
--
-- Unlike invisalign (0056) and bonding (0057), this page is NOT a hand-designed
-- bespoke component: hygiene is deliberately absent from the bespoke registry
-- (src/lib/landing/bespoke/registry.ts), so the public route /go/vitality/hygiene
-- renders it from the DB content via the ONE vetted generic renderer
-- (components/landing/landing-content.tsx). Everything else (variant assignment,
-- the analytics tracker, the A/B stats, the draft preview flow) is identical to
-- every other page.
--
-- The hygiene treatment already exists in the catalogue (src/lib/treatments/catalog.ts,
-- key "hygiene", "Hygiene visit", from GBP 75, no finance): this migration does NOT
-- add a treatment. Both variants are complete, vetted v2 LandingPageContent that
-- PASS validateContent AND lintContent (hygiene priced at the real catalogue figure
-- of GBP 75; no testimonials, guarantees, pain claims, superlatives, funding words
-- or dash characters, and no finance copy because hygiene has none). They are the
-- hygiene default content, differing only in the hero headline/accent/subhead and
-- the CTA label between a and b (the A/B surface).
--
-- Seeded as DRAFT (not live): publishing draft -> live is an explicit owner action
-- once the practice is ready to advertise it. Idempotent on the (client_id, slug)
-- and (page_id, variant_key) unique keys, so re-running is safe. Applied as a FILE
-- only in this workstream (do NOT run here, and do NOT publish).
--
-- POST-0012 posture: RLS is already enabled on these tables (migration 0044); this
-- migration only inserts rows via the service-role migration path. British English,
-- GBP, no NHS vs private framing, no dash characters in copy.

insert into landing_page (client_id, site_id, slug, treatment, campaign_ref, status, auto_promote, created_by)
values ('vitality', 'site-cc', 'hygiene', 'hygiene', null, 'draft', true, 'system')
on conflict (client_id, slug) do nothing;

-- Variant A: leads on the outcome (a fresh, healthy feel from a professional clean).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'a',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Hygiene visit",
      "headline": "A fresh, healthy feel from a professional clean",
      "headlineAccent": "professional clean",
      "subhead": "See the hygienist for a scale and polish that lifts away plaque and surface staining, leaving your teeth smooth and your gums feeling healthier.",
      "checklist": ["Scale and polish", "Seen by a hygienist", "Removes plaque and staining", "Fresher, cleaner feel"]
    },
    "benefits": [
      {"title": "A thorough clean", "detail": "The hygienist removes plaque and hardened build up that brushing at home can leave behind."},
      {"title": "Healthier gums", "detail": "Removing build up along the gumline helps keep your gums comfortable and healthy."},
      {"title": "A fresh finish", "detail": "A polish lifts away surface staining and leaves your teeth feeling smooth and clean."}
    ],
    "painPoints": {
      "items": [
        {"title": "A rough, furry feeling", "body": "That rough or furry feeling on your teeth that brushing at home does not fully shift."},
        {"title": "Staining from tea and coffee", "body": "Surface marks from tea, coffee or red wine that have dulled how your smile looks."},
        {"title": "Tender gums when you brush", "body": "Gums that feel a little tender or sensitive when you brush or floss at home."},
        {"title": "It has been a while", "body": "Months, or longer, since your last clean, and you would like a fresh start."}
      ],
      "reassurance": "If any of that sounds familiar, a professional clean with the hygienist can help. Here is how a visit works."
    },
    "about": {
      "body": "A hygiene visit is a professional clean with the hygienist. Using gentle scaling, they remove the plaque and hardened build up, sometimes called tartar, that gathers along the gumline where a toothbrush cannot always reach. The teeth are then polished to lift away surface staining and leave a smooth finish. The hygienist can also show you simple ways to care for your teeth and gums at home, so seeing them regularly helps keep your gums healthy and your smile feeling fresh.",
      "keyFacts": ["A clean with the hygienist", "Scale and polish", "Removes plaque and staining", "Helps keep gums healthy"]
    },
    "howItWorks": {
      "steps": [
        {"title": "A quick check", "body": "The hygienist looks over your teeth and gums and asks how you have been getting on at home."},
        {"title": "Scaling", "body": "Using gentle scaling, plaque and hardened build up are removed from around the teeth and gumline."},
        {"title": "Polish", "body": "The teeth are polished to lift away surface staining and leave a smooth, fresh finish."},
        {"title": "Tips for home", "body": "The hygienist shares simple pointers for brushing and cleaning between your teeth at home."}
      ]
    },
    "suitability": {
      "heading": "When a hygiene visit helps",
      "items": [
        {"title": "Regular upkeep", "body": "A routine clean every few months to keep plaque and staining from building up."},
        {"title": "Build up you can feel", "body": "When brushing at home is not quite shifting the rough feeling on your teeth."},
        {"title": "Staining you would like lifted", "body": "Surface marks from tea, coffee, wine or smoking that dull the look of your smile."},
        {"title": "Caring for your gums", "body": "When you would like to keep your gums healthy and comfortable between checkups."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Hygiene visit", "fromPriceGBP": 75}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after seeing the hygienist."},
    "faqs": [
      {"q": "How long does a hygiene visit take?", "a": "Most visits take around thirty minutes. The hygienist will let you know what your teeth need."},
      {"q": "Will a scale and polish be uncomfortable?", "a": "Most people find it very manageable. Tell the hygienist if anything feels sensitive and they will take extra care."},
      {"q": "How often should I see the hygienist?", "a": "Many people come every six months, though some benefit from more regular visits. The hygienist will suggest what suits you."},
      {"q": "Do I need a checkup as well?", "a": "A hygiene visit focuses on cleaning. A checkup with the dentist looks at the health of your teeth, and the two work well together."}
    ],
    "cta": {"label": "Book my hygiene visit", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'hygiene'
on conflict (page_id, variant_key) do nothing;

-- Variant B: leads on prevention (healthier gums from seeing the hygienist regularly).
-- Identical to A except the hero headline/accent/subhead and the CTA label (the A/B surface).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'b',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Hygiene visit",
      "headline": "Healthier gums start with a regular clean",
      "headlineAccent": "regular clean",
      "subhead": "Seeing the hygienist regularly helps remove the plaque and build up that a toothbrush can miss, so your gums stay healthy and your smile stays fresh.",
      "checklist": ["Scale and polish", "Seen by a hygienist", "Removes plaque and staining", "Fresher, cleaner feel"]
    },
    "benefits": [
      {"title": "A thorough clean", "detail": "The hygienist removes plaque and hardened build up that brushing at home can leave behind."},
      {"title": "Healthier gums", "detail": "Removing build up along the gumline helps keep your gums comfortable and healthy."},
      {"title": "A fresh finish", "detail": "A polish lifts away surface staining and leaves your teeth feeling smooth and clean."}
    ],
    "painPoints": {
      "items": [
        {"title": "A rough, furry feeling", "body": "That rough or furry feeling on your teeth that brushing at home does not fully shift."},
        {"title": "Staining from tea and coffee", "body": "Surface marks from tea, coffee or red wine that have dulled how your smile looks."},
        {"title": "Tender gums when you brush", "body": "Gums that feel a little tender or sensitive when you brush or floss at home."},
        {"title": "It has been a while", "body": "Months, or longer, since your last clean, and you would like a fresh start."}
      ],
      "reassurance": "If any of that sounds familiar, a professional clean with the hygienist can help. Here is how a visit works."
    },
    "about": {
      "body": "A hygiene visit is a professional clean with the hygienist. Using gentle scaling, they remove the plaque and hardened build up, sometimes called tartar, that gathers along the gumline where a toothbrush cannot always reach. The teeth are then polished to lift away surface staining and leave a smooth finish. The hygienist can also show you simple ways to care for your teeth and gums at home, so seeing them regularly helps keep your gums healthy and your smile feeling fresh.",
      "keyFacts": ["A clean with the hygienist", "Scale and polish", "Removes plaque and staining", "Helps keep gums healthy"]
    },
    "howItWorks": {
      "steps": [
        {"title": "A quick check", "body": "The hygienist looks over your teeth and gums and asks how you have been getting on at home."},
        {"title": "Scaling", "body": "Using gentle scaling, plaque and hardened build up are removed from around the teeth and gumline."},
        {"title": "Polish", "body": "The teeth are polished to lift away surface staining and leave a smooth, fresh finish."},
        {"title": "Tips for home", "body": "The hygienist shares simple pointers for brushing and cleaning between your teeth at home."}
      ]
    },
    "suitability": {
      "heading": "When a hygiene visit helps",
      "items": [
        {"title": "Regular upkeep", "body": "A routine clean every few months to keep plaque and staining from building up."},
        {"title": "Build up you can feel", "body": "When brushing at home is not quite shifting the rough feeling on your teeth."},
        {"title": "Staining you would like lifted", "body": "Surface marks from tea, coffee, wine or smoking that dull the look of your smile."},
        {"title": "Caring for your gums", "body": "When you would like to keep your gums healthy and comfortable between checkups."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Hygiene visit", "fromPriceGBP": 75}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after seeing the hygienist."},
    "faqs": [
      {"q": "How long does a hygiene visit take?", "a": "Most visits take around thirty minutes. The hygienist will let you know what your teeth need."},
      {"q": "Will a scale and polish be uncomfortable?", "a": "Most people find it very manageable. Tell the hygienist if anything feels sensitive and they will take extra care."},
      {"q": "How often should I see the hygienist?", "a": "Many people come every six months, though some benefit from more regular visits. The hygienist will suggest what suits you."},
      {"q": "Do I need a checkup as well?", "a": "A hygiene visit focuses on cleaning. A checkup with the dentist looks at the health of your teeth, and the two work well together."}
    ],
    "cta": {"label": "Book a hygiene appointment", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'hygiene'
on conflict (page_id, variant_key) do nothing;
