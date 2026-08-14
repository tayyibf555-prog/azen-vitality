-- 0073_role_staff.sql
-- The FIFTH login level: 'client_staff'.
--
-- Who it is: a nurse, receptionist or practice administrator who needs their OWN
-- rota, their own holiday requests, their own documents and their own policy
-- signatures — and nothing else. Specifically NOT the live diary and NOT the
-- 51,000-patient database, which is why it is a new role rather than a reuse of
-- 'client_clinician' (CLINICIAN_SLUGS grants "calendar" and "patients", and
-- narrowing that set would break the clinician).
--
-- Mirrors 0069_role_clinician.sql exactly, and for the same reason: app_user.role
-- carries a CHECK constraint pinning the roles by name (0011_app_user.sql:13,
-- widened once by 0069). Without this migration a client_staff row simply cannot
-- be inserted, so the role would exist in TypeScript and nowhere else.
--
-- Purely additive: the constraint is dropped and re-added with the same four
-- values plus the new one, so every existing row still satisfies it and no row's
-- role changes. There is deliberately NO seed row — a staff login is created only
-- when the practice names the person (People & Logins, owner-only invite), so
-- nobody gains access by migration.
--
-- Note the constraint name. Postgres auto-names a column CHECK
-- `<table>_<column>_check`, so 0011's inline `check (...)` on `role` is
-- `app_user_role_check`. Dropping it IF EXISTS keeps this migration re-runnable.

alter table app_user drop constraint if exists app_user_role_check;

alter table app_user
  add constraint app_user_role_check
  check (role in (
    'agency_admin',
    'client_owner',
    'client_coordinator',
    'client_clinician',
    'client_staff'
  ));
