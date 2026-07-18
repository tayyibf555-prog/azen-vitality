-- Product usage telemetry ("everything is tracked", from the client call).
--
-- Privacy by construction: a row records WHICH internal surface (module family)
-- an internal user of a given ROLE used, and WHEN. It never records patient data.
-- `surface` is a nav-slug family only (the /api/telemetry route sanitises it to the
-- known-slug allowlist, so URL ids never land here), `detail` is an action NAME
-- only (never free text, never a note body, never an id), and there is no patient
-- identifier column at all. `user_email` is the internal staff email off the
-- verified session (the actor), not a patient.
--
-- Post-0012 locked posture, identical to funnel_event / feedback_item: server-only
-- writes and reads via the service role, RLS enabled with NO policies so the anon
-- key can neither read nor write.

create table if not exists usage_event (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  -- The acting internal user + role, off the verified session. Nullable: in the
  -- un-enforced pilot there is no session to attribute (mirrors feedback_item).
  user_email text,
  role text,
  -- 'page_view' | 'action'. Kept as free text (no enum) so a new event kind never
  -- needs a migration; the app is the source of truth for the small vocabulary.
  event text not null,
  -- The module slug / path family, e.g. 'patients', 'outreach', 'overview'. Never a
  -- full URL: the route reduces a path to its known nav-slug family before insert.
  surface text not null,
  -- For 'action' events, the action NAME only (e.g. 'copilot_turn'). Never PII,
  -- never free text. Null for 'page_view'.
  detail text,
  created_at timestamptz not null default now()
);

-- The owner Usage view reads last-30-days rows for one client, newest first.
create index if not exists idx_usage_event_client_created
  on usage_event (client_id, created_at desc);
-- Surface-scoped lookups (per-surface rollups / future drill-downs).
create index if not exists idx_usage_event_client_surface
  on usage_event (client_id, surface);

alter table usage_event enable row level security;
-- No policies on purpose: all access is server-side via serviceClient() (service
-- role bypasses RLS). This keeps usage telemetry unreadable by the browser anon key.
