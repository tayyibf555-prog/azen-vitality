-- 0106_sync_state_backfill_cursor_columns.sql
--
-- NOT YET APPLIED AS A MIGRATION. A lane writes the FILE; Fable reads it and
-- applies it via the Supabase MCP (ruling W3/33). Nothing here is destructive and
-- every statement is safe to run twice.
--
-- BUT READ THE NEXT PARAGRAPH BEFORE PLANNING THE APPLY, because this file is not
-- like the others: BOTH COLUMNS ALREADY EXIST IN PRODUCTION. They were added out
-- of band, directly in Supabase, and the file that should have carried them was
-- never written. Applying this to production is therefore an idempotent no-op --
-- both statements are `if not exists` and both match the live shape exactly. The
-- database this file actually changes is a FRESH one: a staging project, a
-- Supabase branch, a rebuild after an incident, anything replayed from
-- supabase/migrations. That database is broken today and this is the fix.
--
-- ===========================================================================
-- WHAT IS WRONG, IN ONE LINE
-- ===========================================================================
-- `sync_state` is created by 0001_treatment_coordinator.sql with FOUR columns:
--
--     create table if not exists sync_state (
--       site_id text not null,
--       resource text not null,
--       high_water_mark timestamptz,
--       last_run_at timestamptz,
--       primary key (site_id, resource)
--     );
--
-- The live table has SIX. `backfill_page` and `backfill_done` are read and written
-- by three ACTIVE syncs and are declared by no migration anywhere in this
-- directory. The table itself is present, fully migrated to look at, so nothing in
-- the repo signals that its real shape is wider than the repo says it is.
--
-- ===========================================================================
-- READ LIVE BEFORE THIS FILE WAS WRITTEN
-- ===========================================================================
-- Project qoiyaiiajdqydyrccixt, read-only select on information_schema.columns,
-- 6 September 2026 -- the shape the two statements below reproduce exactly:
--
--     site_id          text                        not null
--     resource         text                        not null
--     high_water_mark  timestamp with time zone    nullable
--     last_run_at      timestamp with time zone    nullable
--     backfill_page    integer                     nullable   no default
--     backfill_done    boolean                     NOT NULL   default false
--
-- PROVENANCE, so nobody has to guess how this happened. Commit e28db19
-- ("fix(go-live): store reactivation backfill cursor in proper columns (not
-- high_water_mark)") states in its own message: "Migration: sync_state gains
-- backfill_page (int) + backfill_done (bool default false), applied to prod."
-- `git show --name-only e28db19` touches five files and not one of them is under
-- supabase/. The DDL went in through the MCP; the file was never written.
--
-- ===========================================================================
-- WHAT BREAKS WITHOUT IT, STATED SO NOBODY OVER- OR UNDER-READS IT
-- ===========================================================================
-- NOTHING IN PRODUCTION TODAY. Production has the columns. This is latent.
--
-- ON A DATABASE REPLAYED FROM THIS REPO, three registered pg_cron syncs fail on
-- their first tick and never recover, because `getBackfillCursor`
-- (src/lib/coordinator/repository.ts) is the FIRST thing each of them does per
-- site and it re-raises the PostgREST error rather than tolerating 42703:
--
--     src/app/api/sync/coordinator/route.ts:328     app-sync-coordinator
--     src/app/api/sync/recall/route.ts:217          app-sync-recall
--     src/app/api/sync/reactivation/route.ts:309    app-sync-reactivation
--
-- The failure is also badly disguised. The route reports `String(e)` on a
-- PostgrestError, which renders as "[object Object]" -- so the operator sees three
-- broken syncs, an unusable error string, and a `sync_state` table that is present
-- and correct as far as any file in the repository can tell.
--
-- WHY NO TEST CAUGHT IT. The in-memory fake (src/lib/test-support/fake-supabase.ts)
-- ignores the select projection entirely and its store accepts arbitrary keys on
-- upsert, so a round-trip through a `sync_state` that has neither column is green:
-- the read returns `undefined` for both, `getBackfillCursor` normalises that to
-- `{ page: null, done: false }`, and "the backfill has not started yet" is a
-- perfectly plausible answer. The guard that closes this for the class rather than
-- for these two columns is src/lib/coordinator/sync-state-backfill-columns.test.ts,
-- written in the same change as this file (W3/17: a ruling becomes a behavioural
-- test over the class, not an assertion about the one instance that was fixed).
--
-- ===========================================================================
-- WHY THIS IS TWO STATEMENTS AND NOT ONE
-- ===========================================================================
-- Not style. The fake's schema reader matches
--
--     /alter\s+table\s+...\s+add\s+column\s+...([^;]*);/gi
--
-- which captures ONE column name per statement. A single
-- `add column a ..., add column b ...` would be half-read: the fake would gain
-- `backfill_page`, silently miss `backfill_done`, and the mock would once again be
-- more generous than live -- the one thing fake-supabase's own header says it must
-- never be. Two statements keep the fake, the repo and the live table agreeing,
-- and the guard test asserts BOTH columns through that same reader, so collapsing
-- them back into one statement goes red.
--
-- `if exists` / `if not exists` throughout: safe on production (where both columns
-- are already there), safe on a fresh replay, safe run twice.
alter table if exists sync_state
  add column if not exists backfill_page integer;

alter table if exists sync_state
  add column if not exists backfill_done boolean not null default false;

comment on column sync_state.backfill_page is
  'One-time historical-backfill cursor: the last COMPLETED page number for this (site, resource). Null means the pass has not started. It cannot live in high_water_mark, which is timestamptz -- writing a page number there was the bug commit e28db19 fixed.';

comment on column sync_state.backfill_done is
  'False (the default, and the value every pre-existing row takes) means the one-time full pass has not finished, so the sync stays in backfill. Set true in the SAME upsert that seeds high_water_mark, so a partial write can never leave done=true with an unset mark.';
