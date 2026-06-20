-- 0006_booking_agent.sql
-- Conversational booking agent state. Ops-only, no clinical data.

create table if not exists agent_conversation (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null,
  channel text not null default 'sms',
  status text not null default 'active',          -- active | needs_human | booked | closed
  treatment text,
  funding_type text,                              -- nhs | private | null
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_agent_conv_patient on agent_conversation (site_id, dentally_patient_id, channel);

create table if not exists agent_message (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references agent_conversation (id) on delete cascade,
  role text not null,                             -- patient | agent | system | tool
  body text not null,
  tool_name text,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_msg_conv on agent_message (conversation_id, created_at);

alter table agent_conversation enable row level security;
alter table agent_message enable row level security;

-- PILOT permissive RLS (mirrors prior migrations; replace before real data).
grant all on agent_conversation, agent_message to anon, authenticated;
create policy pilot_all_agent_conv on agent_conversation for all to anon, authenticated using (true) with check (true);
create policy pilot_all_agent_msg on agent_message for all to anon, authenticated using (true) with check (true);
