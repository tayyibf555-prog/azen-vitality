-- 0026_reviews.sql
-- Reviews & reputation: after an appointment is marked attended, schedule a single
-- Google-review-request message to that patient, sent a few hours later or the next
-- morning. One request per appointment, sent through the shared messaging layer so
-- consent, suppression and MESSAGING_DRY_RUN are all honoured.
--
-- Compliance (UK): requesting a Google review is allowed and is distinct from the
-- banned use of patient testimonials in advertising. The copy never offers an
-- incentive, never uses NHS/private framing, and the opt-out is respected by the
-- shared suppression layer.
--
-- Created in the POST-0012 locked posture: RLS is enabled but NO grants/policies
-- are issued to anon/authenticated (0012 revoked those across the schema). All
-- access is server-only via the service-role client, like every other table now.
--
-- Like no-show (0013) and recall (0009/0010), this module owns its own touch/outbox
-- tables because the other modules' ones have FKs to their own targets. The shared
-- drain / status webhook / inbound webhook handle this module's outbox with the
-- same logic.

-- One review request per attended appointment.
create table if not exists review_request (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  dentally_appointment_id text not null,
  dentally_patient_id text not null,
  patient_name text not null,
  channel text not null,
  attended_at timestamptz not null,
  send_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sent', 'skipped', 'suppressed', 'failed')),
  created_at timestamptz not null default now(),
  -- One request per appointment: the attend endpoint is idempotent on this.
  unique (dentally_appointment_id)
);
create index if not exists idx_review_request_site on review_request (site_id);
-- The sweep scans for due, still-scheduled requests.
create index if not exists idx_review_request_due on review_request (status, send_at);

create table if not exists review_touch (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references review_request (id) on delete cascade,
  site_id text not null,
  step integer not null default 0,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  drafted_by text not null,
  status text not null default 'draft',
  approved_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_review_touch_request on review_touch (request_id);

create table if not exists review_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references review_touch (id) on delete cascade,
  site_id text not null,
  channel text not null,
  to_ref text not null,
  body text not null,
  status text not null default 'queued',
  provider text,
  to_address text,
  provider_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_review_outbox_msgid on review_outbox (provider_message_id);
-- The shared drain lists queued rows for the site set.
create index if not exists idx_review_outbox_queued on review_outbox (site_id, status, created_at);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0013).
alter table review_request enable row level security;
alter table review_touch enable row level security;
alter table review_outbox enable row level security;
