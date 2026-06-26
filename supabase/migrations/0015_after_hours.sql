-- 0015_after_hours.sql
-- After-hours capture: logs missed phone calls and inbound SMS/WhatsApp that
-- arrive while a site is closed, so staff get a worklist of overnight captures
-- to follow up. A live-hours AI receptionist is explicitly out of scope; this
-- module only acts on genuine after-hours/overflow contact.
--
-- Created in the POST-0012 locked posture: RLS is enabled but NO grants/policies
-- are issued to anon/authenticated (0012 revoked those across the schema). All
-- access is server-only via the service-role client, like every other table now.

-- One row per after-hours contact (call, SMS or WhatsApp) we captured.
create table if not exists after_hours_capture (
  id uuid primary key default gen_random_uuid(),
  site_id text not null,
  from_number text not null,
  dentally_patient_id text,                  -- set when we recognised the caller
  patient_name text not null,                -- resolved name, or "Unknown <last4>"
  channel text not null,                     -- call | sms | whatsapp
  body text,                                 -- message text (null for a call)
  captured_at timestamptz not null default now(),
  status text not null default 'new',        -- new | followed_up | booked | closed
  follow_up_sent boolean not null default false
);
create index if not exists idx_after_hours_site_status on after_hours_capture (site_id, status);
create index if not exists idx_after_hours_captured_at on after_hours_capture (captured_at);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012/0013).
alter table after_hours_capture enable row level security;
