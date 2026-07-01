-- 0031_rota_tenant_hardening.sql
-- Defence-in-depth for multi-tenant isolation on the rota tables (adversarial
-- review). rota_staff.id was a bare UUID primary key, so the shift uniqueness and
-- the shift -> staff foreign key were not scoped by client_id. On their own the
-- application guards (every rota API filters by client_id) prevent cross-tenant
-- writes, but the schema should enforce the tenant boundary too. This:
--   1. adds a composite unique (client_id, id) on rota_staff so it can be an FK target,
--   2. replaces the shift uniqueness with a tenant-scoped one (client_id first,
--      matching the house pattern in 0021 task_overlay),
--   3. replaces the shift -> staff FK with a composite (client_id, staff_id) FK so a
--      shift can only ever reference a staff member of the SAME client.
-- Idempotent, and safe on the existing single-tenant data (all rows are 'vitality').
--
-- NOTE: the app's insertShifts() upsert onConflict is updated in lockstep to
-- (client_id, staff_id, shift_date, start_time) to match constraint (2).

-- 1) Composite unique on rota_staff (FK target for step 3).
alter table rota_staff drop constraint if exists rota_staff_client_id_id_key;
alter table rota_staff add constraint rota_staff_client_id_id_key unique (client_id, id);

-- 2) Tenant-scoped shift uniqueness. Drop the original (client-agnostic) unique.
alter table rota_shift drop constraint if exists rota_shift_staff_id_shift_date_start_time_key;
alter table rota_shift drop constraint if exists rota_shift_client_staff_date_time_key;
alter table rota_shift add constraint rota_shift_client_staff_date_time_key
  unique (client_id, staff_id, shift_date, start_time);

-- 3) Composite FK: a shift's (client_id, staff_id) must match a rota_staff row of
--    the same client. Replaces the client-agnostic staff_id FK. ON DELETE CASCADE
--    is preserved so removing a staff member still removes their shifts.
alter table rota_shift drop constraint if exists rota_shift_staff_id_fkey;
alter table rota_shift drop constraint if exists rota_shift_client_staff_fkey;
alter table rota_shift add constraint rota_shift_client_staff_fkey
  foreign key (client_id, staff_id) references rota_staff (client_id, id) on delete cascade;
