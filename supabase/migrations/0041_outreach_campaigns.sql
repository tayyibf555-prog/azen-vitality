-- 0041_outreach_campaigns.sql
-- Segment outreach engine: owner-built campaigns that text a chosen cohort of
-- patients and let the booking agent book them into a specific clinician's diary.
--
-- Scope vs recall/reactivation: those two run OFF the Dentally record automatically
-- (recall date due, patient lapsed). Outreach is a DELIBERATE, owner-built campaign
-- over an arbitrary segment (e.g. "had a hygiene clean in the last ~3 years but not
-- the last 3 months") aimed at a named practitioner's diary. It reuses the same
-- gated send pipeline (per-module outbox -> shared drain -> consent/suppression/
-- one-per-day cap) so nothing about how a message reaches a patient changes.
--
-- OUTBOX SHAPE: outreach_touch / outreach_outbox mirror recall_touch / recall_outbox
-- column-for-column (including the 0005 messaging columns to_address /
-- provider_message_id) so the shared messaging drain, status webhook and inbound
-- webhook handle outreach with the same logic. Outreach has NO separate cadence
-- table: a target IS its own cadence (current_step / next_due_at on the row), because
-- a campaign target is a one-off enrolment, not a re-synced Dentally record.
--
-- Ops-only, no clinical data. POST-0012 locked posture (matches 0034 / 0038):
-- RLS on, NO anon/authenticated grants. All access is server-only via the
-- service-role client (which bypasses RLS); reads/writes are owner-gated at the
-- API layer (requireUser + owner role, or CRON_SECRET), not here.

-- ---------------------------------------------------------------------------
-- Campaign: the owner-built segment + its send configuration.
-- ---------------------------------------------------------------------------
create table if not exists outreach_campaign (
  id                uuid primary key default gen_random_uuid(),
  client_id         text not null,
  site_id           text not null,                 -- the site whose patients + diary this campaign targets
  name              text not null,
  status            text not null default 'draft'
                      check (status in ('draft', 'building', 'ready', 'running', 'paused', 'done')),
  filters           jsonb not null default '{}'::jsonb,   -- OutreachFilters (see src/lib/outreach/types.ts)
  practitioner_id   text,                          -- Dentally practitioner id to book into (optional)
  practitioner_name text,                          -- display name woven into the invite + agent prompt
  message_angle     text,                          -- the treatment angle, e.g. "hygiene clean"
  daily_cap         integer not null default 25,   -- max targets contacted per Europe/London day for THIS campaign
  build_cursor      jsonb,                          -- resumable segment-build cursor (per-site page + counters)
  counts            jsonb,                          -- cached headline counts (built/pending/contacted/...)
  created_by        text,                          -- auth user id/email that created it
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_outreach_campaign_client on outreach_campaign (client_id);
create index if not exists idx_outreach_campaign_status on outreach_campaign (status);

-- ---------------------------------------------------------------------------
-- Target: one enrolled patient in a campaign. The row carries its own cadence
-- position (current_step / next_due_at) since there is no cadence table.
-- ---------------------------------------------------------------------------
create table if not exists outreach_target (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references outreach_campaign (id) on delete cascade,
  patient_id     text not null,                   -- Dentally patient id
  name           text not null,
  phone          text,                            -- snapshot at build; the drain re-resolves live before sending
  site_id        text not null,
  matched_reason text,                            -- why they matched, e.g. "Hygiene clean 14 Mar 2025"
  status         text not null default 'pending'
                   check (status in ('pending', 'queued', 'contacted', 'replied', 'booked', 'excluded', 'exhausted')),
  consent        jsonb not null default '{}'::jsonb,  -- {sms,email,marketing} snapshot; acted on at sweep time
  current_step   integer not null default 0,      -- last completed cadence step; 0 = enrolled, none sent
  next_due_at    timestamptz,                     -- when the next step is due; null when terminal
  started_at     timestamptz,                     -- when the cadence began
  ended_at       timestamptz,                     -- when the cadence ended (exhausted/replied/booked)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (campaign_id, patient_id)                -- a patient is enrolled at most once per campaign
);
create index if not exists idx_outreach_target_campaign on outreach_target (campaign_id);
create index if not exists idx_outreach_target_site on outreach_target (site_id);
-- The sweep scans for due targets by (status, next_due_at); the inbound webhook
-- matches a reply by phone within a site.
create index if not exists idx_outreach_target_due on outreach_target (status, next_due_at);
create index if not exists idx_outreach_target_phone on outreach_target (site_id, phone);

-- ---------------------------------------------------------------------------
-- Touch + outbox: mirror recall_touch / recall_outbox. campaign_id is carried on
-- the touch so the per-campaign daily cap can count today's outbound touches
-- without a join back through the target.
-- ---------------------------------------------------------------------------
create table if not exists outreach_touch (
  id          uuid primary key default gen_random_uuid(),
  target_id   uuid not null references outreach_target (id) on delete cascade,
  campaign_id uuid references outreach_campaign (id) on delete cascade,
  site_id     text not null,
  step        integer not null default 0,
  channel     text not null,
  direction   text not null default 'outbound',
  body        text not null,
  drafted_by  text not null,
  status      text not null default 'draft',
  approved_by text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists idx_outreach_touch_target on outreach_touch (target_id);
-- Per-campaign daily cap: count today's outbound touches for a campaign.
create index if not exists idx_outreach_touch_campaign_created on outreach_touch (campaign_id, created_at);

create table if not exists outreach_outbox (
  id                  uuid primary key default gen_random_uuid(),
  touch_id            uuid not null references outreach_touch (id) on delete cascade,
  site_id             text not null,
  channel             text not null,
  to_ref              text not null,
  body                text not null,
  status              text not null default 'queued',
  provider            text,
  to_address          text,
  provider_message_id text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz
);
create index if not exists idx_outreach_outbox_msgid on outreach_outbox (provider_message_id);
-- The shared drain lists queued rows per site, oldest first.
create index if not exists idx_outreach_outbox_site_status on outreach_outbox (site_id, status, created_at);
-- Inbound reply correlation matches on the resolved to_address of the last send.
create index if not exists idx_outreach_outbox_to_address on outreach_outbox (to_address);

-- ---------------------------------------------------------------------------
-- Kill-switch seed. system_toggle is DEFAULT-ON by absence of a row, so a new
-- system would be live the moment its code ships. Outreach must ship DORMANT: it
-- sends real texts to real patients and only runs during a supervised client
-- test. Insert an explicit disabled row so the sweep + drain are fail-closed
-- until the owner turns it on from the control panel. do-nothing on conflict so
-- re-running the migration never re-arms a system the owner has since enabled.
-- ---------------------------------------------------------------------------
insert into system_toggle (client_id, module_slug, enabled)
values ('vitality', 'outreach', false)
on conflict (client_id, module_slug) do nothing;

-- Server-only, matching 0034 / 0038: RLS on, no policies/grants.
alter table outreach_campaign enable row level security;
alter table outreach_target   enable row level security;
alter table outreach_touch    enable row level security;
alter table outreach_outbox   enable row level security;

revoke all on outreach_campaign, outreach_target, outreach_touch, outreach_outbox from anon, authenticated;
