-- 0061_vitality_remaining_landings.sql
-- Seed the DB records for the four remaining BESPOKE (hand-designed) Vitality Dental
-- landing pages: teeth whitening, veneers, dental implant and routine checkup.
--
-- Each public page at /go/vitality/<slug> renders a bespoke server component (all four
-- share components/landing/bespoke/vitality-treatment-landing.tsx via a thin per-slug
-- wrapper), branched to from the /go route via the bespoke registry (templateIds
-- vitality-whitening / vitality-veneers / vitality-implant / vitality-checkup). But each
-- still needs a real landing_page row so that: it appears in Growth > Landing pages with
-- Preview + A/B stats, its A/B variant is assigned + tracked exactly like every other
-- page, and its lead endpoint can confirm the page is LIVE before capturing an enquiry.
--
-- The bespoke COMPONENT does not read this content (its per-variant hero + CTA copy lives
-- in the code registry). This content exists so each row is a valid, compliant landing
-- page in its own right: both variants of every page are complete, vetted v2
-- LandingPageContent that PASS validateContent AND lintContent, priced at the real
-- catalogue figures (Teeth whitening from GBP 350, Veneers from GBP 450, Dental implant
-- from GBP 2,400, Checkup from GBP 60). No testimonials, guarantees, pain-free claims,
-- superlatives, funding words or dash characters. Finance wording appears only on the
-- three treatments the catalogue marks financeAvailable (whitening, veneers, implant);
-- checkup carries none. Each pair differs only in the hero headline/accent/subhead and
-- the CTA label between a and b, mirroring the bespoke A/B surface.
--
-- Seeded as DRAFT (not published): publishing draft to live is an explicit owner action
-- once the practice is ready to advertise each page. Idempotent on the (client_id, slug)
-- and (page_id, variant_key) unique keys, so re-running is safe. Applied as a FILE only in
-- this workstream (do NOT run here, and do NOT publish).
--
-- POST-0012 posture: RLS is already enabled on these tables (migration 0044); this
-- migration only inserts rows via the service-role migration path. British English, GBP,
-- no NHS vs private framing, no dash characters in copy.

-- ===========================================================================
-- TEETH WHITENING (from GBP 350, finance available)
-- ===========================================================================
insert into landing_page (client_id, site_id, slug, treatment, campaign_ref, status, auto_promote, created_by)
values ('vitality', 'site-cc', 'whitening', 'whitening', null, 'draft', true, 'system')
on conflict (client_id, slug) do nothing;

