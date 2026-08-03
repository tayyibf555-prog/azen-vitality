-- 0068_staff_clock.sql
-- Staff clocking in and out (the `staff-check-in` module).
--
-- APPEND-ONLY EVENT LOG, deliberately. The obvious shape is a mutable "worked
-- shift" row with clock_in / clock_out columns, updated in place. That shape
-- cannot represent the thing that actually happens in a practice: somebody
-- forgets to clock out. An update-in-place row then either sits with a null
-- clock_out forever (indistinguishable from "still here") or gets quietly
-- corrected by whoever notices, and the correction overwrites the evidence.
--
-- So we store the taps, not the conclusion. A session is DERIVED by pairing the
-- events (src/lib/clock/pairing.ts), which makes a missed clock-out a visible
-- exception the practice manager can see and explain rather than a corrupt row.
-- This is the same reasoning 0066_perio.sql applies to clinical findings: the
-- record of what was recorded is worth more than a tidy summary of it.
--
-- Created in the POST-0012 locked posture: RLS is enabled but NO grants/policies
-- are issued to anon/authenticated (0012 revoked those across the schema). All
-- access is server-only via the service-role client, like 0030/0031.
--
-- NOT APPLIED BY THIS BUILDER. Written only; the orchestrator applies it.
--
-- British English throughout. No dash characters in copy.

-- ---------------------------------------------------------------------------
-- 1) The identity link: which login (if any) IS this staff member.
--
-- rota_staff has an `email` column but no foreign key to app_user, so "staff
-- clock in on their own phone" had nothing to authenticate against. Without
-- this, the only safe endpoint is a manager-recorded one; a staffId taken from
-- the request body would let anyone clock anyone.
--
-- Nullable on purpose: most staff on the rota have no login at all, and that is
-- the normal state, not a missing value to be back-filled. A null simply means
-- self-service clocking is unavailable for that person and the practice manager
-- records their attendance instead.
-- ---------------------------------------------------------------------------
alter table rota_staff
  add column if not exists app_user_id uuid references app_user (id) on delete set null;

-- The self-service path resolves the caller's staff row from their session on
-- every clock action, scoped to their client.
create index if not exists idx_rota_staff_client_app_user
  on rota_staff (client_id, app_user_id);

-- One login must not map to two staff rows in the same client, or "who am I"
-- has no answer. Partial, so the many null rows are unaffected.
create unique index if not exists uniq_rota_staff_client_app_user
  on rota_staff (client_id, app_user_id)
  where app_user_id is not null;

-- ---------------------------------------------------------------------------
-- 2) The event log itself.
--
-- source carries 'nfc' from day one even though nothing writes it yet: the NFC
-- tag path (a cryptographic NTAG 424 DNA tag emitting a fresh signed code per
-- tap) is a later addition, and it should not need a migration to land.
-- recorded_by is the login that PRESSED the button, which for a manager-recorded
-- event is somebody other than staff_id, and that difference is the audit trail.
-- ---------------------------------------------------------------------------
create table if not exists staff_clock_event (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  site_id text not null,
  staff_id uuid not null,
  kind text not null check (kind in ('in', 'out')),
  occurred_at timestamptz not null default now(),
  source text not null default 'manual'
    check (source in ('manual', 'nfc', 'kiosk', 'admin')),
  recorded_by uuid references app_user (id) on delete set null,
  note text,
  created_at timestamptz default now(),
  -- The 0031 lesson: a bare staff_id FK is not tenant-scoped. The composite FK
  -- means an event can only ever reference a staff member of the SAME client.
  -- Targets rota_staff_client_id_id_key, added at 0031_rota_tenant_hardening.sql.
  constraint staff_clock_client_staff_fkey
    foreign key (client_id, staff_id) references rota_staff (client_id, id) on delete cascade
);

-- Pairing reads one staff member's events for a day, in time order; the manager
-- view reads a whole client's day. Both are served by this index.
create index if not exists idx_staff_clock_client_staff_time
  on staff_clock_event (client_id, staff_id, occurred_at);

-- Server-only: RLS on, no anon/authenticated grants (consistent with 0012 / 0030).
alter table staff_clock_event enable row level security;
