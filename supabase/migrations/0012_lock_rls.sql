-- 0012_lock_rls.sql
-- LOCK THE DATABASE TO SERVER-ONLY ACCESS.
--
-- *** APPLY ONLY AFTER SUPABASE_SERVICE_ROLE_KEY IS SET in the deployment env. ***
-- serviceClient() prefers the service-role key; once anon access is revoked, all
-- server DB access must use it. Applying this while the app still runs on the
-- public anon key will break every query. Set the key first, redeploy, verify,
-- then apply this.
--
-- Effect: the public anon/publishable key can no longer read or write the
-- database directly (this closes the #1 review finding). RLS stays enabled so
-- the default is deny; the server uses the service role, which bypasses RLS.

-- Drop the permissive pilot policies we know about.
drop policy if exists pilot_all_opportunity on treatment_opportunity;
drop policy if exists pilot_all_touch on coordinator_touch;
drop policy if exists pilot_all_outbox on outbox;
drop policy if exists pilot_all_sync on sync_state;
drop policy if exists pilot_all_suppression on message_suppression;
drop policy if exists pilot_all_recall_target on recall_target;
drop policy if exists pilot_all_recall_cadence on recall_cadence;
drop policy if exists pilot_all_recall_touch on recall_touch;
drop policy if exists pilot_all_recall_outbox on recall_outbox;
drop policy if exists pilot_all_app_user on app_user;

-- The actual lock: revoke direct table/sequence/function access from the public
-- roles. Without table privileges the anon key is denied regardless of any
-- remaining permissive policy. The service_role keeps its access.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
