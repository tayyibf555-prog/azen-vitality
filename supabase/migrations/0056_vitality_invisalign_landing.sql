-- 0056_vitality_invisalign_landing.sql
-- Seed the DB record for the BESPOKE (hand-designed) Vitality Dental Invisalign
-- landing page.
--
-- The public page at /go/vitality/invisalign renders a bespoke server component
-- (components/landing/bespoke/vitality-invisalign-landing.tsx), branched to from the
-- /go route via the bespoke registry. But it still needs a real landing_page row so
-- that: it appears in Growth > Landing pages with Preview + A/B stats, its A/B
-- variant is assigned + tracked exactly like every other page, and its lead endpoint
-- can confirm the page is LIVE before capturing an enquiry.
--
-- The bespoke COMPONENT does not read this content (its per-variant hero + CTA copy
-- lives in the code registry). This content exists so the row is a valid,
-- compliant landing page in its own right: both variants are complete, vetted v2
-- LandingPageContent that PASS validateContent AND lintContent (Invisalign priced at
-- the real catalogue figure of GBP 2,500; no testimonials, guarantees, pain-free
-- claims, superlatives, funding words or dash characters). They are the invisalign
-- default content, differing only in the hero headline/accent/subhead and the CTA
-- label between a and b, mirroring the bespoke A/B surface.
--
-- Seeded as DRAFT (not live): publishing draft -> live is an explicit owner action.
-- Idempotent on the (client_id, slug) and (page_id, variant_key) unique keys, so
-- re-running is safe. Applied as a FILE only in this workstream (do NOT run here).
--
-- POST-0012 posture: RLS is already enabled on these tables (migration 0044); this
-- migration only inserts rows via the service-role migration path. British English,
-- GBP, no NHS vs private framing, no dash characters in copy.

insert into landing_page (client_id, site_id, slug, treatment, campaign_ref, status, auto_promote, created_by)
values ('vitality', 'site-cc', 'invisalign', 'invisalign', null, 'draft', true, 'system')
on conflict (client_id, slug) do nothing;

