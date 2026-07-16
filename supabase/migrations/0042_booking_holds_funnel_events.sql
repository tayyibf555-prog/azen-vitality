-- 0042_booking_holds_funnel_events.sql
--
-- Two things the public funnel now needs a durable home for:
--
-- 1. booking_hold — step 1 of the two-step online booking. A patient picks a
--    slot and leaves their name + mobile; we HOLD the time (a row here) without
--    yet writing to Dentally. Step 2 confirms and the existing gated create path
--    makes the real appointment, flipping the hold to 'confirmed'. A hold left
--    'held' past ~20 minutes is an abandonment: the speed-to-lead sweep converts
--    it into a lead the practice can win back, then marks it 'expired'. NO
--    Dentally write ever happens off this table; it only records intent.
--
-- 2. funnel_event — anonymous, PII-free step events for the smile-assessment quiz
--    and the booking page, so the practice can see where people drop off. A
--    client-generated random session_id ties a person's steps together WITHOUT any
--    name/phone/message content ever landing here.
--
-- Created in the POST-0012 locked posture: RLS enabled, NO anon/authenticated
-- grants. All access is server-only via the service-role client, like every other
-- table since 0012.

-- ---------------------------------------------------------------------------
-- booking_hold
-- ---------------------------------------------------------------------------
create table if not exists booking_hold (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text not null,
  slot_start timestamptz not null,           -- the exact slot the patient chose
  slot_finish timestamptz not null,
  practitioner_id text,                       -- from the chosen availability slot
  practitioner_name text,                     -- when known (slots carry ids today)
  treatment text not null default 'Exam',
  name text not null,
  phone text not null,                        -- E.164; how the practice reaches them
  email text,                                 -- optional at step 1
  status text not null default 'held',        -- held | confirmed | expired
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The abandoned-hold sweep lists still-'held' rows by age; the partial index keeps
-- that scan cheap once most rows have moved on to confirmed/expired.
create index if not exists idx_booking_hold_held
  on booking_hold (created_at)
  where status = 'held';

-- Per-site recent-holds view (owner analytics / debugging) without a full scan.
create index if not exists idx_booking_hold_site_created
  on booking_hold (site_id, created_at desc);

alter table booking_hold enable row level security;

-- ---------------------------------------------------------------------------
-- funnel_event
-- ---------------------------------------------------------------------------
create table if not exists funnel_event (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  surface text not null,                      -- assessment | booking
  campaign_id uuid,                           -- reserved; null for now
  session_id text not null,                   -- client-generated random, NO PII
  step text not null,                         -- started | question_answered | ...
  meta jsonb not null default '{}'::jsonb,    -- small, non-PII (e.g. question index)
  created_at timestamptz not null default now()
);

-- The per-step summary (owner drop-off view) filters by client + surface + a date
-- range and groups by step; this index serves that directly.
create index if not exists idx_funnel_event_client_surface_created
  on funnel_event (client_id, surface, created_at);

alter table funnel_event enable row level security;
