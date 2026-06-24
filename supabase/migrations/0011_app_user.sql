-- 0011_app_user.sql
-- Application user profiles for real auth: maps a Supabase Auth user (by email)
-- to their role + client. Replaces the localStorage mock auth.
--
-- During the auth transition this follows the same permissive-pilot pattern as
-- the other tables (readable via the public key). Migration 0012 locks every
-- table down to server-only once SUPABASE_SERVICE_ROLE_KEY is set.

create table if not exists app_user (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  role text not null check (role in ('agency_admin', 'client_owner', 'client_coordinator')),
  client_id text,                 -- null for agency_admin (spans all clients)
  created_at timestamptz not null default now()
);

alter table app_user enable row level security;
grant all on app_user to anon, authenticated;
create policy pilot_all_app_user on app_user for all to anon, authenticated using (true) with check (true);

-- Seed the pilot users (emails match the previous mock users). The matching
-- Supabase Auth accounts (with passwords) are created separately; the session
-- resolver links them to this profile by email.
insert into app_user (email, name, role, client_id) values
  ('tayyib@azen.ai', 'Tayyib Arbab', 'agency_admin', null),
  ('jawad@vitalitydental.co.uk', 'Jawad Khursheed', 'client_owner', 'vitality'),
  ('aisha@vitalitydental.co.uk', 'Aisha Rahman', 'client_coordinator', 'vitality')
on conflict (email) do nothing;
