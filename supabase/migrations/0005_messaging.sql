-- 0005_messaging.sql
-- Local opt-out suppression + outbox send-tracking columns. Ops-only, no clinical data.

create table if not exists message_suppression (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  channel text not null,
  to_ref text not null,
  reason text not null default 'stop',
  created_at timestamptz not null default now(),
  unique (site_id, channel, to_ref)
);
create index if not exists idx_suppression_lookup on message_suppression (site_id, channel, to_ref);

alter table reactivation_outbox add column if not exists to_address text;
alter table reactivation_outbox add column if not exists provider_message_id text;
create index if not exists idx_react_outbox_msgid on reactivation_outbox (provider_message_id);

alter table message_suppression enable row level security;

-- PILOT permissive RLS (mirrors 0004; replace before real data).
grant all on message_suppression to anon, authenticated;
create policy pilot_all_suppression on message_suppression for all to anon, authenticated using (true) with check (true);
