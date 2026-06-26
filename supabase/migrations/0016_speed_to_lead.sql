-- 0016_speed_to_lead.sql
-- Speed-to-lead: contact a brand new enquiry within ~30 seconds, multi-channel
-- (SMS, email, WhatsApp). A public intake endpoint records the lead and fires a
-- first-contact message instantly, threading an agent conversation so the lead's
-- reply is picked up by the existing booking agent. A sweep is the SLA failsafe.
--
-- Created in the POST-0012 locked posture: RLS is enabled but NO grants/policies
-- are issued to anon/authenticated (0012 revoked those across the schema). All
-- access is server-only via the service-role client, like every other table now.

-- One row per inbound enquiry we are racing to contact.
create table if not exists speed_to_lead_lead (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  dentally_patient_id text,                  -- set if we later resolve them to a record
  name text not null,
  email text,
  phone text,
  channel text not null,                     -- sms | email | whatsapp (first-contact channel)
  treatment_interest text,
  source text not null default 'web',        -- web | facebook | google | etc.
  score integer,                             -- optional intent/fit score (from Smile Assessment)
  stage text not null default 'new',         -- new | contacted | qualifying | booked | lost
  consent jsonb not null default '{}'::jsonb, -- { sms?, email?, whatsapp?, marketing? }
  created_at timestamptz not null default now(),
  first_response_at timestamptz,             -- when first contact actually went out
  conversation_id uuid,                      -- the threaded agent_conversation, once created
  updated_at timestamptz not null default now()
);
create index if not exists idx_stl_lead_site_created on speed_to_lead_lead (site_id, created_at);
create index if not exists idx_stl_lead_site_stage on speed_to_lead_lead (site_id, stage);
-- SLA sweep: find still-uncontacted leads cheaply, ordered by age.
create index if not exists idx_stl_lead_uncontacted
  on speed_to_lead_lead (created_at)
  where first_response_at is null;

-- One row per outbound first-contact attempt (the audit trail for the race).
create table if not exists speed_to_lead_attempt (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references speed_to_lead_lead (id) on delete cascade,
  channel text not null,                     -- sms | email | whatsapp
  to_address text not null,                  -- phone or email the attempt was sent to
  body text not null,
  status text not null default 'sent',       -- sent | failed
  provider text,                             -- twilio | resend | dry-run, etc.
  provider_message_id text,
  created_at timestamptz not null default now()
);
create index if not exists idx_stl_attempt_lead on speed_to_lead_attempt (lead_id, created_at);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012/0013).
alter table speed_to_lead_lead enable row level security;
alter table speed_to_lead_attempt enable row level security;
