-- 0013_noshow_defence.sql
-- No-show defence: appointment confirmations + reminders, patient confirm/cancel
-- by reply, no-show risk scoring, and a waitlist that auto-fills freed slots.
--
-- Created in the POST-0012 locked posture: RLS is enabled but NO grants/policies
-- are issued to anon/authenticated (0012 revoked those across the schema). All
-- access is server-only via the service-role client, like every other table now.
--
-- Like recall (0009/0010), this module owns its own touch/outbox tables because
-- the reactivation/recall ones have FKs to their own targets. The shared drain /
-- status webhook / inbound webhook handle this module's outbox with the same logic.

-- One row per upcoming appointment we are defending against a no-show.
create table if not exists noshow_target (
  id text primary key,                       -- `${siteId}:${dentallyPatientId}:${appointmentId}`
  site_id text not null,
  dentally_patient_id text not null,
  appointment_id text not null,
  patient_name text not null,
  appointment_start_at timestamptz not null,
  appointment_state text not null,           -- booked | completed | did_not_attend | cancelled
  duration_min integer not null default 0,
  practitioner text,
  risk_score integer not null default 0,     -- 0-100
  risk_band text not null default 'low',     -- low | medium | high
  status text not null default 'scheduled',  -- scheduled | confirmed | cancelled | attended | no_show
  prior_attempts integer not null default 0,
  consent jsonb not null default '{}'::jsonb,
  updated_from_dentally_at timestamptz not null default now()
);
create index if not exists idx_noshow_target_site on noshow_target (site_id);
create index if not exists idx_noshow_target_due on noshow_target (site_id, appointment_start_at);

-- Appointment-relative reminder sequence (next_due_at = appointment_start - offset).
create table if not exists noshow_cadence (
  id uuid primary key default gen_random_uuid(),
  target_id text not null references noshow_target (id) on delete cascade,
  site_id text not null,
  current_step integer not null default 0,
  status text not null default 'active',     -- active | paused | confirmed | cancelled | exhausted
  next_due_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_noshow_cadence_target on noshow_cadence (target_id);
create index if not exists idx_noshow_cadence_due on noshow_cadence (status, next_due_at);

create table if not exists noshow_touch (
  id uuid primary key default gen_random_uuid(),
  -- nullable: waitlist slot-offer touches are not tied to a defended target.
  target_id text references noshow_target (id) on delete cascade,
  cadence_id uuid references noshow_cadence (id) on delete set null,
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
create index if not exists idx_noshow_touch_target on noshow_touch (target_id);

create table if not exists noshow_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references noshow_touch (id) on delete cascade,
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
create index if not exists idx_noshow_outbox_msgid on noshow_outbox (provider_message_id);

-- Patients waiting for a sooner slot. When a defended appointment cancels, the
-- freed slot is offered to the best-matched waitlist entry to fill the gap.
create table if not exists noshow_waitlist (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  dentally_patient_id text not null,
  patient_name text not null,
  treatment text,
  practitioner_pref text,                    -- match against the freed slot's practitioner, if set
  earliest_at timestamptz,                   -- acceptable window (null = any)
  latest_at timestamptz,
  duration_min integer not null default 30,
  consent jsonb not null default '{}'::jsonb,
  status text not null default 'waiting',    -- waiting | offered | booked | removed
  created_at timestamptz not null default now()
);
create index if not exists idx_noshow_waitlist_site on noshow_waitlist (site_id, status);

-- A single freed-slot offer to one waitlist entry, with an expiry. One offer is
-- live per freed slot at a time; on expiry/decline the sweep offers the next.
create table if not exists noshow_slot_offer (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  waitlist_id uuid not null references noshow_waitlist (id) on delete cascade,
  dentally_patient_id text not null,
  freed_appointment_id text not null,
  freed_start_at timestamptz not null,
  duration_min integer not null default 30,
  practitioner text,
  touch_id uuid references noshow_touch (id) on delete set null,
  status text not null default 'offered',    -- offered | accepted | declined | expired | filled
  offered_at timestamptz not null default now(),
  expires_at timestamptz not null,
  responded_at timestamptz
);
create index if not exists idx_noshow_offer_status on noshow_slot_offer (site_id, status);
create index if not exists idx_noshow_offer_expiry on noshow_slot_offer (status, expires_at);
-- At most one live (offered/filled) offer per freed slot: a DB backstop against
-- two patients being booked into the same cancelled time.
create unique index if not exists idx_noshow_offer_one_live
  on noshow_slot_offer (freed_appointment_id)
  where status in ('offered', 'filled');

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012).
alter table noshow_target enable row level security;
alter table noshow_cadence enable row level security;
alter table noshow_touch enable row level security;
alter table noshow_outbox enable row level security;
alter table noshow_waitlist enable row level security;
alter table noshow_slot_offer enable row level security;
