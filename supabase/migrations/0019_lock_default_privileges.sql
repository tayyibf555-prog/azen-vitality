-- 0019_lock_default_privileges.sql
-- Defense-in-depth for the post-0012 locked posture.
--
-- 0012 performed a ONE-TIME `revoke all ... from anon, authenticated`, which does
-- NOT cover tables created afterwards (0013-0018) and never set default privileges.
-- In a stock Supabase project, new public-schema tables can still inherit
-- anon/authenticated GRANTs at creation time. Every one of those tables is RLS-on
-- with zero policies (default-deny), so there is no live exposure, but the
-- GRANT-level belt is missing and the posture relies solely on each table
-- remembering to enable RLS.
--
-- This migration adds the missing belt, idempotently:
--   1. Re-revoke on every EXISTING table/sequence/function (removes any inherited
--      grants on the post-0012 tables, including smile_assessment_campaign).
--   2. Set ALTER DEFAULT PRIVILEGES so every FUTURE object is locked automatically,
--      instead of relying on each new migration to remember.
--
-- service_role is intentionally untouched (it bypasses RLS and backs all
-- server-side access); only anon/authenticated are revoked, exactly like 0012.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
