-- 0009_recall_concierge.sql
-- Recall concierge module: the PROACTIVE front end of the recall lifecycle.
-- Site-scoped, operations-only (no clinical data).
--
-- Scope vs reactivation: this module owns recalls that are due soon (within a
-- lead window) through up to the grace boundary overdue. Reactivation's
-- overdue_recall cohort owns recalls past the grace boundary. The two never
-- target the same recall in steady state.
--
-- OUTBOX REUSE: recall deliberately reuses reactivation_outbox + reactivation_touch
-- for sends, so the shared messaging drain, status webhook and suppression work
-- untouched. Only the target + cadence are recall-specific. Those shared tables
-- must already exist before this migration runs.
--
-- This file is the authoritative DDL for the recall tables. Like the reactivation
-- tables, it is applied manually in Supabase for the pilot.

create table if not exists recall_target (
  id text primary key,                         -- `${siteId}:${dentallyPatientId}:${recallType}`
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null,
  recall_type text not null check (recall_type in ('dentist', 'hygienist')),
  due_at timestamptz not null,                 -- the recall date the clinician set
  overdue_days integer not null default 0,     -- (now - due_at) in days; negative = due soon
  last_visit_at timestamptz,
  prior_attempts integer not null default 0,
  status text not null default 'due',          -- due | in_cadence | converted | exhausted | graduated
  consent jsonb not null default '{}'::jsonb,
  updated_from_dentally_at timestamptz not null default now()
);
create index if not exists idx_recall_target_site on recall_target (site_id);
create index if not exists idx_recall_target_site_due on recall_target (site_id, due_at);

create table if not exists recall_cadence (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references recall_target (id) on delete cascade,
  site_id text not null,
  current_step integer not null default 0,     -- last completed step; 0 = enrolled, none sent
  status text not null default 'active',       -- active | paused | converted | exhausted
  next_due_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_recall_cadence_target on recall_cadence (target_id);
create index if not exists idx_recall_cadence_due on recall_cadence (status, next_due_at);

-- PILOT ONLY. Permissive RLS so the public (anon/publishable) key can read/write
-- the recall tables before real Supabase auth + per-site policies exist.
--
-- SECURITY: this is a deliberate, temporary shortcut for the pilot demo, which
-- runs on mock/fixture data only. REPLACE every policy below with auth-bound,
-- site-scoped policies before any real patient data or production deployment.
alter table recall_target enable row level security;
alter table recall_cadence enable row level security;

grant all on recall_target, recall_cadence to anon, authenticated;

create policy pilot_all_recall_target on recall_target for all to anon, authenticated using (true) with check (true);
create policy pilot_all_recall_cadence on recall_cadence for all to anon, authenticated using (true) with check (true);
