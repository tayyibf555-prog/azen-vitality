-- 0067_staff_absence.sql
-- Holiday and absence: staff request time off, the practice manager approves or
-- refuses, and approved absence is taken out of the generated rota so nobody is
-- rostered on a day they are away.
--
-- Staff are EMPLOYEES, not patients, so patient consent / suppression do not apply.
-- Created in the POST-0012 locked posture: RLS is enabled but NO grants/policies are
-- issued to anon/authenticated (0012 revoked those across the schema). All access is
-- server-only via the service-role client, exactly like 0030 (rota) and 0066 (perio).
--
-- The FK is COMPOSITE and deliberately so. This is the 0031 lesson: a bare
-- `staff_id references rota_staff (id)` is NOT tenant-scoped, so a row could point at
-- another client's staff member while carrying our own client_id. The composite
-- (client_id, staff_id) -> rota_staff (client_id, id) makes the tenant boundary a
-- schema guarantee rather than an application convention. It depends on the
-- `rota_staff_client_id_id_key` unique added by 0031_rota_tenant_hardening.sql:19.
--
-- NOT YET APPLIED. Written for the orchestrator to apply; migrations 0065, 0066 and
-- 0069 are in the same state, so the live DB is still at 0064. Nothing in the app may
-- assume this table exists yet (the rota generate route already falls back to "no
-- absences" if the read fails).
--
-- British English throughout. No NHS vs private framing. No dash characters in copy.

create table if not exists staff_absence (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  -- The staff member's home site at the time of the request, copied for reporting.
  -- Nullable because a floating staff member has no home site (rota_staff.site_id).
  site_id text,
  staff_id uuid not null,
  kind text not null check (kind in ('holiday', 'sick', 'training', 'unpaid', 'other')),
  start_date date not null,
  end_date date not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'refused', 'cancelled')),
  note text,
  -- Who asked and who decided, as app_user ids. `on delete set null` keeps the
  -- absence record intact when a login is removed: the history of who was away is a
  -- staffing record, not a property of the login. Nullable also because a request
  -- can be recorded while auth enforcement is off (the pilot demo).
  requested_by uuid references app_user (id) on delete set null,
  decided_by uuid references app_user (id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz default now(),
  constraint staff_absence_dates_ordered check (end_date >= start_date),
  constraint staff_absence_client_staff_fkey
    foreign key (client_id, staff_id) references rota_staff (client_id, id) on delete cascade
);

-- The list view and the rota generator both scan a client's absences over a date
-- window, so index the client + the range bounds together.
create index if not exists idx_staff_absence_client_dates
  on staff_absence (client_id, start_date, end_date);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0030 / 0066).
alter table staff_absence enable row level security;

-- ---------------------------------------------------------------------------
-- Seed a handful of absences for the Vitality pilot so the module demos with data,
-- following the same convention as 0030's rota_staff seed: fixed uuids, idempotent
-- (tagged rows deleted then re-inserted on re-run), and pointed at 0030's seeded
-- staff uuids so the composite FK resolves.
--
-- Dates are RELATIVE to current_date, never hardcoded. A hardcoded demo date is a
-- time bomb: it reads as "last year's holiday" a few months after it is applied, and
-- the "away today" count silently becomes zero forever. Relative dates keep the demo
-- meaningful whenever the migration is applied.
-- ---------------------------------------------------------------------------
delete from staff_absence where id in (
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-0000000000a3',
  '00000000-0000-0000-0000-0000000000a4',
  '00000000-0000-0000-0000-0000000000a5'
);

insert into staff_absence
  (id, client_id, site_id, staff_id, kind, start_date, end_date, status, note, decided_at, decision_note)
values
  -- Approved holiday next week: the rota generator must skip Noah on these days.
  ('00000000-0000-0000-0000-0000000000a1', 'vitality', 'site-rv',
   '00000000-0000-0000-0000-0000000000f2', 'holiday',
   current_date + 7, current_date + 11, 'approved', 'Family holiday.',
   now(), 'Cover arranged.'),
  -- Pending request awaiting the practice manager.
  ('00000000-0000-0000-0000-0000000000a2', 'vitality', 'site-ng',
   '00000000-0000-0000-0000-0000000000f3', 'holiday',
   current_date + 21, current_date + 25, 'pending', 'Half term.',
   null, null),
  -- Someone away right now, so the "away today" figure is not always zero.
  ('00000000-0000-0000-0000-0000000000a3', 'vitality', 'site-cc',
   '00000000-0000-0000-0000-0000000000f4', 'sick',
   current_date - 1, current_date + 1, 'approved', 'Signed off by the GP.',
   now(), null),
  -- A training day, pending, to show the non-holiday kinds.
  ('00000000-0000-0000-0000-0000000000a4', 'vitality', 'site-cc',
   '00000000-0000-0000-0000-0000000000f6', 'training',
   current_date + 14, current_date + 14, 'pending', 'Radiography refresher.',
   null, null),
  -- A refused request, so the list shows a decided-and-declined row (and proves a
  -- refused request never blocks a later overlapping one).
  ('00000000-0000-0000-0000-0000000000a5', 'vitality', 'site-ng',
   '00000000-0000-0000-0000-0000000000f7', 'unpaid',
   current_date + 8, current_date + 9, 'refused', null,
   now(), 'Too many people already away that week.');
