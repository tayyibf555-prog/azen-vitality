-- 0101_previsit_unreadable_and_interest_counts.sql
--
-- APPLIED 5 Sep 2026 by Fable via the Supabase MCP, after reading it in full
-- (ruling W3/33: a lane writes the FILE, Fable applies it). Verified against the
-- live project immediately afterwards: the column is present with default 0; the
-- function is SECURITY DEFINER with a pinned search_path, EXECUTE revoked from
-- public/anon/authenticated and granted to service_role alone. Both halves
-- are additive, and the CODE THAT USES THEM ALREADY SHIPS AND DEGRADES HONESTLY
-- WITHOUT THEM — see each half; the paragraphs below headed "BEFORE THIS IS
-- APPLIED" describe that fallback, which still governs any environment where
-- this file has not been run.
--
-- ONE LINE OF THIS FILE CHANGED AFTER IT WAS APPLIED, AND SAYING SO IS THE POINT.
-- What ran on 5 September was `set search_path = public`. The SET clause below now
-- reads `set search_path = public, pg_temp`, for the reason set out under "THE
-- SEARCH PATH" in part 2 — the short form does not deliver the property the header
-- claimed for it. Nothing else moved: the body, the grants and the column are
-- byte-for-byte what was applied. A database that replays this file from scratch
-- gets the corrected pin directly; the database that has ALREADY run it is brought
-- into step by 0102_interest_counts_search_path.sql, which alters exactly that one
-- clause and nothing else. 0102 was applied on 6 September 2026 and verified, so
-- this file and the live function now agree; between the two applications the
-- live function carried the short pin, which changed no number this platform
-- prints and no caller's rights (see part 2 for why the reach is nil).
--
-- Two unrelated-looking changes, both owed to the same module (pre-visit
-- questions, migration 0097) and both about the same rule: honest numbers or no
-- numbers (charter §0/5, ruling W3/11).
--
-- ===========================================================================
-- 1. previsit_mining_scan.excluded_unreadable  (handoff H40)
-- ===========================================================================
-- 0097 counts the two ways a matched patient is left off the implant list — no
-- date of birth on record, and under 18 — because "a list that silently dropped
-- people is a list nobody can reconcile". There is a THIRD way, and it has been
-- counted in the run report since wave 1 without anywhere to live: a patient the
-- scan could not look up AT ALL. Dentally answers 404 or 410 for a merged or
-- deleted record, and a record can come back with no usable name; either way the
-- appointment matched, the patient was never resolved, and they are on neither
-- the list nor the exclusion sentence beneath it.
--
-- `MiningSiteReport.unreadable` (src/app/api/previsit/_mining.ts) already carries
-- the figure per site. This column is where it lands so the screen can print it,
-- in the same sentence as the other two.
--
-- IT ADDS, IT NEVER REPLACES. Like `examined`, `candidates`, `excluded_no_dob`
-- and `excluded_under_age`, the value accumulates across runs: the window a
-- coverage row describes is everything read so far, and reading cannot be undone.
--
-- BEFORE THIS IS APPLIED (the honest degrade): the repository asks for the column
-- and, on Postgres 42703 / PostgREST PGRST204, re-reads and re-writes without it,
-- reporting `excludedUnreadable: null` — "we do not know" rather than the zero
-- that would be a claim. The exclusion sentence then omits the clause exactly as
-- it does today, and the coverage line is unaffected. What must NOT happen is a
-- bare select naming a column that does not exist: it 42703s the WHOLE coverage
-- read, which fails OPEN — the provenance sentence disappears and the list stays.
alter table previsit_mining_scan
  add column if not exists excluded_unreadable integer not null default 0;

comment on column previsit_mining_scan.excluded_unreadable is
  'Patients the scan matched but could not look up at all (Dentally 404/410, or a record with no usable name). Counted, never assumed adult, and printed beside the other two exclusions. Adds across runs like every other counter on this table.';

