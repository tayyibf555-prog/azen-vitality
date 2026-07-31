-- 0063_diary.sql
-- The diary rebuild: breaks and notes, appointment-move audit, the diary's own
-- outbound touch/outbox pair, clinician treatment capability, and the per-practice
-- appointment-type colour override.
--
-- WHERE BREAKS AND NOTES COME FROM. They are OUR records, not Dentally's.
-- Dentally exposes no endpoint for breaks, blocked time or diary notes: there is
-- no such method on DentallyClient (src/lib/dentally/client.ts) and no such route
-- on the local mock. Nothing here mirrors Dentally, and nothing here should ever
-- be described as coming from it.
--
-- Created in the POST-0012 locked posture, identical to 0035_patient_notes.sql:
-- RLS is enabled but NO grants or policies are issued to anon/authenticated. All
-- access is server-only through the service-role client behind requireUser plus
-- the client/site access checks.

-- ---------------------------------------------------------------------------
-- Breaks and notes on the diary grid.
--
-- Day-plus-minutes rather than timestamptz ON PURPOSE: the diary's entire
-- geometry is Europe/London minutes past midnight, and "lunch is 13:00 to 14:00"
-- is a wall-clock fact that must not slide by an hour across a DST boundary.
-- ---------------------------------------------------------------------------
create table if not exists public.diary_entry (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text not null,
  -- null = the whole site (every clinician column that day).
  practitioner_id text,
  day text not null,                        -- 'YYYY-MM-DD', the Europe/London day
  start_min integer not null,
  end_min integer not null,
  kind text not null,
  title text not null,
  body text,
  author_id text,
  author_name text not null default 'Team',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint diary_entry_kind_chk check (kind in ('break', 'note')),
  constraint diary_entry_span_chk check (end_min > start_min and start_min >= 0 and end_min <= 1440),
  constraint diary_entry_day_chk check (day ~ '^\d{4}-\d{2}-\d{2}$')
);

create index if not exists diary_entry_lookup_idx
  on public.diary_entry (site_id, day, practitioner_id)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Every attempted appointment move, including the REFUSED ones.
--
-- A refused attempt is recorded too (the insertProfileAudit precedent), so a
-- rejected move is never invisible to the practice manager.
-- ---------------------------------------------------------------------------
create table if not exists public.diary_move (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text not null,
  appointment_id text not null,
  patient_id text,
  from_start_at timestamptz,
  from_finish_at timestamptz,
  from_practitioner_id text,
  to_start_at timestamptz,
  to_finish_at timestamptz,
  to_practitioner_id text,
  actor_id text,
  actor_email text,
  actor_role text,
  outcome text not null,
  detail text,
  notify_intent boolean not null default false,
  touch_id uuid,
  undo_of uuid references public.diary_move (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint diary_move_outcome_chk check (outcome in ('refused', 'saved', 'not_saved', 'unknown'))
);

create index if not exists diary_move_lookup_idx
  on public.diary_move (site_id, appointment_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The diary's own touch / outbox pair, modelled line for line on
-- noshow_touch / noshow_outbox. Every module owns its own pair and the SHARED
-- drain iterates them; no module opens a new path to a provider.
-- ---------------------------------------------------------------------------
create table if not exists public.diary_touch (
  id uuid primary key default gen_random_uuid(),
  move_id uuid references public.diary_move (id) on delete set null,
  site_id text not null,
  channel text not null,
  direction text not null default 'outbound',
  body text not null,
  drafted_by text not null default 'template',
  status text not null default 'draft',
  approved_by text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists diary_touch_move_idx on public.diary_touch (move_id);

create table if not exists public.diary_outbox (
  id uuid primary key default gen_random_uuid(),
  touch_id uuid not null references public.diary_touch (id) on delete cascade,
  site_id text not null,
  channel text not null,
  to_ref text not null,
  body text not null,
  status text not null default 'queued',
  provider text,
  to_address text,
  provider_message_id text,
  -- QUIET HOURS. There is no quiet-hours guard anywhere else in this codebase:
  -- no send window and no time-of-day gate, in the drain or in any sweep. Rather
  -- than claim a guard that does not exist, this build adds one confined to the
  -- diary's own table: the enqueue clamps into 08:00-20:00 Europe/London and this
  -- source's listQueuedOutbox filters on it. No other module changes.
  not_before_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists diary_outbox_queue_idx
  on public.diary_outbox (site_id, status, not_before_at);
create index if not exists diary_outbox_provider_msg_idx
  on public.diary_outbox (provider_message_id);

-- ---------------------------------------------------------------------------
-- Which clinicians can perform which treatments.
--
-- Keyed on the FAMILY slug (src/components/client/calendar/treatment-type.ts),
-- not the raw appointment reason: a practice has roughly twenty appointment types
-- but roughly ten clinical competences, and a 13-by-20 grid is how the data never
-- arrives. `level` is three-valued because 'supervised' is real (a foundation
-- dentist extracting with a supervisor present). `site_id` is nullable because
-- clinicians move between sites on a rota but equipment does not: a null row is
-- the general rule and a site row overrides it. `source` is the seam between the
-- seeded example data and the practice's own answers.
-- ---------------------------------------------------------------------------
create table if not exists public.treatment_capability (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text,
  practitioner_id text not null,
  family_slug text not null,
  level text not null default 'can',
  source text not null default 'seed',
  note text,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint treatment_capability_level_chk check (level in ('can', 'cannot', 'supervised')),
  constraint treatment_capability_source_chk check (source in ('seed', 'practice'))
);

create unique index if not exists treatment_capability_key_idx
  on public.treatment_capability (client_id, coalesce(site_id, ''), practitioner_id, family_slug);

-- ---------------------------------------------------------------------------
-- Per-practice appointment-type colour, so a practice can eventually configure
-- what Dentally lets it configure. No UI in this batch; the matcher already
-- accepts an overrides map, so the pure test suite is untouched when real rows
-- arrive.
-- ---------------------------------------------------------------------------
create table if not exists public.diary_appointment_type (
  client_id text not null,
  canonical_key text not null,
  label text not null,
  palette_slot integer not null,
  created_at timestamptz not null default now(),
  primary key (client_id, canonical_key),
  constraint diary_appointment_type_slot_chk check (palette_slot between 0 and 12)
);

alter table public.diary_entry enable row level security;
alter table public.diary_move enable row level security;
alter table public.diary_touch enable row level security;
alter table public.diary_outbox enable row level security;
alter table public.treatment_capability enable row level security;
alter table public.diary_appointment_type enable row level security;

-- NOTE on 'calendar-writes': it is deliberately NOT seeded off here. system_toggle
-- is default-ON when no row exists, and seeding it off would make the move route
-- 503 on the kill switch before the Dentally write gate could ever be exercised.
-- The write gate (DENTALLY_WRITE_ENABLED) is the real guard for that route.
