-- 0053_creative_renders.sql
-- Persistence for the "recreate this ad with your branding" feature (Meta Ads,
-- Creative Intelligence drawer).
--
-- An owner can take a winning creative from the ad library and ask the platform to
-- produce an on-brand still via Higgsfield (see lib/higgsfield/client.ts). Each
-- attempt is recorded here: the exact prompt we sent (built from the practice's REAL
-- facts, never invented claims), the status, and the resulting image URL when it
-- completes. This gives the drawer a "Renders" history per practice and keeps an
-- honest audit of what was asked for, even before the HIGGSFIELD_API_KEY is present
-- (a not_configured row is still written so the history is truthful).
--
-- SHIPS DORMANT: the image call activates when HIGGSFIELD_API_KEY lands. Until then
-- every attempt records status 'not_configured' with a clear message and no image.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access is
-- server-only via the service-role client (like 0032 / 0044 / 0046). British English,
-- GBP, no dash characters in copy.

create table if not exists creative_render (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,                       -- practice the render belongs to
  source_ref text,                               -- the library creative id it was recreated from (nullable)
  prompt text not null,                          -- the exact, lint-passed prompt sent to Higgsfield
  status text not null default 'pending'
    check (status in ('pending', 'complete', 'failed', 'not_configured')),
  image_url text,                                -- the generated image URL, when status = 'complete'
  error text,                                    -- the honest failure reason, when status = 'failed'
  created_by text,                               -- the user id that requested it (when auth is enforced)
  created_at timestamptz not null default now()
);

-- The drawer lists a practice's renders newest first; this index documents and
-- serves that access path (consistent with 0044 / 0046).
create index if not exists idx_creative_render_client_created
  on creative_render (client_id, created_at desc);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0046).
alter table creative_render enable row level security;
