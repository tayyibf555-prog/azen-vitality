-- 0003_webhook_events.sql
-- Inbound Dentally webhook event log. Records every received event for audit +
-- idempotency (dedupe on the Dentally event id), and a processed flag so handlers
-- can be retried. Real-time tracking; the updated_after poll stays as a backstop.

create table if not exists webhook_event (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'dentally',
  dentally_event_id text,
  event_type text not null,
  site_id text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed boolean not null default false,
  processed_at timestamptz,
  error text
);

-- Dedupe: at most one row per (provider, dentally_event_id) when an id is present.
create unique index if not exists idx_webhook_event_dedupe
  on webhook_event (provider, dentally_event_id)
  where dentally_event_id is not null;
create index if not exists idx_webhook_event_type on webhook_event (event_type, received_at desc);

-- PILOT ONLY permissive RLS (consistent with 0002). Replace with auth-bound,
-- site-scoped policies before any real patient data or production deployment.
alter table webhook_event enable row level security;
grant all on webhook_event to anon, authenticated;
create policy pilot_all_webhook_event on webhook_event for all to anon, authenticated using (true) with check (true);
