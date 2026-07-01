-- 0030_rota.sql
-- Staff Rota: owners/managers configure staffing rules, the system auto-generates
-- shifts from each site's opening hours + staff availability, and texts each staff
-- member their upcoming shifts. Staff are EMPLOYEES, not patients, so patient
-- consent / suppression do NOT apply; the sweep sends each staff member their own
-- shift list via the shared messaging layer (MESSAGING_DRY_RUN honoured) and records
-- notified_at so nobody is texted twice.
--
-- Created in the POST-0012 locked posture: RLS is enabled but NO grants/policies are
-- issued to anon/authenticated (0012 revoked those across the schema). All access is
-- server-only via the service-role client, like every other table now (0026/0027).
--
-- British English throughout. No NHS vs private framing. No dash characters in copy.

-- Staff who can be rota'd. availability is a per-weekday boolean map of the days they
-- can work; role matches the coverage roles in rota_config.
create table if not exists rota_staff (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text,
  name text not null,
  role text not null,
  phone text,
  email text,
  active boolean not null default true,
  -- { monday:true, tuesday:true, ... saturday, sunday } which days they can work.
  availability jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);
-- The generator + management list scan a client's active staff.
create index if not exists idx_rota_staff_client_active on rota_staff (client_id, active);

-- One config row per client. config holds the coverage model + automation knobs:
--   { rolesNeeded: { "dentist":1, "nurse":1, "reception":1 },  -- per open day per site
--     notifyLeadDays: int,      -- only text shifts starting within this many days
--     generateWeeksAhead: int } -- how many weeks the sweep keeps generated
create table if not exists rota_config (
  client_id text primary key,
  config jsonb not null,
  updated_at timestamptz default now()
);

-- A generated shift: one staff member covering one role at one site for one day, with
-- start/end from that day's opening hours. status advances scheduled -> notified once
-- the staff member has been texted. The unique (staff_id, shift_date, start_time) key
-- makes re-generation idempotent: the same slot for the same person is never doubled.
create table if not exists rota_shift (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text not null,
  staff_id uuid references rota_staff (id) on delete cascade,
  shift_date date not null,
  start_time text not null,
  end_time text not null,
  role text not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'notified', 'cancelled')),
  notified_at timestamptz,
  created_at timestamptz default now(),
  unique (staff_id, shift_date, start_time)
);
-- The list + sweep scan a client's shifts within a date window.
create index if not exists idx_rota_shift_client_date on rota_shift (client_id, shift_date);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0026 / 0027).
alter table rota_staff enable row level security;
alter table rota_config enable row level security;
alter table rota_shift enable row level security;

-- ---------------------------------------------------------------------------
-- Seed a few mock staff for the Vitality pilot across the 3 sites and the core
-- roles, each with a phone and an availability map, so the feature demos with data.
-- Idempotent: tagged rows are removed and re-inserted on re-run (created_at kept
-- default). Fixed uuids so shifts can be regenerated cleanly against them.
-- Availability covers the days each person works (Mon to Sat; nobody on Sunday,
-- which every site is closed anyway).
-- ---------------------------------------------------------------------------
delete from rota_shift where staff_id in (
  select id from rota_staff where client_id = 'vitality'
  and id in (
    '00000000-0000-0000-0000-0000000000f1',
    '00000000-0000-0000-0000-0000000000f2',
    '00000000-0000-0000-0000-0000000000f3',
    '00000000-0000-0000-0000-0000000000f4',
    '00000000-0000-0000-0000-0000000000f5',
    '00000000-0000-0000-0000-0000000000f6',
    '00000000-0000-0000-0000-0000000000f7'
  )
);
delete from rota_staff where id in (
  '00000000-0000-0000-0000-0000000000f1',
  '00000000-0000-0000-0000-0000000000f2',
  '00000000-0000-0000-0000-0000000000f3',
  '00000000-0000-0000-0000-0000000000f4',
  '00000000-0000-0000-0000-0000000000f5',
  '00000000-0000-0000-0000-0000000000f6',
  '00000000-0000-0000-0000-0000000000f7'
);

insert into rota_staff (id, client_id, site_id, name, role, phone, email, active, availability) values
  ('00000000-0000-0000-0000-0000000000f1', 'vitality', 'site-cc', 'Amelia Clarke', 'dentist',    '+447700900001', 'amelia.clarke@example.com', true,
    '{"monday":true,"tuesday":true,"wednesday":true,"thursday":true,"friday":true,"saturday":false,"sunday":false}'::jsonb),
  ('00000000-0000-0000-0000-0000000000f2', 'vitality', 'site-rv', 'Noah Patel', 'dentist',    '+447700900002', 'noah.patel@example.com', true,
    '{"monday":true,"tuesday":true,"wednesday":true,"thursday":true,"friday":true,"saturday":true,"sunday":false}'::jsonb),
  ('00000000-0000-0000-0000-0000000000f3', 'vitality', 'site-ng', 'Sophie Turner', 'hygienist',  '+447700900003', 'sophie.turner@example.com', true,
    '{"monday":true,"tuesday":true,"wednesday":false,"thursday":true,"friday":true,"saturday":true,"sunday":false}'::jsonb),
  ('00000000-0000-0000-0000-0000000000f4', 'vitality', 'site-cc', 'Oliver Grant', 'nurse',      '+447700900004', 'oliver.grant@example.com', true,
    '{"monday":true,"tuesday":true,"wednesday":true,"thursday":true,"friday":true,"saturday":true,"sunday":false}'::jsonb),
  ('00000000-0000-0000-0000-0000000000f5', 'vitality', 'site-rv', 'Isla Morgan', 'nurse',      '+447700900005', 'isla.morgan@example.com', true,
    '{"monday":true,"tuesday":true,"wednesday":true,"thursday":false,"friday":true,"saturday":false,"sunday":false}'::jsonb),
  ('00000000-0000-0000-0000-0000000000f6', 'vitality', 'site-cc', 'Ethan Brooks', 'reception',  '+447700900006', 'ethan.brooks@example.com', true,
    '{"monday":true,"tuesday":true,"wednesday":true,"thursday":true,"friday":true,"saturday":true,"sunday":false}'::jsonb),
  ('00000000-0000-0000-0000-0000000000f7', 'vitality', 'site-ng', 'Grace Bennett', 'manager',    '+447700900007', 'grace.bennett@example.com', true,
    '{"monday":true,"tuesday":true,"wednesday":true,"thursday":true,"friday":true,"saturday":false,"sunday":false}'::jsonb);

-- Seed a default config for the pilot so generate works out of the box.
insert into rota_config (client_id, config) values
  ('vitality', '{"rolesNeeded":{"dentist":1,"nurse":1,"reception":1},"notifyLeadDays":7,"generateWeeksAhead":2}'::jsonb)
on conflict (client_id) do nothing;
