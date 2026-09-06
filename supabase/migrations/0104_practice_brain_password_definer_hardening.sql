-- 0104_practice_brain_password_definer_hardening.sql
--
-- APPLIED 6 September 2026 by Fable via the Supabase MCP, after reading it and
-- after running the check 0102's footer said to run first. Ruling W3/35 (the
-- blocked question 0102 raised): yes, harden 0003's function, in its own
-- migration, and only after the pgcrypto schema is known for THIS project.
--
-- ===========================================================================
-- WHAT WAS WRONG
-- ===========================================================================
-- `verify_practice_brain_password(text, text)` (0003) is SECURITY DEFINER over
-- `practice_brain_credential`, the table holding the practice-brain bcrypt hashes.
-- It had NO `set search_path` at all, and — unlike 0101's function — its EXECUTE
-- was never revoked from PUBLIC, so `anon` and `authenticated` both held it.
-- Verified live before this file was written:
--
--     prosecdef            = true
--     proconfig            = null          -- no search_path pinned
--     anon has EXECUTE     = true
--
-- With no pin, Postgres searches the session's own temporary schema FIRST for
-- relation names. `practice_brain_credential` in the body is a relation, so a
-- caller able to CREATE TEMP TABLE of that name would have this definer-rights
-- body verify a submitted password against a hash of their own choosing, and
-- receive back the id, label and TIER of their planted row — the tier being the
-- number that decides how much of the practice brain the session may read.
--
-- REACH IN PRACTICE, stated so nobody over-reads this file: PostgREST exposes no
-- way to run DDL, so neither browser key can create that temp table, and the
-- platform's only caller is server-side with the service-role key
-- (src/lib/practice-brain/repository.ts:329, `serviceClient().rpc(...)`). Nothing
-- was exploitable through this and nothing is. It is fixed because the grant was
-- wider than any caller needs, and because a definer function over a credential
-- table is the last place in this tree to leave a resolution question open.
--
-- ===========================================================================
-- WHY THE PIN NAMES `extensions`, AND WHY THAT CHECK CAME FIRST
-- ===========================================================================
-- The body calls `crypt()`, which comes from pgcrypto. On a Supabase project of
-- this vintage pgcrypto is NOT installed into `public`. Checked on this project
-- before writing a line:
--
--     select extnamespace::regnamespace from pg_extension where extname='pgcrypto';
--     -> extensions
--
-- So a pin of `public, pg_temp` — the shape 0101 and 0102 use, and the obvious
-- copy — would have stopped `crypt` resolving and broken the practice-brain
-- password gate outright the moment it was applied. `extensions` is named ahead of
-- pg_temp for that reason. This is the whole reason 0102 declined to fix it in
-- passing and raised it instead.
--
-- pg_temp is named LAST so the temporary schema is searched last rather than
-- first, which is the property the pin exists for.
--
-- ===========================================================================
-- GRANTS
-- ===========================================================================
-- Same posture as 0101: revoked from PUBLIC first, because that is the grant anon
-- and authenticated actually hold it through — revoking those two by name while
-- leaving PUBLIC's grant in place would change nothing. Service_role's EXECUTE is
-- then granted back explicitly rather than left resting on the grant just removed.
--
-- Verified safe before revoking: the ONLY caller anywhere in the tree is
-- src/lib/practice-brain/repository.ts:329, and it builds its client with
-- `serviceClient()`. No browser-side path calls this rpc.
--
-- `alter function` is used rather than `create or replace` for the same reason
-- 0102 gives: exactly one thing is wrong, and a redefinition would put a second
-- copy of the body in the tree for the two files to drift apart on. The body, the
-- volatility, the SECURITY DEFINER marking and the return type are untouched.
--
-- Every statement here is safe to run twice. If this file is never applied,
-- nothing breaks: the function keeps working exactly as it does today, with the
-- wider grant and the unpinned path that 0003 shipped.

alter function public.verify_practice_brain_password(text, text)
  set search_path = public, extensions, pg_temp;

revoke all on function public.verify_practice_brain_password(text, text)
  from public, anon, authenticated;

grant execute on function public.verify_practice_brain_password(text, text)
  to service_role;

comment on function public.verify_practice_brain_password(text, text) is
  'Verifies a plaintext practice-brain password against the stored bcrypt hash, in the database. SECURITY DEFINER over practice_brain_credential, so search_path names public and extensions (where pgcrypto lives on this project, which is why crypt resolves) ahead of pg_temp, and EXECUTE is held by service_role alone — the platform calls it only from the server.';
