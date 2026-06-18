-- 0001_treatment_coordinator.sql
-- Treatment Coordinator module schema. Site-scoped, operations-only (no clinical data).

create table if not exists treatment_opportunity (
  id text primary key,
  site_id text not null,
  dentally_patient_id text not null,
  dentally_plan_id text not null,
  patient_name text not null,
  treatment text not null,
  planned_value numeric not null default 0,
  amount_outstanding numeric not null default 0,
  accepted_at timestamptz,
  status text not null,
  finance_presented boolean not null default false,
  last_touch_at timestamptz,
  priority_score numeric not null default 0,
  consent jsonb not null default '{}'::jsonb,
  updated_from_dentally_at timestamptz not null default now()
);
create index if not exists idx_opp_site on treatment_opportunity (site_id);
create index if not exists idx_opp_rank on treatment_opportunity (site_id, priority_score desc);

create table if not exists coordinator_touch (
  id uuid primary key default gen_random_uuid(),
  opportunity_id text not null references treatment_opportunity (id) on delete cascade,
  site_id text not null,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  drafted_by text not null,
  status text not null default 'draft',
  approved_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_touch_opp on coordinator_touch (opportunity_id);

create table if not exists outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references coordinator_touch (id) on delete cascade,
  site_id text not null,
  channel text not null,
  to_ref text not null,
  body text not null,
  status text not null default 'queued',
  provider text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists sync_state (
  site_id text not null,
  resource text not null,
  high_water_mark timestamptz,
  last_run_at timestamptz,
  primary key (site_id, resource)
);

-- RLS on, scoped by site_id. Real policies bind to auth once real auth lands;
-- the service role (used by the sync job and server actions) bypasses RLS.
alter table treatment_opportunity enable row level security;
alter table coordinator_touch enable row level security;
alter table outbox enable row level security;
alter table sync_state enable row level security;
