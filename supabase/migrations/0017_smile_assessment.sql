-- 0017_smile_assessment.sql
-- Smile Assessment: an embeddable qualifying quiz that scores each enquiry on
-- INTENT and FIT only (treatment interest, timeline, budget readiness, location)
-- and NEVER on clinical suitability. High scorers are fast-tracked into the
-- Speed-to-lead pipeline (a lead is created and contacted instantly); low and
-- medium scorers are recorded for nurture.
--
-- Created in the POST-0012 locked posture: RLS is enabled but NO grants/policies
-- are issued to anon/authenticated (0012 revoked those across the schema). The
-- public submit endpoint validates + rate-limits server-side and writes via the
-- service-role client; the internal list is requireUser + site-scoped. All
-- access is server-only, like every other table now.

-- One row per quiz submission.
create table if not exists smile_assessment_response (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  -- The Speed-to-lead lead created for a high scorer (null for medium/low, or if
  -- no contact channel was supplied). Soft link: no FK so the modules stay decoupled.
  lead_id uuid,
  first_name text not null,
  email text,
  phone text,
  channel text,                              -- preferred reply channel: sms | email | whatsapp
  treatment_interest text,                   -- denormalised from the selected answer for the worklist
  responses jsonb not null default '{}'::jsonb,
  raw_score integer not null,                -- 0-100, intent/fit only
  band text not null,                        -- high | medium | low
  source text not null default 'quiz',
  created_at timestamptz not null default now()
);
create index if not exists idx_smile_assessment_site_created
  on smile_assessment_response (site_id, created_at);
create index if not exists idx_smile_assessment_site_band_created
  on smile_assessment_response (site_id, band, created_at);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012).
alter table smile_assessment_response enable row level security;
