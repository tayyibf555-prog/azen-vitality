-- 0004_reactivation_pilot_rls.sql
--
-- PILOT ONLY. Permissive RLS so the public (anon/publishable) key can read/write
-- the reactivation tables before real Supabase auth + per-site policies exist.
--
-- SECURITY: temporary shortcut for the pilot demo on mock/fixture data only.
-- REPLACE every policy below with auth-bound, site-scoped policies before any
-- real patient data or production deployment.

grant usage on schema public to anon, authenticated;
grant all on reactivation_target, reactivation_cadence, reactivation_touch, reactivation_outbox to anon, authenticated;

create policy pilot_all_react_target on reactivation_target for all to anon, authenticated using (true) with check (true);
create policy pilot_all_react_cadence on reactivation_cadence for all to anon, authenticated using (true) with check (true);
create policy pilot_all_react_touch on reactivation_touch for all to anon, authenticated using (true) with check (true);
create policy pilot_all_react_outbox on reactivation_outbox for all to anon, authenticated using (true) with check (true);