-- ===========================================================================
-- 2. interest_counts_by_treatment(text[])  (handoff H77)
-- ===========================================================================
-- How many DISTINCT PATIENTS said yes to each treatment. It is the headline row
-- of the pre-visit screen, the figure the co-pilot reads out, and the number a
-- campaign gets sized on.
--
-- Today it is computed by a keyset walk in the application
-- (countInterestByTreatmentDetailed, src/lib/triage/repository.ts): a page of
-- 1,000 rows at a time, up to a 20,000-row ceiling, past which every figure is a
-- FLOOR and the screen must say "at least N". That walk is correct and it is not
-- being deleted — it stays as this function's fallback — but it pages rows across
-- the network to compute an aggregate Postgres can do where the rows live, and
-- its ceiling exists only because the walk has to terminate.
--
-- This function has no ceiling to hit, so with it applied the counts are exact at
-- any scale and `capped` is always false.
--
-- SECURITY DEFINER, and that is deliberate and is not a widening. treatment_interest
-- has RLS on and no anon/authenticated grants (0097, the 0012 posture), and the
-- platform reads it with the service-role key; this function is called by that
-- same server code. The grants at the foot of this file are what keep the
-- definer's rights from becoming a door for a browser-side key, and they REVOKE
-- FROM PUBLIC rather than from anon and authenticated alone — that is the whole
-- point of them. Postgres grants EXECUTE on a new function to PUBLIC by default,
-- and anon and authenticated inherit it from there, so revoking from those two
-- roles by name leaves the function callable by every browser key the project
-- has. Service-role's own EXECUTE is then granted back explicitly rather than
-- left resting on the PUBLIC grant that has just been removed.
--
-- THE SEARCH PATH IS `public, pg_temp`, AND NAMING pg_temp IS THE WHOLE POINT.
-- The obvious pin — `set search_path = public` — does not do what it looks like it
-- does, and this file said that it did. Postgres searches the session's OWN
-- temporary schema FIRST, ahead of every schema listed and ahead of pg_catalog,
-- PRECISELY WHEN pg_temp is not named in the path; name it, and it is searched
-- where it is named instead. The temporary schema is searched for RELATION names,
-- and `treatment_interest` below is a relation — so under the short pin a caller
-- who can create a temp table of that name has this definer-rights body read THEIR
-- table and hand back whatever they planted, as the pre-visit screen's headline
-- figures and the number the co-pilot reads out.
--
-- NO SUCH CALLER EXISTS TODAY, which is why this is a correction and not an
-- incident: EXECUTE is revoked from public/anon/authenticated and held by
-- service_role alone; service_role already bypasses RLS on this table and could
-- read it directly, so nothing is gained; and anon/authenticated reach this
-- database only through PostgREST, which has no way to CREATE TEMP TABLE. It is
-- fixed anyway, for two reasons that outlive today's grants. A file's header is a
-- claim, and this one claimed a property its SQL did not have (W3/9: copy matches
-- code, never the reverse). And this is the file the NEXT security-definer
-- function in this tree gets copied from — the day one of those is granted to a
-- narrower role that can plant a temp table, the short pin stops being harmless.
-- `set search_path = ''` with every name schema-qualified is the equally correct
-- alternative; it is not used here only because it would rewrite the body of an
-- already-applied function to buy nothing extra.
--
-- STABLE, not VOLATILE: it reads and writes nothing, so the planner may fold it.
--
-- THE BODY QUALIFIES EVERY COLUMN. `RETURNS TABLE (treatment …)` makes `treatment`
-- an OUT parameter, and the table it reads has a column of the same name; an
-- unqualified reference is ambiguous between the two. The alias settles it.
--
-- BEFORE THIS IS APPLIED (the honest degrade): PostgREST answers PGRST202 ("could
-- not find the function"), the repository resolves that — and any other failure —
-- to null and walks the table exactly as it does today. Nothing hangs on the
-- function existing; it makes an already-honest number cheaper and unbounded.
create or replace function interest_counts_by_treatment(p_site_ids text[])
returns table (treatment text, patients bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ti.treatment, count(distinct ti.dentally_patient_id)
  from treatment_interest ti
  where ti.site_id = any(p_site_ids)
    and ti.answer = 'yes'
  group by ti.treatment
$$;

comment on function interest_counts_by_treatment(text[]) is
  'Distinct patients who answered yes, per treatment, for the given sites. The exact form of countInterestByTreatmentDetailed''s keyset walk, which remains the fallback when this function is absent.';

-- Server-only, like every table this module owns. PUBLIC first, because that is
-- the grant anon and authenticated actually hold it through (see the header).
revoke all on function interest_counts_by_treatment(text[]) from public, anon, authenticated;
grant execute on function interest_counts_by_treatment(text[]) to service_role;

-- IF EITHER HALF OF THIS FILE IS NEVER APPLIED, NOTHING BREAKS. The coverage read
-- falls back to the column list without `excluded_unreadable` and reports it as
-- null; the counts fall back to the keyset walk on any rpc failure at all,
-- including a grant that did not land. Both are the behaviour the platform
-- shipped with, and both are honest on their own.
