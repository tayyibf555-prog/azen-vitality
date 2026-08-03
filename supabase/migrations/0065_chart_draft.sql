-- 0065_chart_draft.sql
-- A clinician's in-progress SELECTION on the FDI charting screen.
--
-- ============================================================================
-- WRITTEN BUT NOT APPLIED, AND THAT IS THE POINT OF THIS HEADER.
--
-- THIS TABLE IS NOT A CLINICAL RECORD AND IS NEVER SENT TO DENTALLY. Dentally
-- publishes no create route on any charting resource (a POST 404s on all five),
-- and their terms forbid a custom bridge, so the charting screen is a READ-ONLY
-- MIRROR: it renders /v1/treatment_plan_items and writes nothing back. Nothing
-- in this table mirrors, shadows or supersedes a Dentally row.
--
-- WHAT IT WOULD BE FOR: letting a dentist mark surfaces on screen while talking
-- to a patient, before typing the same thing into Dentally. Useful, and also the
-- exact shape of the outcome DENTALLY.md names as the worst available — two
-- sources of truth for clinical data. From the first day two people use two
-- systems, one of them is wrong and neither knows which.
--
-- SO THE FEATURE IS BUILT AND SWITCHED OFF. isChartDraftEnabled() reads
-- CHART_DRAFT_ENABLED and defaults FALSE; with it unset the route returns 503
-- with an explanation and the chart renders no draft surface at all. Turning it
-- on is the practice manager's decision, in writing, not this migration's and not
-- a developer's. Do not apply this file to demonstrate the feature.
-- ============================================================================
--
-- RLS is enabled with NO policy and NO grant, matching 0064's posture: every read
-- and write goes through serviceClient() on the server, behind requireUser plus
-- the client, site and patient-belongs-to-site checks in
-- src/app/api/charting/draft/route.ts. A table with RLS on and no policy is
-- unreachable by any anon or authenticated key, which is the intent.

create table if not exists public.chart_draft (
  id                  uuid primary key default gen_random_uuid(),
  site_id             text not null,
  dentally_patient_id text not null,
  -- FDI two-digit notation (11-48 permanent, 51-85 deciduous). smallint because
  -- the value space is tiny and fixed; the ROUTE validates it against the arch
  -- before it ever gets here, so an out-of-range tooth is refused with a sentence
  -- rather than by a constraint violation a receptionist cannot read.
  tooth_fdi           smallint not null,
  -- The canonical serialised surface code, e.g. "MOD". Written from, and re-parsed
  -- through, the one canonicaliser, so a row can never hold an order the reducer
  -- would not produce ("DMO" is not a thing).
  surfaces            text not null,
  treatment_code      text not null,
  treatment_name      text,
  dentition           text not null check (dentition in ('permanent', 'deciduous')),
  created_at          timestamptz not null default now(),
  created_by          text,
  updated_at          timestamptz
);

-- One entry per treatment per tooth, so re-saving a tooth is an upsert rather than
-- an accumulating pile of near-duplicate rows. A tooth can still carry several
-- DIFFERENT treatments, which is how real charting works.
create unique index if not exists chart_draft_entry_uniq
  on public.chart_draft (site_id, dentally_patient_id, tooth_fdi, treatment_code);

-- The only read this table has: "this patient's draft, in this site".
create index if not exists chart_draft_lookup_idx
  on public.chart_draft (site_id, dentally_patient_id);

alter table public.chart_draft enable row level security;
