-- 0045_deliverability_nurture.sql
-- Three client-call features, shipped together but independently dormant:
--   1. phone_lookup        - Twilio Lookup pre-send validation cache ("never pay
--                            for undeliverable texts"). Dormant unless
--                            TWILIO_LOOKUP_ENABLED=true.
--   2. patient_channel_pref - a patient's chosen messaging channel (SMS/WhatsApp),
--                            set from a signed per-patient /prefs link. Only ever
--                            changes routing once WhatsApp is live (kill switch).
--   3. speed_to_lead_lead   - nurture_step + nurture_next_at columns that drive the
--                            gentle 3-touch nurture for close-but-quiet leads.
--
-- POST-0012 locked posture: RLS enabled, NO anon/authenticated grants. All access
-- is server-only via the service-role client (like 0034 / 0036 / 0044). British
-- English, GBP, no NHS vs private framing anywhere.

-- ---------------------------------------------------------------------------
-- 1. Twilio Lookup cache.
--
-- One row per E.164 number we have validated, so a repeat send NEVER re-calls the
-- paid Lookup API. `valid` is OUR deliverability verdict (a real mobile/VoIP that
-- can receive an SMS), not Twilio's raw flag: a landline is stored valid=false.
-- `checked_at` drives a 90-day TTL in code (a row older than that is treated as a
-- miss and re-validated). The phone number itself is the primary key.
-- ---------------------------------------------------------------------------
create table if not exists public.phone_lookup (
  phone text primary key,
  valid boolean not null,
  line_type text,
  checked_at timestamptz not null default now()
);

-- Server-only: written and read exclusively by the service-role send path.
alter table public.phone_lookup enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Patient channel preference.
--
-- A patient picks SMS or WhatsApp from a signed /prefs/<token> link. Keyed by the
-- practice site and the patient reference (patient:<dentallyId>, the same ref the
-- suppression + touch tables use). The messaging resolve path honours this only
-- where BOTH channels are viable, and WhatsApp is behind its own kill switch, so
-- with WhatsApp off this changes nothing today. The "stop messaging me" option on
-- the same page does NOT write here - it routes through the existing suppression
-- machinery (message_suppression), exactly like an inbound STOP.
-- ---------------------------------------------------------------------------
create table if not exists public.patient_channel_pref (
  site_id text not null,
  patient_ref text not null,
  preferred_channel text not null check (preferred_channel in ('sms', 'whatsapp')),
  updated_at timestamptz not null default now(),
  primary key (site_id, patient_ref)
);

-- Server-only: RLS on, no policies (service role bypasses; anon/auth get nothing).
alter table public.patient_channel_pref enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Lead nurture cadence state.
--
-- A lead that was contacted but has gone quiet for 3 days enters a gentle 3-touch
-- nurture (days 3, 10, 21 after the last touch). nurture_step counts touches sent
-- (0..3); nurture_next_at is when the next touch is due. Both default to the
-- pre-nurture state, so every existing lead is simply "not yet nurtured" and the
-- sweep picks them up on its own schedule. A reply exits nurture; touch 3 is
-- terminal (stage 'nurture_done', handled in application code).
-- ---------------------------------------------------------------------------
alter table public.speed_to_lead_lead
  add column if not exists nurture_step integer not null default 0,
  add column if not exists nurture_next_at timestamptz;

-- The nurture sweep selects due leads by (stage, nurture_step, nurture_next_at)
-- with an age guard on created_at; this partial index keeps that scan cheap.
create index if not exists idx_speed_to_lead_nurture_due
  on public.speed_to_lead_lead (nurture_next_at)
  where stage = 'contacted';
