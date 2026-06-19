-- 0003_reactivation.sql
-- Reactivation module schema. Site-scoped, operations-only (no clinical data).
-- Reuses the shared sync_state table from 0001 (resource = 'reactivation').

create table if not exists reactivation_target (
  id text primary key,
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null,
  reason text not null,
  dentally_plan_id text,
  treatment text,
  recoverable_value numeric not null default 0,
  last_visit_at timestamptz,
  recall_due_at timestamptz,
  prior_attempts integer not null default 0,
  status text not null default 'dormant',
  reactivation_score numeric not null default 0,
  consent jsonb not null default '{}'::jsonb,
  updated_from_dentally_at timestamptz not null default now()
);
create index if not exists idx_react_target_site on reactivation_target (site_id);
create index if not exists idx_react_target_rank on reactivation_target (site_id, reactivation_score desc);

create table if not exists reactivation_cadence (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references reactivation_target (id) on delete cascade,
  site_id text not null,
  current_step integer not null default 0,
  status text not null default 'active',
  next_due_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_react_cadence_target on reactivation_cadence (target_id);
create index if not exists idx_react_cadence_due on reactivation_cadence (status, next_due_at);

create table if not exists reactivation_touch (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references reactivation_target (id) on delete cascade,
  cadence_id uuid references reactivation_cadence (id) on delete cascade,
  site_id text not null,
  step integer not null default 0,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  drafted_by text not null,
  status text not null default 'draft',
  approved_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_react_touch_target on reactivation_touch (target_id);

create table if not exists reactivation_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references reactivation_touch (id) on delete cascade,
  site_id text not null,
  channel text not null,
  to_ref text not null,
  body text not null,
  status text not null default 'queued',
  provider text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_react_outbox_touch on reactivation_outbox (touch_id);

-- Shared sync_state (created in 0001). Created here too so this migration is
-- order-independent if reactivation is ever applied before the coordinator one.
create table if not exists sync_state (
  site_id text not null,
  resource text not null,
  high_water_mark timestamptz,
  last_run_at timestamptz,
  primary key (site_id, resource)
);

-- RLS on, scoped by site_id. Real policies bind to auth once real auth lands;
-- the service role (used by the sync/sweep jobs and server actions) bypasses RLS.
alter table reactivation_target enable row level security;
alter table reactivation_cadence enable row level security;
alter table reactivation_touch enable row level security;
alter table reactivation_outbox enable row level security;
