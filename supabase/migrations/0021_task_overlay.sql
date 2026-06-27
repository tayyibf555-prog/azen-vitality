-- 0021_task_overlay.sql
-- The Task Queue is a unified, prioritized action list computed ON READ by
-- aggregating the actionable items across every ops module (leads to contact,
-- recalls due, no-show risks, stalled plans, after-hours callbacks, high-intent
-- assessments). Like the Daily brief, the candidate items are NOT stored.
--
-- This table stores ONLY the lightweight OVERLAY state staff apply to a computed
-- task: completed / snoozed / dismissed, who it is assigned to, and a snooze
-- expiry. Each row is keyed by a STABLE task_key (`<module>:<entityId>:<kind>`) so
-- the overlay survives every recompute. A task with no overlay row is simply open.
--
-- Post-0012 locked posture: RLS on, NO anon/authenticated grants; all access is
-- server-only via the service-role client; the API is requireUser + client-scoped.

create table if not exists task_overlay (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  task_key text not null,                   -- stable: <module>:<entityId>:<kind>
  status text not null default 'open',      -- open | done | snoozed | dismissed
  assignee text,                            -- user id/email a staff member claimed it as
  snoozed_until timestamptz,                -- when a snoozed task resurfaces
  note text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, task_key)
);
create index if not exists idx_task_overlay_client_status
  on task_overlay (client_id, status);

alter table task_overlay enable row level security;
