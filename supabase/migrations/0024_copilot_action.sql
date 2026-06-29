-- 0024_copilot_action.sql
-- Audit log of side-effectful actions the co-pilot takes on the owner's behalf
-- (sending an SMS or email to a patient). Every attempt is recorded, whether it
-- sent, was a dry run, or was blocked (no consent / opted out), so the practice
-- has a trail of what the assistant did. Reads/writes are service-role only.

create table if not exists copilot_action (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text,
  actor text,                 -- the authed user id (or 'owner' in dev)
  action text not null,       -- e.g. 'send_sms', 'send_email'
  target_ref text,            -- e.g. 'patient:pat-001'
  target_name text,
  channel text,               -- 'sms' | 'email' | 'whatsapp'
  body text,
  status text not null,       -- provider status, 'dry_run', or 'blocked:<reason>'
  created_at timestamptz not null default now()
);

alter table copilot_action enable row level security;

create index if not exists copilot_action_client_idx on copilot_action (client_id, created_at desc);
