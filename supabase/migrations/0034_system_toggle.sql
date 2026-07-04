-- 0034_system_toggle.sql
-- Owner-controlled per-system kill switch.
--
-- Each row records that a client has EXPLICITLY set one system's enabled state.
-- Semantics are DEFAULT-ON: the absence of a row means the system is enabled, so
-- shipping this table changes nothing until an owner turns something off. A row
-- is written the first time a system is toggled (to false, or back to true).
--
-- "Off" is a full kill switch: the app hides the module AND the server-side
-- automation halts (the messaging drain skips that system's outbox, its sweeps
-- and syncs no-op, the inbound agent stops auto-replying for it, and public
-- intake for it is rejected). All of that enforcement reads this table via
-- src/lib/systems/repository.ts.
--
-- Scope is per practice (client_id) — a system is on/off for the whole client,
-- across its sites. module_slug matches the CLIENT_NAV slug (src/lib/nav.ts).
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client (which bypasses RLS), consistent
-- with 0018/0027/0032. Reads/writes are owner-gated at the API layer, not here.

create table if not exists system_toggle (
  client_id text not null,
  module_slug text not null,             -- matches a CLIENT_NAV slug
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text,                       -- auth user id/email that flipped it
  primary key (client_id, module_slug)
);

-- The owner panel and the drain both scan a single client's toggles.
create index if not exists idx_system_toggle_client on system_toggle (client_id);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0032).
alter table system_toggle enable row level security;
revoke all on system_toggle from anon, authenticated;
