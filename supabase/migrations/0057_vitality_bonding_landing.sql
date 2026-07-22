-- 0057_vitality_bonding_landing.sql
-- Seed the DB record for the BESPOKE (hand-designed) Vitality Dental composite
-- bonding landing page.
--
-- The public page at /go/vitality/bonding renders a bespoke server component
-- (components/landing/bespoke/vitality-bonding-landing.tsx), branched to from the
-- /go route via the bespoke registry (templateId vitality-bonding). But it still
-- needs a real landing_page row so that: it appears in Growth > Landing pages with
-- Preview + A/B stats, its A/B variant is assigned + tracked exactly like every
-- other page, and its lead endpoint can confirm the page is LIVE before capturing
-- an enquiry.
--
-- The bespoke COMPONENT does not read this content (its per-variant hero + CTA copy
-- lives in the code registry). This content exists so the row is a valid, compliant
-- landing page in its own right: both variants are complete, vetted v2
-- LandingPageContent that PASS validateContent AND lintContent (Composite bonding
-- priced at the real catalogue figure of GBP 180; no testimonials, guarantees,
-- pain-free claims, superlatives, funding words or dash characters). They are the
-- bonding default content, differing only in the hero headline/accent/subhead and
-- the CTA label between a and b, mirroring the bespoke A/B surface.
--
-- Seeded as DRAFT (not live): this page only goes live once the practice supplies
-- real, consented bonding photos, and publishing draft -> live is an explicit owner
-- action. Idempotent on the (client_id, slug) and (page_id, variant_key) unique
-- keys, so re-running is safe. Applied as a FILE only in this workstream (do NOT run
-- here, and do NOT publish).
--
-- POST-0012 posture: RLS is already enabled on these tables (migration 0044); this
-- migration only inserts rows via the service-role migration path. British English,
-- GBP, no NHS vs private framing, no dash characters in copy.

insert into landing_page (client_id, site_id, slug, treatment, campaign_ref, status, auto_promote, created_by)
values ('vitality', 'site-cc', 'bonding', 'bonding', null, 'draft', true, 'system')
on conflict (client_id, slug) do nothing;

