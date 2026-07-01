-- 0032_onboarding_form.sql
-- Multi-form onboarding: an owner can create several NAMED onboarding forms, each with
-- its own URL-safe slug and question config, mirroring the Smile Assessment CAMPAIGN
-- pattern (0018). Each form is a shareable public link /onboard/<client>/<slug> that can
-- be sent to patients; submissions are attributed back to the form. The existing single
-- /onboard/<client> (driven by onboarding_config) stays as the default/legacy flow.
--
-- Each row carries its OWN question config as jsonb (the OnboardingConfig shape
-- {enabledKeys, required, custom}), so a form is fully self-contained. site_id anchors
-- which practice site its submissions belong to (like the campaign's site_id).
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants (all access is
-- server-only via the service-role client, like 0018/0027/0028). British English, no
-- NHS vs private framing, no dash characters in copy.

create table if not exists onboarding_form (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text not null,
  slug text not null,               -- URL-safe, unique within a client
  name text not null,               -- internal label for the form variant
  headline text,                    -- optional public hero copy
  intro text,                       -- optional public sub-copy
  config jsonb not null default '{"enabledKeys":[],"required":{},"custom":[]}'::jsonb,
  status text not null default 'active' check (status in ('active', 'paused')),
  created_by text,                  -- auth user id/email that created it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, slug)          -- no two forms share a URL within a practice
);
-- The management list + public resolve scan a client's forms (by status).
create index if not exists idx_onboarding_form_client_status on onboarding_form (client_id, status);

-- Attribute each submission to the form it came from (null for the legacy default flow).
alter table onboarding_submission add column if not exists form_id uuid;
create index if not exists idx_onboarding_submission_form on onboarding_submission (form_id, created_at desc);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0018 / 0027).
alter table onboarding_form enable row level security;

-- ---------------------------------------------------------------------------
-- Seed one demo form for the Vitality pilot so the feature shows data out of the
-- box. Empty enabledKeys means "use the default-enabled library questions", so the
-- form works immediately. Idempotent on the (client_id, slug) unique key.
-- ---------------------------------------------------------------------------
insert into onboarding_form (client_id, site_id, slug, name, headline, intro, config)
values (
  'vitality',
  'site-cc',
  'new-patients',
  'New patient registration',
  'Welcome to Vitality Dental',
  'A few quick details so we can register you and arrange your first visit.',
  '{"enabledKeys":[],"required":{},"custom":[]}'::jsonb
)
on conflict (client_id, slug) do nothing;
