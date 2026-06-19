-- 0002_pilot_permissive_rls.sql
--
-- PILOT ONLY. Permissive RLS so the public (anon/publishable) key can read/write
-- the coordinator tables before real Supabase auth + per-site policies exist.
--
-- SECURITY: this is a deliberate, temporary shortcut for the pilot demo, which
-- runs on mock/fixture data only. REPLACE every policy below with auth-bound,
-- site-scoped policies before any real patient data or production deployment.

grant usage on schema public to anon, authenticated;
grant all on treatment_opportunity, coordinator_touch, outbox, sync_state to anon, authenticated;

create policy pilot_all_opportunity on treatment_opportunity for all to anon, authenticated using (true) with check (true);
create policy pilot_all_touch on coordinator_touch for all to anon, authenticated using (true) with check (true);
create policy pilot_all_outbox on outbox for all to anon, authenticated using (true) with check (true);
create policy pilot_all_sync on sync_state for all to anon, authenticated using (true) with check (true);