-- Variant A: leads on the outcome + timeline ("a single visit").
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'a',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Composite bonding",
      "headline": "A tidier smile, often in a single visit",
      "headlineAccent": "a single visit",
      "subhead": "Tooth coloured material shaped onto your teeth to smooth away chips, gaps and small imperfections, usually in one appointment.",
      "checklist": ["Tooth coloured resin", "Usually one visit", "0 percent finance available", "Free initial consultation"]
    },
    "benefits": [
      {"title": "Tooth coloured", "detail": "Bonding uses a resin matched to your natural teeth, so repairs blend in."},
      {"title": "Often one visit", "detail": "Many bonding cases are completed in a single appointment, with minimal preparation."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to make the treatment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "A chip that catches your eye", "body": "A small chip on a front tooth that you notice every time you look in the mirror."},
        {"title": "A gap you would like to close", "body": "A small space between your front teeth that shows when you smile."},
        {"title": "Edges that look worn", "body": "Tooth edges that have worn down or sit unevenly over the years."},
        {"title": "Not sure where to start", "body": "You have wondered about tidying up your smile, but never quite asked the question."}
      ],
      "reassurance": "If any of that sounds familiar, composite bonding may be a simple way to help. Here is how it works."
    },
    "about": {
      "body": "Composite bonding uses a tooth coloured resin that your dentist shapes directly onto the tooth, then sets firm and polishes so it blends with your natural teeth. It is used to repair small chips, close minor gaps and reshape uneven or worn edges, usually with minimal preparation of the tooth underneath. In many cases it can be done in a single visit. Bonding can chip or stain over time and may need a small repair or refresh, which your dentist will talk through with you.",
      "keyFacts": ["Usually one visit", "Tooth coloured resin", "Minimal preparation", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation", "body": "We look at the teeth you would like to change and check that bonding suits you."},
        {"title": "Shade match", "body": "Your dentist matches the resin to the colour of your natural teeth so it blends in."},
        {"title": "Shaping", "body": "The material is shaped onto the tooth and set firm, building up the area a little at a time."},
        {"title": "Polish and finish", "body": "The bonding is smoothed and polished so it feels comfortable and looks natural."}
      ]
    },
    "suitability": {
      "heading": "When composite bonding can help",
      "items": [
        {"title": "Small cosmetic changes", "body": "Bonding suits small changes to the shape, edges or colour of a tooth."},
        {"title": "One or a few teeth", "body": "It works well for tidying up one tooth or a small number of teeth at the front."},
        {"title": "Healthy teeth and gums", "body": "Bonding is added to healthy teeth, so any decay or gum concerns are treated first."},
        {"title": "Assessed case by case", "body": "A dentist checks whether bonding or another option is the right fit for you."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Composite bonding", "fromPriceGBP": 180}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How long does composite bonding take?", "a": "Many cases are completed in a single visit. Your dentist will confirm what is involved for your teeth at your consultation."},
      {"q": "Will the bonding match my teeth?", "a": "The resin is shade matched to your natural teeth, so it is shaped and polished to blend in."},
      {"q": "How long does bonding last?", "a": "Bonding can chip or stain over time and may need a small repair or refresh. Your dentist will talk you through how to look after it."},
      {"q": "Is composite bonding right for me?", "a": "Suitability depends on a clinical assessment. Book a consultation and we will talk through your options."},
      {"q": "Can I spread the cost?", "a": "Yes, 0 percent finance is available. We can go through the options with you at your visit."}
    ],
    "cta": {"label": "Book my free consultation", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'bonding'
on conflict (page_id, variant_key) do nothing;

-- Variant B: leads on the concern (chips and gaps) + minimal preparation. Identical
-- to A except the hero headline/accent/subhead and the CTA label (the A/B surface).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'b',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Composite bonding",
      "headline": "Fix chips and gaps with minimal preparation",
      "headlineAccent": "minimal preparation",
      "subhead": "A quick, gentle way to reshape your teeth at Vitality Dental, with a free initial consultation and a friendly, unrushed team.",
      "checklist": ["Tooth coloured resin", "Usually one visit", "0 percent finance available", "Free initial consultation"]
    },
    "benefits": [
      {"title": "Tooth coloured", "detail": "Bonding uses a resin matched to your natural teeth, so repairs blend in."},
      {"title": "Often one visit", "detail": "Many bonding cases are completed in a single appointment, with minimal preparation."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to make the treatment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "A chip that catches your eye", "body": "A small chip on a front tooth that you notice every time you look in the mirror."},
        {"title": "A gap you would like to close", "body": "A small space between your front teeth that shows when you smile."},
        {"title": "Edges that look worn", "body": "Tooth edges that have worn down or sit unevenly over the years."},
        {"title": "Not sure where to start", "body": "You have wondered about tidying up your smile, but never quite asked the question."}
      ],
      "reassurance": "If any of that sounds familiar, composite bonding may be a simple way to help. Here is how it works."
    },
    "about": {
      "body": "Composite bonding uses a tooth coloured resin that your dentist shapes directly onto the tooth, then sets firm and polishes so it blends with your natural teeth. It is used to repair small chips, close minor gaps and reshape uneven or worn edges, usually with minimal preparation of the tooth underneath. In many cases it can be done in a single visit. Bonding can chip or stain over time and may need a small repair or refresh, which your dentist will talk through with you.",
      "keyFacts": ["Usually one visit", "Tooth coloured resin", "Minimal preparation", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation", "body": "We look at the teeth you would like to change and check that bonding suits you."},
        {"title": "Shade match", "body": "Your dentist matches the resin to the colour of your natural teeth so it blends in."},
        {"title": "Shaping", "body": "The material is shaped onto the tooth and set firm, building up the area a little at a time."},
        {"title": "Polish and finish", "body": "The bonding is smoothed and polished so it feels comfortable and looks natural."}
      ]
    },
    "suitability": {
      "heading": "When composite bonding can help",
      "items": [
        {"title": "Small cosmetic changes", "body": "Bonding suits small changes to the shape, edges or colour of a tooth."},
        {"title": "One or a few teeth", "body": "It works well for tidying up one tooth or a small number of teeth at the front."},
        {"title": "Healthy teeth and gums", "body": "Bonding is added to healthy teeth, so any decay or gum concerns are treated first."},
        {"title": "Assessed case by case", "body": "A dentist checks whether bonding or another option is the right fit for you."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Composite bonding", "fromPriceGBP": 180}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How long does composite bonding take?", "a": "Many cases are completed in a single visit. Your dentist will confirm what is involved for your teeth at your consultation."},
      {"q": "Will the bonding match my teeth?", "a": "The resin is shade matched to your natural teeth, so it is shaped and polished to blend in."},
      {"q": "How long does bonding last?", "a": "Bonding can chip or stain over time and may need a small repair or refresh. Your dentist will talk you through how to look after it."},
      {"q": "Is composite bonding right for me?", "a": "Suitability depends on a clinical assessment. Book a consultation and we will talk through your options."},
      {"q": "Can I spread the cost?", "a": "Yes, 0 percent finance is available. We can go through the options with you at your visit."}
    ],
    "cta": {"label": "Check if bonding suits me", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'bonding'
on conflict (page_id, variant_key) do nothing;
