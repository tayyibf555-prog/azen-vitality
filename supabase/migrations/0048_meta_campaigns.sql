-- 0048_meta_campaigns.sql
-- Meta (Facebook / Instagram) ad CAMPAIGN DRAFTS assembled by the owner co-pilot.
--
-- The co-pilot's create_meta_campaign tool assembles a compliant campaign from the
-- owner's stated details (objective, treatment, radius, daily budget, audience,
-- negative keywords, optional transparent from-price) plus AI-generated, compliance-
-- linted ad copy, and stores it here as a DRAFT that is READY to publish. Actual
-- publishing to Meta is NOT done here: it needs the client's Meta account connected
-- (blocked on the client's Meta business login) and is a separate, explicitly-
-- confirmed step (publish_meta_campaign). So a row NEVER means "live on Meta"; the
-- status stays 'draft' until a real Meta publish adapter exists.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access is
-- server-only via the service-role client (like 0018 / 0032 / 0041 / 0044). British
-- English, GBP, no NHS vs private framing, no dash characters in copy.

create table if not exists meta_campaign (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text,                       -- practice site the leads belong to (nullable)
  name text not null,
  treatment text not null,            -- catalogue treatment key, or a free-text focus
  objective text not null default 'leads'
    check (objective in ('awareness', 'leads', 'traffic', 'engagement', 'retargeting')),
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'published')),
  radius_miles numeric,               -- targeting radius the owner stated (nullable)
  daily_budget_gbp numeric,           -- daily budget in GBP the owner stated (nullable)
  audience_notes text,                -- plain-English audience notes from the owner
  transparent_pricing boolean not null default false,
  from_price_gbp numeric,             -- the REAL catalogue from-price shown (when transparent)
  negative_keywords jsonb not null default '[]'::jsonb,  -- string[] the owner excluded
  landing_slug text,                  -- attached landing page slug (loose ref, NOT a FK)
  copy jsonb not null,                -- {headline, primaryText, description, cta, complianceNote}
  created_by text,                    -- auth user id/email that created it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The co-pilot looks a campaign up by id (publish); a future list view reads by
-- (client, status). Index the list access path.
create index if not exists idx_meta_campaign_client_status on meta_campaign (client_id, status);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0032 / 0044).
alter table meta_campaign enable row level security;
