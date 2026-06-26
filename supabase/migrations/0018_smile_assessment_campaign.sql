-- 0018_smile_assessment_campaign.sql
-- Smile Assessment CAMPAIGNS: the practice owner creates a named assessment that
-- targets a specific goal (treatment focus), ideal customer and budget band, and
-- gets a custom public URL (/assess/<client>/<slug>) to use as an ad destination.
-- The quiz scoring and the AI first-contact tune to the campaign's goal/budget so
-- "high / ideal fit" reflects what the owner is actually trying to book.
--
-- Created in the POST-0012 locked posture: RLS enabled, NO grants/policies for
-- anon/authenticated. The public landing reads a campaign via a service-role GET
-- that returns ONLY safe public fields; the internal CRUD is requireUser +
-- site/client-scoped. All access is server-only, like every other table now.

-- One row per owner-created assessment campaign.
create table if not exists smile_assessment_campaign (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,                  -- the practice/client that owns it
  site_id text not null,                    -- the site responses are attributed to
  slug text not null,                       -- URL-safe; unique within a client
  name text not null,                       -- internal label for the worklist
  goal text not null,                       -- treatment-focus key (invisalign|implants|veneers|whitening|hygiene|general)
  goal_note text,                           -- optional free-text goal description
  ideal_customer text,                      -- optional persona, tailors the AI opener
  target_budget text not null default 'any',-- ready | finance | flexible | any
  headline text,                            -- optional public hero copy
  intro text,                               -- optional public sub-copy
  status text not null default 'active',    -- active | paused
  created_by text,                          -- auth user id/email that created it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, slug)
);
create index if not exists idx_smile_campaign_client_status
  on smile_assessment_campaign (client_id, status);

-- Attribute each response to the campaign it came through (null = the generic
-- /assess/<client> quiz). Soft link (no FK) so the modules stay decoupled, exactly
-- like lead_id on this table.
alter table smile_assessment_response
  add column if not exists campaign_id uuid;
create index if not exists idx_smile_assessment_campaign_created
  on smile_assessment_response (campaign_id, created_at);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012).
alter table smile_assessment_campaign enable row level security;
