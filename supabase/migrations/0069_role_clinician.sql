-- 0069_role_clinician.sql
-- The fourth login level: 'client_clinician'.
--
-- app_user.role carries a CHECK constraint that pins EXACTLY the original three
-- roles (0011_app_user.sql:13), and no later migration alters it. Without this
-- migration a clinician row simply cannot be inserted, so the role would exist in
-- TypeScript and nowhere else.
--
-- Purely additive: the constraint is dropped and re-added with the same three
-- values plus the new one, so every existing row still satisfies it and no row's
-- role changes. There is deliberately NO seed row: a clinician login is created
-- only when the practice names the person, so nobody gains access by migration.
--
-- Note the constraint name. Postgres auto-names a column CHECK
-- `<table>_<column>_check`, so 0011's inline `check (...)` on `role` is
-- `app_user_role_check`. Dropping it IF EXISTS keeps this migration re-runnable.

alter table app_user drop constraint if exists app_user_role_check;

alter table app_user
  add constraint app_user_role_check
  check (role in ('agency_admin', 'client_owner', 'client_coordinator', 'client_clinician'));
