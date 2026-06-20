-- 0007_agent_settings.sql
-- Per-site booking agent settings (changeable from the owner dashboard).

create table if not exists agent_settings (
  site_id text primary key,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table agent_settings enable row level security;

-- PILOT permissive RLS (mirrors prior migrations; replace before real data).
grant all on agent_settings to anon, authenticated;
create policy pilot_all_agent_settings on agent_settings for all to anon, authenticated using (true) with check (true);