-- Variant A: leads on the outcome + timeline ("from 3 months").
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'a',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Clear aligner treatment",
      "headline": "Straighter teeth, no metal braces, from 3 months",
      "headlineAccent": "from 3 months",
      "subhead": "A discreet way to straighten your smile, with a free initial consultation and a friendly, unrushed team.",
      "checklist": ["Virtually invisible aligners", "Removable to eat and brush", "0 percent finance available", "Free initial consultation"]
    },
    "benefits": [
      {"title": "Barely there", "detail": "Clear aligners that most people will not notice you are wearing day to day."},
      {"title": "Removable", "detail": "Take them out to eat, brush and floss, so your daily routine stays simple."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to make the investment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "Hiding your smile in photos", "body": "You catch yourself closing your mouth or turning away when the camera comes out."},
        {"title": "Put off by metal braces", "body": "The thought of visible train track braces as an adult has kept you from doing anything about it."},
        {"title": "Not sure where to start", "body": "You have wondered about straightening your teeth for a while, but never quite asked the question."},
        {"title": "Worried it takes over", "body": "You want a change that fits around work and normal life, not one that gets in the way."}
      ],
      "reassurance": "If any of that sounds familiar, you are in good company. Here is how clear aligners can help."
    },
    "about": {
      "body": "Invisalign straightens teeth using a series of clear, custom made aligners instead of fixed braces. You wear each set for a couple of weeks and they gently move your teeth towards a straighter position over time. Each aligner is made to fit your teeth from a digital scan.",
      "keyFacts": ["Treatment from around 3 months", "Clear and virtually invisible", "Removable to eat, brush and floss", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation and scan", "body": "We talk through what you would like to change and take a quick digital scan of your teeth."},
        {"title": "Your custom plan", "body": "Your dentist maps out a step by step plan and shows you the likely journey for your smile."},
        {"title": "Wear your aligners", "body": "You wear each set as guided, swapping to the next every couple of weeks."},
        {"title": "Result and retention", "body": "Once your teeth are where you want them, a retainer helps keep your new smile in place."}
      ]
    },
    "suitability": {
      "heading": "What Invisalign can help with",
      "items": [
        {"title": "Crowded teeth", "body": "Teeth that overlap or sit too close together and are harder to keep clean."},
        {"title": "Gaps and spacing", "body": "Noticeable spaces between teeth that you would like to close."},
        {"title": "Crooked front teeth", "body": "Front teeth that have shifted over time or never sat quite straight."},
        {"title": "Mild bite concerns", "body": "Some overbite or an uneven bite that a clinician can assess for aligner treatment."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Invisalign", "fromPriceGBP": 2500}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How long does treatment take?", "a": "It varies from person to person. Some cases take a few months, others longer. Your dentist will talk you through a likely timeline at your consultation."},
      {"q": "Will people notice I am wearing them?", "a": "The aligners are clear and made to fit closely, so most people will not notice them day to day."},
      {"q": "Is Invisalign right for me?", "a": "Suitability depends on a clinical assessment. Book a consultation and we will explain your options."},
      {"q": "Can I spread the cost?", "a": "Yes, 0 percent finance is available. We can go through the options with you at your visit."},
      {"q": "What happens after treatment?", "a": "You will be given a retainer to help hold your teeth in their new position."}
    ],
    "cta": {"label": "Book my free consultation", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'invisalign'
on conflict (page_id, variant_key) do nothing;

-- Variant B: leads on the method (clear aligners) + a suitability CTA. Identical to A
-- except the hero headline/accent/subhead and the CTA label (the A/B surface).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'b',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Clear aligner treatment",
      "headline": "A straighter smile with clear aligners",
      "headlineAccent": "clear aligners",
      "subhead": "A discreet way to straighten your teeth at Vitality Dental, with a free initial consultation and a friendly, unrushed team.",
      "checklist": ["Virtually invisible aligners", "Removable to eat and brush", "0 percent finance available", "Free initial consultation"]
    },
    "benefits": [
      {"title": "Barely there", "detail": "Clear aligners that most people will not notice you are wearing day to day."},
      {"title": "Removable", "detail": "Take them out to eat, brush and floss, so your daily routine stays simple."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to make the investment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "Hiding your smile in photos", "body": "You catch yourself closing your mouth or turning away when the camera comes out."},
        {"title": "Put off by metal braces", "body": "The thought of visible train track braces as an adult has kept you from doing anything about it."},
        {"title": "Not sure where to start", "body": "You have wondered about straightening your teeth for a while, but never quite asked the question."},
        {"title": "Worried it takes over", "body": "You want a change that fits around work and normal life, not one that gets in the way."}
      ],
      "reassurance": "If any of that sounds familiar, you are in good company. Here is how clear aligners can help."
    },
    "about": {
      "body": "Invisalign straightens teeth using a series of clear, custom made aligners instead of fixed braces. You wear each set for a couple of weeks and they gently move your teeth towards a straighter position over time. Each aligner is made to fit your teeth from a digital scan.",
      "keyFacts": ["Treatment from around 3 months", "Clear and virtually invisible", "Removable to eat, brush and floss", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation and scan", "body": "We talk through what you would like to change and take a quick digital scan of your teeth."},
        {"title": "Your custom plan", "body": "Your dentist maps out a step by step plan and shows you the likely journey for your smile."},
        {"title": "Wear your aligners", "body": "You wear each set as guided, swapping to the next every couple of weeks."},
        {"title": "Result and retention", "body": "Once your teeth are where you want them, a retainer helps keep your new smile in place."}
      ]
    },
    "suitability": {
      "heading": "What Invisalign can help with",
      "items": [
        {"title": "Crowded teeth", "body": "Teeth that overlap or sit too close together and are harder to keep clean."},
        {"title": "Gaps and spacing", "body": "Noticeable spaces between teeth that you would like to close."},
        {"title": "Crooked front teeth", "body": "Front teeth that have shifted over time or never sat quite straight."},
        {"title": "Mild bite concerns", "body": "Some overbite or an uneven bite that a clinician can assess for aligner treatment."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Invisalign", "fromPriceGBP": 2500}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How long does treatment take?", "a": "It varies from person to person. Some cases take a few months, others longer. Your dentist will talk you through a likely timeline at your consultation."},
      {"q": "Will people notice I am wearing them?", "a": "The aligners are clear and made to fit closely, so most people will not notice them day to day."},
      {"q": "Is Invisalign right for me?", "a": "Suitability depends on a clinical assessment. Book a consultation and we will explain your options."},
      {"q": "Can I spread the cost?", "a": "Yes, 0 percent finance is available. We can go through the options with you at your visit."},
      {"q": "What happens after treatment?", "a": "You will be given a retainer to help hold your teeth in their new position."}
    ],
    "cta": {"label": "Check if I am suitable", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'invisalign'
on conflict (page_id, variant_key) do nothing;
