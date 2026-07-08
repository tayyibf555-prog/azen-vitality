-- Per-practice go-live checklist state: which items the practice has ticked off.
-- Keyed by CLIENT (not user), so both owners share the same progress: what one
-- owner ticks, the other sees. Owner-only writes are enforced in the API layer
-- (requireOwnerRole), not here. Additive + default-empty: an item with no row is
-- simply "not done", so shipping this changes nothing until an owner ticks a box.

create table if not exists getting_started_state (
  client_id  text        not null,
  item_key   text        not null,
  checked    boolean     not null default false,
  checked_at timestamptz,
  checked_by text,
  updated_at timestamptz not null default now(),
  primary key (client_id, item_key)
);

-- Locked to server-only, matching the app's other tables (migration 0012): RLS on,
-- no policies, so only the service role (serviceClient) can read/write. Every access
-- path is a guarded server route.
alter table getting_started_state enable row level security;