-- Variant A: leads on the outcome (a brighter smile, guided by a dentist).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'a',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Teeth whitening",
      "headline": "A brighter smile, guided by a dentist",
      "headlineAccent": "brighter smile",
      "subhead": "Professional teeth whitening at Vitality Dental, a dentist led way to lift everyday staining and brighten your natural teeth.",
      "checklist": ["Home or in chair", "Dentist led", "Brightens natural teeth", "0 percent finance available"]
    },
    "benefits": [
      {"title": "Dentist led", "detail": "Whitening carried out or supervised by a dentist, planned around the shade you would like."},
      {"title": "Home or in chair", "detail": "Whiten at home with custom trays, in the chair at the practice, or a combination of the two."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to help make the treatment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "Tea, coffee and red wine", "body": "Everyday cups and glasses leave your teeth looking duller than they used to."},
        {"title": "Yellow in photos", "body": "You notice the colour of your teeth in photos, and it holds you back from smiling fully."},
        {"title": "Brushing does not shift it", "body": "However well you brush at home, the shade of your teeth has not really changed."},
        {"title": "A big event coming up", "body": "A wedding, a holiday or a special occasion, and you would like a brighter smile for it."}
      ],
      "reassurance": "If any of that sounds familiar, professional whitening may help. Here is how it works."
    },
    "about": {
      "body": "Teeth whitening is a safe way to brighten your smile, carried out or supervised by a dentist. It uses a whitening gel that gently lifts the everyday staining that builds up from food, drink and time. You can whiten at home with custom trays, have an in chair treatment at the practice, or combine the two. Whitening brightens your natural teeth, and your shade can be topped up over time. It does not change the colour of fillings, crowns or veneers.",
      "keyFacts": ["Dentist led", "Home or in chair", "Brightens natural teeth", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation", "body": "We check your teeth and gums, talk through the shade you would like, and confirm whitening suits you."},
        {"title": "Custom trays or in chair", "body": "We take a scan for custom trays, or plan your in chair treatment at the practice."},
        {"title": "Whiten gradually", "body": "You whiten at home over a set period, or in the chair, building towards the shade you are after."},
        {"title": "See your result", "body": "We look over your result together and share simple tips to help keep your smile looking bright."}
      ]
    },
    "suitability": {
      "heading": "When whitening can help",
      "items": [
        {"title": "Everyday staining", "body": "For teeth dulled by tea, coffee, wine and food over time."},
        {"title": "A duller shade with age", "body": "For teeth that have lost some of their natural brightness over the years."},
        {"title": "Before an event", "body": "A brighter smile for a wedding, a holiday or a special occasion."},
        {"title": "Healthy teeth and gums", "body": "Whitening works on healthy teeth, so any decay or gum concerns are treated first."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Teeth whitening", "fromPriceGBP": 350}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "Is teeth whitening safe?", "a": "Whitening carried out or supervised by a dentist is a safe way to brighten your teeth. Your dentist checks your teeth and gums first and plans a suitable approach with you."},
      {"q": "Will whitening make my teeth sensitive?", "a": "Some people notice mild, short lived sensitivity during whitening. Tell your dentist and they can adjust the approach and suggest ways to keep you comfortable."},
      {"q": "How long do the results last?", "a": "Whitening brightens your natural teeth, and everyday food and drink can dull them again over time. Your shade can be topped up with the trays your dentist provides."},
      {"q": "Does whitening work on fillings or crowns?", "a": "Whitening brightens natural teeth but does not change the colour of fillings, crowns or veneers. Your dentist will talk through your options."}
    ],
    "cta": {"label": "Book my free consultation", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'whitening'
on conflict (page_id, variant_key) do nothing;

-- Variant B: leads on the occasion (a brighter smile before an event). Identical to A
-- except the hero headline/accent/subhead and the CTA label (the A/B surface).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'b',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Teeth whitening",
      "headline": "Brighten your smile before your big day",
      "headlineAccent": "Brighten your smile",
      "subhead": "Professional teeth whitening at Vitality Dental, planned around the shade you would like, with a free, unhurried consultation.",
      "checklist": ["Home or in chair", "Dentist led", "Brightens natural teeth", "0 percent finance available"]
    },
    "benefits": [
      {"title": "Dentist led", "detail": "Whitening carried out or supervised by a dentist, planned around the shade you would like."},
      {"title": "Home or in chair", "detail": "Whiten at home with custom trays, in the chair at the practice, or a combination of the two."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to help make the treatment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "Tea, coffee and red wine", "body": "Everyday cups and glasses leave your teeth looking duller than they used to."},
        {"title": "Yellow in photos", "body": "You notice the colour of your teeth in photos, and it holds you back from smiling fully."},
        {"title": "Brushing does not shift it", "body": "However well you brush at home, the shade of your teeth has not really changed."},
        {"title": "A big event coming up", "body": "A wedding, a holiday or a special occasion, and you would like a brighter smile for it."}
      ],
      "reassurance": "If any of that sounds familiar, professional whitening may help. Here is how it works."
    },
    "about": {
      "body": "Teeth whitening is a safe way to brighten your smile, carried out or supervised by a dentist. It uses a whitening gel that gently lifts the everyday staining that builds up from food, drink and time. You can whiten at home with custom trays, have an in chair treatment at the practice, or combine the two. Whitening brightens your natural teeth, and your shade can be topped up over time. It does not change the colour of fillings, crowns or veneers.",
      "keyFacts": ["Dentist led", "Home or in chair", "Brightens natural teeth", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation", "body": "We check your teeth and gums, talk through the shade you would like, and confirm whitening suits you."},
        {"title": "Custom trays or in chair", "body": "We take a scan for custom trays, or plan your in chair treatment at the practice."},
        {"title": "Whiten gradually", "body": "You whiten at home over a set period, or in the chair, building towards the shade you are after."},
        {"title": "See your result", "body": "We look over your result together and share simple tips to help keep your smile looking bright."}
      ]
    },
    "suitability": {
      "heading": "When whitening can help",
      "items": [
        {"title": "Everyday staining", "body": "For teeth dulled by tea, coffee, wine and food over time."},
        {"title": "A duller shade with age", "body": "For teeth that have lost some of their natural brightness over the years."},
        {"title": "Before an event", "body": "A brighter smile for a wedding, a holiday or a special occasion."},
        {"title": "Healthy teeth and gums", "body": "Whitening works on healthy teeth, so any decay or gum concerns are treated first."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Teeth whitening", "fromPriceGBP": 350}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "Is teeth whitening safe?", "a": "Whitening carried out or supervised by a dentist is a safe way to brighten your teeth. Your dentist checks your teeth and gums first and plans a suitable approach with you."},
      {"q": "Will whitening make my teeth sensitive?", "a": "Some people notice mild, short lived sensitivity during whitening. Tell your dentist and they can adjust the approach and suggest ways to keep you comfortable."},
      {"q": "How long do the results last?", "a": "Whitening brightens your natural teeth, and everyday food and drink can dull them again over time. Your shade can be topped up with the trays your dentist provides."},
      {"q": "Does whitening work on fillings or crowns?", "a": "Whitening brightens natural teeth but does not change the colour of fillings, crowns or veneers. Your dentist will talk through your options."}
    ],
    "cta": {"label": "Check if whitening suits me", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'whitening'
on conflict (page_id, variant_key) do nothing;

-- ===========================================================================
-- VENEERS (from GBP 450, finance available)
-- ===========================================================================
insert into landing_page (client_id, site_id, slug, treatment, campaign_ref, status, auto_promote, created_by)
values ('vitality', 'site-cc', 'veneers', 'veneers', null, 'draft', true, 'system')
on conflict (client_id, slug) do nothing;

-- Variant A: leads on the outcome (reshaping the smile with custom veneers).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'a',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Veneers",
      "headline": "Reshape your smile with custom veneers",
      "headlineAccent": "custom veneers",
      "subhead": "Veneers at Vitality Dental, thin covers bonded to the front of your teeth to improve their shape and colour, for a natural looking smile.",
      "checklist": ["Custom made", "Shape and colour", "Natural looking", "0 percent finance available"]
    },
    "benefits": [
      {"title": "Custom made", "detail": "Each veneer is designed around your natural features for a natural looking result."},
      {"title": "Shape and colour", "detail": "Veneers improve the shape, colour and overall look of your front teeth."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to help make the treatment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "Teeth that look worn", "body": "Front teeth that have worn down or lost their shape over the years."},
        {"title": "Discolouration that will not lift", "body": "A shade or marks on your teeth that whitening alone does not fully change."},
        {"title": "Uneven or chipped edges", "body": "Edges that look uneven, chipped or a little short when you smile."},
        {"title": "Small gaps at the front", "body": "Spaces between your front teeth that show every time you smile."}
      ],
      "reassurance": "If any of that sounds familiar, veneers may be a way to help. Here is how it works."
    },
    "about": {
      "body": "Veneers are thin covers, usually porcelain or a composite material, bonded to the front of your teeth to improve their shape, colour and overall look. They can even up worn or chipped edges, mask discolouration that whitening does not lift, close small gaps, and bring your front teeth into better proportion. Some preparation of the tooth may be needed so the veneer sits flush. Veneers are a longer term change, and your dentist will explain how to care for them.",
      "keyFacts": ["Custom made", "Shape and colour", "Natural looking", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation", "body": "We assess your teeth and gums, talk through the look you would like, and check that veneers suit you."},
        {"title": "Plan and design", "body": "Your dentist plans the shape, colour and number of veneers around your natural features."},
        {"title": "Prepare and fit", "body": "Any preparation is done, your custom veneers are made, then bonded to the front of your teeth."},
        {"title": "See your smile", "body": "We check the fit and finish together and share simple tips to help your veneers last."}
      ]
    },
    "suitability": {
      "heading": "When veneers can help",
      "items": [
        {"title": "Shape and proportion", "body": "For worn, short or uneven front teeth you would like to even up."},
        {"title": "Discolouration", "body": "For staining or marks that whitening on its own does not lift."},
        {"title": "A fuller change", "body": "When you would like a bigger change than whitening or bonding alone."},
        {"title": "Healthy teeth and gums", "body": "Veneers are added to healthy teeth, so any decay or gum concerns are treated first."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Veneers", "fromPriceGBP": 450}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How long do veneers last?", "a": "Veneers are a longer term change and can last for years with good care. Your dentist will talk through how to look after them and what to expect over time."},
      {"q": "Do veneers look natural?", "a": "Veneers are shaped and shade matched to blend with your other teeth. Your dentist plans them around your natural features so the result looks natural."},
      {"q": "Will my teeth need preparing?", "a": "Some veneers need a little preparation of the tooth so they sit flush, while others need very little. Your dentist will explain what your case involves."},
      {"q": "Can I spread the cost?", "a": "Yes, 0 percent finance is available. We can go through the options with you at your consultation."}
    ],
    "cta": {"label": "Book my free consultation", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'veneers'
on conflict (page_id, variant_key) do nothing;

-- Variant B: leads on the concern (even up chipped or worn front teeth). Identical to A
-- except the hero headline/accent/subhead and the CTA label (the A/B surface).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'b',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Veneers",
      "headline": "Even up chipped or worn front teeth",
      "headlineAccent": "chipped or worn front teeth",
      "subhead": "Custom made veneers at Vitality Dental, designed around your natural features to improve the shape and colour of your teeth.",
      "checklist": ["Custom made", "Shape and colour", "Natural looking", "0 percent finance available"]
    },
    "benefits": [
      {"title": "Custom made", "detail": "Each veneer is designed around your natural features for a natural looking result."},
      {"title": "Shape and colour", "detail": "Veneers improve the shape, colour and overall look of your front teeth."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to help make the treatment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "Teeth that look worn", "body": "Front teeth that have worn down or lost their shape over the years."},
        {"title": "Discolouration that will not lift", "body": "A shade or marks on your teeth that whitening alone does not fully change."},
        {"title": "Uneven or chipped edges", "body": "Edges that look uneven, chipped or a little short when you smile."},
        {"title": "Small gaps at the front", "body": "Spaces between your front teeth that show every time you smile."}
      ],
      "reassurance": "If any of that sounds familiar, veneers may be a way to help. Here is how it works."
    },
    "about": {
      "body": "Veneers are thin covers, usually porcelain or a composite material, bonded to the front of your teeth to improve their shape, colour and overall look. They can even up worn or chipped edges, mask discolouration that whitening does not lift, close small gaps, and bring your front teeth into better proportion. Some preparation of the tooth may be needed so the veneer sits flush. Veneers are a longer term change, and your dentist will explain how to care for them.",
      "keyFacts": ["Custom made", "Shape and colour", "Natural looking", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation", "body": "We assess your teeth and gums, talk through the look you would like, and check that veneers suit you."},
        {"title": "Plan and design", "body": "Your dentist plans the shape, colour and number of veneers around your natural features."},
        {"title": "Prepare and fit", "body": "Any preparation is done, your custom veneers are made, then bonded to the front of your teeth."},
        {"title": "See your smile", "body": "We check the fit and finish together and share simple tips to help your veneers last."}
      ]
    },
    "suitability": {
      "heading": "When veneers can help",
      "items": [
        {"title": "Shape and proportion", "body": "For worn, short or uneven front teeth you would like to even up."},
        {"title": "Discolouration", "body": "For staining or marks that whitening on its own does not lift."},
        {"title": "A fuller change", "body": "When you would like a bigger change than whitening or bonding alone."},
        {"title": "Healthy teeth and gums", "body": "Veneers are added to healthy teeth, so any decay or gum concerns are treated first."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Veneers", "fromPriceGBP": 450}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How long do veneers last?", "a": "Veneers are a longer term change and can last for years with good care. Your dentist will talk through how to look after them and what to expect over time."},
      {"q": "Do veneers look natural?", "a": "Veneers are shaped and shade matched to blend with your other teeth. Your dentist plans them around your natural features so the result looks natural."},
      {"q": "Will my teeth need preparing?", "a": "Some veneers need a little preparation of the tooth so they sit flush, while others need very little. Your dentist will explain what your case involves."},
      {"q": "Can I spread the cost?", "a": "Yes, 0 percent finance is available. We can go through the options with you at your consultation."}
    ],
    "cta": {"label": "Check if veneers suit me", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'veneers'
on conflict (page_id, variant_key) do nothing;

-- ===========================================================================
-- DENTAL IMPLANT (from GBP 2,400, finance available)
-- ===========================================================================
insert into landing_page (client_id, site_id, slug, treatment, campaign_ref, status, auto_promote, created_by)
values ('vitality', 'site-cc', 'implant', 'implant', null, 'draft', true, 'system')
on conflict (client_id, slug) do nothing;

-- Variant A: leads on the outcome (a long lasting way to replace a missing tooth).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'a',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Dental implant",
      "headline": "A long lasting way to replace a missing tooth",
      "headlineAccent": "replace a missing tooth",
      "subhead": "Dental implants at Vitality Dental, a small fixture that supports a natural looking crown, fixed in place to fill the gap.",
      "checklist": ["Long lasting", "Fixed in place", "Natural looking crown", "0 percent finance available"]
    },
    "benefits": [
      {"title": "Long lasting", "detail": "A long lasting way to replace a missing tooth, cared for like your natural teeth."},
      {"title": "Fixed in place", "detail": "An implant stays fixed in place, unlike a denture you take in and out."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to help make the treatment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "A gap when you smile", "body": "A missing tooth that shows when you smile, or that you find yourself trying to hide."},
        {"title": "Trouble chewing on one side", "body": "You favour one side when you eat because a gap or loose tooth makes chewing harder."},
        {"title": "A denture that moves", "body": "A denture that slips or feels bulky, and you would like something more secure."},
        {"title": "Wanting a fixed option", "body": "You would prefer a fixed replacement rather than something you take in and out."}
      ],
      "reassurance": "If any of that sounds familiar, a dental implant may be a way to help. Here is how it works."
    },
    "about": {
      "body": "A dental implant is a small fixture, usually titanium, placed into the jaw to replace the root of a missing tooth. Once it has healed and settled, it supports a natural looking crown that fills the gap and lets you bite and smile with confidence. Unlike a bridge, an implant does not rely on the teeth on either side, and unlike a denture it stays fixed in place. It is a long lasting way to replace a missing tooth. Your dentist plans the treatment over a few visits.",
      "keyFacts": ["Long lasting", "Fixed in place", "Natural looking crown", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation", "body": "We assess your teeth, gums and jaw, talk through your options, and check that an implant suits you."},
        {"title": "Plan and place", "body": "Your treatment is planned, then the implant is placed into the jaw at the site of the missing tooth."},
        {"title": "Heal and settle", "body": "The implant is given time to heal and settle firmly into place before the next stage."},
        {"title": "Fit your crown", "body": "A natural looking crown is made and fixed onto the implant, completing your new tooth."}
      ]
    },
    "suitability": {
      "heading": "When a dental implant can help",
      "items": [
        {"title": "A single missing tooth", "body": "To fill the gap left by one missing tooth without relying on the teeth beside it."},
        {"title": "An alternative to a denture", "body": "A fixed option for people who would rather not have a denture that moves."},
        {"title": "Chewing with confidence", "body": "A fixed replacement that lets you bite and chew more comfortably."},
        {"title": "Healthy gums and enough bone", "body": "Suitability depends on a clinical assessment of your teeth, gums and jaw."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Dental implant", "fromPriceGBP": 2400}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How long does an implant last?", "a": "An implant is a long lasting way to replace a missing tooth and can last for years with good care. Your dentist will talk through how to look after it."},
      {"q": "How long does the treatment take?", "a": "Implant treatment is carried out over a few visits, with healing time in between. Your dentist will explain the timeline for your case."},
      {"q": "Will having an implant placed be uncomfortable?", "a": "The area is numbed for the procedure and most people find it very manageable. Tell your dentist about any concerns and they will talk you through it."},
      {"q": "Can I spread the cost?", "a": "Yes, 0 percent finance is available. We can go through the options with you at your consultation."}
    ],
    "cta": {"label": "Book my free consultation", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'implant'
on conflict (page_id, variant_key) do nothing;

-- Variant B: leads on the fixed replacement. Identical to A except the hero
-- headline/accent/subhead and the CTA label (the A/B surface).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'b',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Dental implant",
      "headline": "Replace a missing tooth, fixed in place",
      "headlineAccent": "fixed in place",
      "subhead": "Dental implants at Vitality Dental, a long lasting way to replace a missing tooth with a natural looking crown that stays fixed in place.",
      "checklist": ["Long lasting", "Fixed in place", "Natural looking crown", "0 percent finance available"]
    },
    "benefits": [
      {"title": "Long lasting", "detail": "A long lasting way to replace a missing tooth, cared for like your natural teeth."},
      {"title": "Fixed in place", "detail": "An implant stays fixed in place, unlike a denture you take in and out."},
      {"title": "Spread the cost", "detail": "0 percent finance is available to help make the treatment more manageable."}
    ],
    "painPoints": {
      "items": [
        {"title": "A gap when you smile", "body": "A missing tooth that shows when you smile, or that you find yourself trying to hide."},
        {"title": "Trouble chewing on one side", "body": "You favour one side when you eat because a gap or loose tooth makes chewing harder."},
        {"title": "A denture that moves", "body": "A denture that slips or feels bulky, and you would like something more secure."},
        {"title": "Wanting a fixed option", "body": "You would prefer a fixed replacement rather than something you take in and out."}
      ],
      "reassurance": "If any of that sounds familiar, a dental implant may be a way to help. Here is how it works."
    },
    "about": {
      "body": "A dental implant is a small fixture, usually titanium, placed into the jaw to replace the root of a missing tooth. Once it has healed and settled, it supports a natural looking crown that fills the gap and lets you bite and smile with confidence. Unlike a bridge, an implant does not rely on the teeth on either side, and unlike a denture it stays fixed in place. It is a long lasting way to replace a missing tooth. Your dentist plans the treatment over a few visits.",
      "keyFacts": ["Long lasting", "Fixed in place", "Natural looking crown", "0 percent finance available", "Free initial consultation"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Consultation", "body": "We assess your teeth, gums and jaw, talk through your options, and check that an implant suits you."},
        {"title": "Plan and place", "body": "Your treatment is planned, then the implant is placed into the jaw at the site of the missing tooth."},
        {"title": "Heal and settle", "body": "The implant is given time to heal and settle firmly into place before the next stage."},
        {"title": "Fit your crown", "body": "A natural looking crown is made and fixed onto the implant, completing your new tooth."}
      ]
    },
    "suitability": {
      "heading": "When a dental implant can help",
      "items": [
        {"title": "A single missing tooth", "body": "To fill the gap left by one missing tooth without relying on the teeth beside it."},
        {"title": "An alternative to a denture", "body": "A fixed option for people who would rather not have a denture that moves."},
        {"title": "Chewing with confidence", "body": "A fixed replacement that lets you bite and chew more comfortably."},
        {"title": "Healthy gums and enough bone", "body": "Suitability depends on a clinical assessment of your teeth, gums and jaw."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Dental implant", "fromPriceGBP": 2400}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How long does an implant last?", "a": "An implant is a long lasting way to replace a missing tooth and can last for years with good care. Your dentist will talk through how to look after it."},
      {"q": "How long does the treatment take?", "a": "Implant treatment is carried out over a few visits, with healing time in between. Your dentist will explain the timeline for your case."},
      {"q": "Will having an implant placed be uncomfortable?", "a": "The area is numbed for the procedure and most people find it very manageable. Tell your dentist about any concerns and they will talk you through it."},
      {"q": "Can I spread the cost?", "a": "Yes, 0 percent finance is available. We can go through the options with you at your consultation."}
    ],
    "cta": {"label": "Check if an implant suits me", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'implant'
on conflict (page_id, variant_key) do nothing;

-- ===========================================================================
-- ROUTINE CHECKUP (from GBP 60, NO finance)
-- ===========================================================================
insert into landing_page (client_id, site_id, slug, treatment, campaign_ref, status, auto_promote, created_by)
values ('vitality', 'site-cc', 'checkup', 'checkup', null, 'draft', true, 'system')
on conflict (client_id, slug) do nothing;

-- Variant A: leads on the outcome (a healthy smile). No finance wording (checkup has none).
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'a',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Dental checkup",
      "headline": "A healthy smile starts with a checkup",
      "headlineAccent": "a checkup",
      "subhead": "A routine dental checkup with the dentist at Vitality Dental. We check your teeth and gums and catch anything early.",
      "checklist": ["With the dentist", "Teeth and gums checked", "Same week appointments", "Advice you can use"]
    },
    "benefits": [
      {"title": "With the dentist", "detail": "A thorough look at your teeth, gums and mouth to check everything is healthy."},
      {"title": "Catch things early", "detail": "The dentist can spot early signs of decay or gum problems before they grow."},
      {"title": "Seen quickly", "detail": "Same week checkup appointments are usually available when you need one."}
    ],
    "painPoints": {
      "items": [
        {"title": "It has been a while", "body": "Longer than you would like since you last saw a dentist for a checkup."},
        {"title": "A niggle you are unsure about", "body": "A twinge, a sensitive spot, or something that does not feel quite right."},
        {"title": "New to the area", "body": "You have moved and have not found a regular dentist yet."},
        {"title": "Want peace of mind", "body": "You would simply like to know that your teeth and gums are healthy."}
      ],
      "reassurance": "If any of that sounds familiar, a routine checkup can help. Here is how a visit works."
    },
    "about": {
      "body": "A dental checkup is a routine examination with the dentist. They look over your teeth, gums and mouth to check everything is healthy, and to spot early signs of decay, gum problems or wear before they grow. The dentist may take X-rays if needed and talk through anything they find, including whether a hygiene visit would help. Seeing the dentist regularly keeps your teeth and gums healthy and catches problems while they are still small.",
      "keyFacts": ["With the dentist", "Teeth, gums and mouth checked", "X-rays if needed", "Same week appointments usually", "Advice you can use"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Book your visit", "body": "Get in touch and we will find you a checkup appointment, often within the same week."},
        {"title": "A friendly chat", "body": "The dentist asks how you have been getting on and about anything you have noticed."},
        {"title": "The examination", "body": "The dentist checks your teeth, gums and mouth, and takes X-rays if they are needed."},
        {"title": "Your plan", "body": "You talk through anything found, and any treatment or hygiene visit that would help."}
      ]
    },
    "suitability": {
      "heading": "When a checkup helps",
      "items": [
        {"title": "Regular upkeep", "body": "A routine visit to keep an eye on your teeth and gums and catch things early."},
        {"title": "A niggle to check", "body": "When something does not feel quite right and you would like it looked at."},
        {"title": "New to the area", "body": "When you have moved and would like to register with a regular dentist."},
        {"title": "Peace of mind", "body": "When you would simply like to know your teeth and gums are healthy."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Checkup", "fromPriceGBP": 60}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed before your appointment goes ahead."},
    "faqs": [
      {"q": "How often should I have a checkup?", "a": "Many people come every six months, though the dentist may suggest more or less often depending on your teeth and gums. They will recommend what suits you."},
      {"q": "What happens at a checkup?", "a": "The dentist looks over your teeth, gums and mouth, may take X-rays if needed, and talks through anything they find and what would help."},
      {"q": "How long does a checkup take?", "a": "Most checkups take around thirty minutes. The dentist will let you know if you need any follow up."},
      {"q": "Can I have a checkup and a clean together?", "a": "A checkup with the dentist and a hygiene visit work well together. The team can talk through booking both when you get in touch."}
    ],
    "cta": {"label": "Book my checkup", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'checkup'
on conflict (page_id, variant_key) do nothing;

-- Variant B: leads on prevention (catch small things early). Identical to A except the
-- hero headline/accent/subhead and the CTA label (the A/B surface). No finance wording.
insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'b',
  '{
    "version": "2",
    "hero": {
      "eyebrow": "Dental checkup",
      "headline": "Catch small things early with a checkup",
      "headlineAccent": "Catch small things early",
      "subhead": "A routine dental checkup with the dentist at Vitality Dental, usually about thirty minutes. We check your teeth and gums and catch anything early.",
      "checklist": ["With the dentist", "Teeth and gums checked", "Same week appointments", "Advice you can use"]
    },
    "benefits": [
      {"title": "With the dentist", "detail": "A thorough look at your teeth, gums and mouth to check everything is healthy."},
      {"title": "Catch things early", "detail": "The dentist can spot early signs of decay or gum problems before they grow."},
      {"title": "Seen quickly", "detail": "Same week checkup appointments are usually available when you need one."}
    ],
    "painPoints": {
      "items": [
        {"title": "It has been a while", "body": "Longer than you would like since you last saw a dentist for a checkup."},
        {"title": "A niggle you are unsure about", "body": "A twinge, a sensitive spot, or something that does not feel quite right."},
        {"title": "New to the area", "body": "You have moved and have not found a regular dentist yet."},
        {"title": "Want peace of mind", "body": "You would simply like to know that your teeth and gums are healthy."}
      ],
      "reassurance": "If any of that sounds familiar, a routine checkup can help. Here is how a visit works."
    },
    "about": {
      "body": "A dental checkup is a routine examination with the dentist. They look over your teeth, gums and mouth to check everything is healthy, and to spot early signs of decay, gum problems or wear before they grow. The dentist may take X-rays if needed and talk through anything they find, including whether a hygiene visit would help. Seeing the dentist regularly keeps your teeth and gums healthy and catches problems while they are still small.",
      "keyFacts": ["With the dentist", "Teeth, gums and mouth checked", "X-rays if needed", "Same week appointments usually", "Advice you can use"]
    },
    "howItWorks": {
      "steps": [
        {"title": "Book your visit", "body": "Get in touch and we will find you a checkup appointment, often within the same week."},
        {"title": "A friendly chat", "body": "The dentist asks how you have been getting on and about anything you have noticed."},
        {"title": "The examination", "body": "The dentist checks your teeth, gums and mouth, and takes X-rays if they are needed."},
        {"title": "Your plan", "body": "You talk through anything found, and any treatment or hygiene visit that would help."}
      ]
    },
    "suitability": {
      "heading": "When a checkup helps",
      "items": [
        {"title": "Regular upkeep", "body": "A routine visit to keep an eye on your teeth and gums and catch things early."},
        {"title": "A niggle to check", "body": "When something does not feel quite right and you would like it looked at."},
        {"title": "New to the area", "body": "When you have moved and would like to register with a regular dentist."},
        {"title": "Peace of mind", "body": "When you would simply like to know your teeth and gums are healthy."}
      ]
    },
    "pricing": {"lines": [{"treatment": "Checkup", "fromPriceGBP": 60}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed before your appointment goes ahead."},
    "faqs": [
      {"q": "How often should I have a checkup?", "a": "Many people come every six months, though the dentist may suggest more or less often depending on your teeth and gums. They will recommend what suits you."},
      {"q": "What happens at a checkup?", "a": "The dentist looks over your teeth, gums and mouth, may take X-rays if needed, and talks through anything they find and what would help."},
      {"q": "How long does a checkup take?", "a": "Most checkups take around thirty minutes. The dentist will let you know if you need any follow up."},
      {"q": "Can I have a checkup and a clean together?", "a": "A checkup with the dentist and a hygiene visit work well together. The team can talk through booking both when you get in touch."}
    ],
    "cta": {"label": "Book a checkup appointment", "target": "booking", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'checkup'
on conflict (page_id, variant_key) do nothing;
