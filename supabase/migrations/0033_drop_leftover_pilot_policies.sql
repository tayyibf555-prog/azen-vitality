-- 0033_drop_leftover_pilot_policies.sql
-- DEFENCE-IN-DEPTH: remove the last leftover permissive "pilot" RLS policies.
--
-- 0012_lock_rls.sql locked the database to server-only access by REVOKEing all
-- table privileges from anon/authenticated, and 0019 locked default privileges
-- for new tables. That revoke is the real lock: with no table grant, the public
-- anon/publishable key is denied regardless of any policy (verified live: a
-- SELECT as the anon role returns "permission denied", and anon/authenticated/
-- PUBLIC hold zero grants in information_schema.role_table_grants).
--
-- However, 0012 only dropped the pilot policies it knew about. Twelve tables
-- created in earlier feature migrations (0003-0009) plus reactivation still
-- carry a `for all to anon/authenticated/public using (true)` policy. These are
-- INERT today (no grant to pair with), but they are a latent landmine: a single
-- accidental `GRANT ... TO anon` on one of these tables would instantly make it
-- world-readable/writable, whereas the policy-free tables would stay denied.
-- Dropping them makes every table fail closed the same way. Pure no-op on
-- current access (the server uses the service role, which bypasses RLS).

drop policy if exists pilot_all_agent_conv on agent_conversation;
drop policy if exists pilot_all_agent_msg on agent_message;
drop policy if exists agent_phone_identity_pilot_all on agent_phone_identity;
drop policy if exists pilot_all_agent_settings on agent_settings;
drop policy if exists knowledge_node_pilot_all on knowledge_node;
drop policy if exists practice_brain_gap_pilot_all on practice_brain_gap;
drop policy if exists practice_brain_qa_pilot_all on practice_brain_qa;
drop policy if exists pilot_all_react_cadence on reactivation_cadence;
drop policy if exists pilot_all_react_outbox on reactivation_outbox;
drop policy if exists pilot_all_react_target on reactivation_target;
drop policy if exists pilot_all_react_touch on reactivation_touch;
drop policy if exists pilot_all_webhook_event on webhook_event;

-- Belt and braces: re-assert the lock for anything created since 0012.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
