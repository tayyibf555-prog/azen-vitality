-- 0049_patient_admin_status.sql
-- Owner / practice-manager controlled PATIENT ADMIN STATUS.
--
-- A patient can be marked active / inactive / do_not_contact from the patient record.
-- The override is the PLATFORM's source of truth for targeting and for the status chip;
-- Dentally's own `active` flag is synced where the API supports it (active <-> inactive)
-- and stays purely advisory for do_not_contact (Dentally has no such concept, so it is
-- never faked upstream). NO hard delete of a patient anywhere - statutory record
-- retention, and Dentally itself only archives (sets active=false), so "do not contact"
-- is the strongest state the platform offers.
--
-- Two tables:
--   1. patient_status_override - the current override per (site, patient). One row per
--      patient; upserted on change. `dentally_synced` records whether the last change
--      reached Dentally (only meaningful for active/inactive).
--   2. patient_admin_audit - an append-only trail of every change (who, when, from->to,
--      why, and what happened at Dentally), so the practice has a defensible history.
--
-- POST-0012 locked posture: RLS ENABLED, NO anon/authenticated grants. All access is
-- server-only via the service-role client (consistent with 0018 / 0032 / 0041 / 0044 /
-- 0048). British English, no funding framing, decision-support only.

create table if not exists patient_status_override (
  site_id text not null,
  dentally_patient_id text not null,
  status text not null check (status in ('active', 'inactive', 'do_not_contact')),
  reason text,
  set_by text,                        -- actor email/id that set it (best-effort)
  set_at timestamptz not null default now(),
  dentally_synced boolean not null default false,
  dentally_synced_at timestamptz,
  primary key (site_id, dentally_patient_id)
);

create table if not exists patient_admin_audit (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  dentally_patient_id text not null,
  action text not null,               -- e.g. 'set_status'
  from_status text,                   -- prior override status, or null when none existed
  to_status text not null,            -- the status set by this change
  reason text,
  actor_email text,
  dentally_result text check (dentally_result in ('synced', 'unsupported', 'failed', 'skipped')),
  created_at timestamptz not null default now()
);
-- The record drawer reads the last N entries for one patient, newest first.
create index if not exists patient_admin_audit_lookup
  on patient_admin_audit (site_id, dentally_patient_id, created_at desc);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0032 / 0048).
alter table patient_status_override enable row level security;
alter table patient_admin_audit enable row level security;
