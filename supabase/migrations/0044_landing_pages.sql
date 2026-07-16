-- 0044_landing_pages.sql
-- AI-generated campaign LANDING PAGES with two-variant split testing.
--
-- An owner ticks "custom landing page" while setting up a Meta ad campaign; the
-- system generates two content variants (A/B) for a vetted template. Visitors to
-- the public URL /go/<client>/<slug> are split 50/50 (sticky per visitor), results
-- per variant are measured, and a winner can be promoted (manually, or auto once
-- both variants have a fair sample). Each variant's content is a fixed-shape jsonb
-- object rendered by ONE vetted server component, and every variant passes a
-- deterministic compliance lint (no testimonials, guarantees, pain-free claims,
-- superlatives or NHS/private/funding wording) with prices cross-checked against
-- the real treatment catalogue before it is stored.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client (like 0018 / 0027 / 0032). British
-- English, GBP, no NHS vs private framing, no dash characters in copy.

create table if not exists landing_page (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text,                       -- practice site the leads belong to (nullable)
  slug text not null,                 -- URL-safe, unique within a client (/go/<client>/<slug>)
  treatment text not null,            -- catalogue treatment key (drives pricing + defaults)
  campaign_ref text,                  -- loose ref to a Meta Ads campaign (NOT a foreign key)
  status text not null default 'draft' check (status in ('draft', 'live', 'archived')),
  winner_variant text check (winner_variant in ('a', 'b')),  -- null while both run
  auto_promote boolean not null default true,
  created_by text,                    -- auth user id/email that created it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, slug)            -- no two pages share a URL within a practice
);
-- The management list + public resolve look up by (client, slug). The unique
-- constraint already indexes this; the explicit index documents the access path.
create index if not exists idx_landing_page_client_slug on landing_page (client_id, slug);
create index if not exists idx_landing_page_client_status on landing_page (client_id, status);

create table if not exists landing_page_variant (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references landing_page (id) on delete cascade,
  variant_key text not null check (variant_key in ('a', 'b')),
  content jsonb not null,             -- the vetted, lint-passed content object
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  unique (page_id, variant_key)       -- one row per variant per page
);
create index if not exists idx_landing_page_variant_page on landing_page_variant (page_id);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0032).
alter table landing_page enable row level security;
alter table landing_page_variant enable row level security;

-- ---------------------------------------------------------------------------
-- Seed one LIVE demo landing page for the Vitality pilot so the feature shows a
-- real, servable example out of the box (/go/vitality/invisalign-demo). Both
-- variants are hand-written to pass the compliance lint: the price is the real
-- catalogue price (Invisalign from £2,500), and the copy carries no testimonials,
-- guarantees, pain claims, superlatives or funding wording. Idempotent on the
-- (client_id, slug) unique key.
-- ---------------------------------------------------------------------------
insert into landing_page (client_id, site_id, slug, treatment, campaign_ref, status, auto_promote)
values ('vitality', 'site-cc', 'invisalign-demo', 'invisalign', null, 'live', true)
on conflict (client_id, slug) do nothing;

insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'a',
  '{
    "hero": {"headline": "Straighten your smile with Invisalign", "subhead": "Clear, removable aligners that gently guide your teeth into place, with a free initial consultation."},
    "benefits": [
      {"title": "Barely there", "detail": "Clear aligners that most people will not notice you are wearing day to day."},
      {"title": "Removable", "detail": "Take them out to eat, brush and floss, so your daily routine stays simple."},
      {"title": "A confident smile", "detail": "A straighter smile you can feel good about sharing."}
    ],
    "pricing": {"lines": [{"treatment": "Invisalign", "fromPriceGBP": 2500}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How long does treatment take?", "a": "It varies from person to person. Your dentist will talk you through a likely timeline at your consultation."},
      {"q": "Is Invisalign right for me?", "a": "Suitability depends on a clinical assessment. Book a consultation and we will explain your options."},
      {"q": "Can I spread the cost?", "a": "Yes, 0 percent finance is available. We can go through the options with you at your visit."}
    ],
    "cta": {"label": "Check your options", "target": "assessment", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'invisalign-demo'
on conflict (page_id, variant_key) do nothing;

insert into landing_page_variant (page_id, variant_key, content, status)
select p.id, 'b',
  '{
    "hero": {"headline": "Invisalign with 0 percent finance", "subhead": "Straighten your teeth with clear aligners and spread the cost, starting with a free consultation."},
    "benefits": [
      {"title": "Spread the cost", "detail": "0 percent finance is available to make the investment manageable."},
      {"title": "Free first step", "detail": "Start with a free initial consultation to see if it suits you."},
      {"title": "Clear and removable", "detail": "Discreet aligners you take out to eat, brush and floss."}
    ],
    "pricing": {"lines": [{"treatment": "Invisalign", "fromPriceGBP": 2500}], "caveat": "Prices shown are a guide and start from the amount listed. Your exact price is confirmed after a clinical assessment."},
    "faqs": [
      {"q": "How much does it cost?", "a": "Invisalign starts from £2,500. Your exact price is confirmed after a clinical assessment."},
      {"q": "Can I pay monthly?", "a": "Yes, 0 percent finance is available. We can talk through the options at your visit."},
      {"q": "What is the first step?", "a": "A free initial consultation, where we check your teeth and explain what is possible."}
    ],
    "cta": {"label": "See if you qualify", "target": "assessment", "targetSlug": null}
  }'::jsonb,
  'active'
from landing_page p
where p.client_id = 'vitality' and p.slug = 'invisalign-demo'
on conflict (page_id, variant_key) do nothing;
