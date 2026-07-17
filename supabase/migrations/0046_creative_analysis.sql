-- 0046_creative_analysis.sql
-- Cache of AI CREATIVE ANALYSES for the Meta Ads "winning ads" library.
--
-- Clicking a library creative opens a detail view with an AI overview (an overall
-- score and verdict, six factor scores, why-it-works bullets and compliance
-- watch-outs) plus a rough cost-per-lead range. Generating that overview spends a
-- model call, and the same creative is opened repeatedly, so we cache one analysis
-- per (client, creative). A regenerate action forces a fresh one, overwriting the
-- row. The analysis payload is a fixed-shape jsonb object assembled server-side:
-- the model contributes only the qualitative factors and prose; the score, verdict,
-- longevity signal, cost-per-lead range and compliance flags are computed in code.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access is
-- server-only via the service-role client (like 0032 / 0044). British English, GBP,
-- no dash characters in copy.

create table if not exists creative_analysis (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,            -- practice the analysis belongs to
  creative_ref text not null,         -- the library creative id (mock today, live Ad Library later)
  analysis jsonb not null,            -- the assembled, validated CreativeAnalysis object
  model text not null,                -- the model id used, or 'deterministic' for a Quick read
  created_at timestamptz not null default now(),
  unique (client_id, creative_ref)    -- one cached analysis per creative per practice
);
-- The read path looks up by (client, creative); the unique constraint already
-- indexes this. The explicit index documents the access path (consistent with 0044).
create index if not exists idx_creative_analysis_client_ref
  on creative_analysis (client_id, creative_ref);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0032 / 0044).
alter table creative_analysis enable row level security;
