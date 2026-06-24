-- 0010_recall_messaging.sql
-- Recall-owned touch + outbox tables.
--
-- The shared reactivation_touch / reactivation_outbox tables have foreign keys
-- to reactivation_target / reactivation_cadence, so they cannot hold recall rows.
-- Recall therefore gets its own touch + outbox, mirroring the reactivation shape
-- (including the 0005 messaging columns to_address / provider_message_id). The
-- shared messaging drain, status webhook and inbound webhook are taught to handle
-- both. Ops-only, no clinical data.

create table if not exists recall_touch (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references recall_target (id) on delete cascade,
  cadence_id uuid references recall_cadence (id) on delete set null,
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
create index if not exists idx_recall_touch_target on recall_touch (target_id);

create table if not exists recall_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references recall_touch (id) on delete cascade,
  site_id text not null,
  channel text not null,
  to_ref text not null,
  body text not null,
  status text not null default 'queued',
  provider text,
  to_address text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_recall_outbox_msgid on recall_outbox (provider_message_id);

-- PILOT permissive RLS (mirrors 0002; replace before real data).
alter table recall_touch enable row level security;
alter table recall_outbox enable row level security;

grant all on recall_touch, recall_outbox to anon, authenticated;

create policy pilot_all_recall_touch on recall_touch for all to anon, authenticated using (true) with check (true);
create policy pilot_all_recall_outbox on recall_outbox for all to anon, authenticated using (true) with check (true);
