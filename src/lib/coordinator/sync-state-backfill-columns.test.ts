// THE SYNC BACKFILL CURSOR LIVES IN TWO sync_state COLUMNS, AND WHETHER A
// MIGRATION DECLARES THEM IS CHECKED HERE, BECAUSE NOTHING ELSE IN THIS SUITE
// CAN SEE IT.
//
// WHY THIS EXISTS. `getBackfillCursor` / `setBackfillCursor` below in
// repository.ts read and write `sync_state.backfill_page` and
// `sync_state.backfill_done`. `sync_state` IS created by a migration
// (0001_treatment_coordinator.sql) — with four columns, and neither of those two
// among them. The pair was added out of band, directly in Supabase, by commit
// e28db19, whose own message says so ("Migration: sync_state gains backfill_page
// (int) + backfill_done (bool default false), applied to prod") while touching no
// file under supabase/. Until 0106 there was no statement anywhere in this
// repository that created them.
//
// That is a worse shape than the four reactivation_* tables, which have no
// `create table` in the tree either: those are DECLARED as out-of-band in
// fake-supabase's MISSING_FROM_MIGRATIONS, with a paragraph saying that their real
// constraints are invisible from the codebase. `sync_state` looked FULLY migrated.
// The table is there, its four columns are there, and nothing signalled that the
// live shape was wider than the file.
//
// WHAT IT REACHED. Nothing in production, which already has both columns — this
// class of defect is latent by construction and bites the database nobody is
// watching. On any database replayed from supabase/migrations (a staging project,
// a Supabase branch, a rebuild after an incident) `getBackfillCursor` is the FIRST
// thing each of the three registered syncs does per site — app-sync-coordinator,
// app-sync-recall, app-sync-reactivation — and it re-raises the PostgREST error
// rather than tolerating 42703, so all three fail every tick from the first one.
// The route then reports `String(e)` on a PostgrestError, i.e. "[object Object]",
// which is why this had to be caught in the repository and not in an incident.
//
// WHY NO EXISTING TEST COULD CATCH IT. The in-memory fake ignores the select
// projection entirely and its store accepts arbitrary keys on upsert, so a
// round-trip through a `sync_state` carrying NEITHER column is green: both reads
// come back `undefined`, `getBackfillCursor` normalises that to
// `{ page: null, done: false }`, and "the backfill has not started yet" is a
// perfectly plausible answer. Every backfill test in the tree therefore passes
// against a schema the code cannot actually run on. Reading the migration
// directory is the only instrument this suite has for the class — the same
// instrument, for the same reason, as migration-interest-index.test.ts and
// migration-definer-search-path.test.ts.
//
// SO THE RULE IS WRITTEN AS A RULE, NOT AS THESE TWO COLUMNS (W3/17). Every
// `backfill_*` column this module names must be declared by a migration; a third
// one added in code without a migration goes red here on the day it is written,
// not on the day somebody rebuilds the database.
//
// AND IT READS THE MIGRATIONS THROUGH `migrationSchema()` — the fake's own reader
// — rather than grepping the text. That is deliberate: the reader captures one
// column per `add column` statement, so a single combined
// `add column a …, add column b …` is HALF read, and a guard that grepped for the
// two names would call that shape declared while the fake silently lost the
// second column. Asserting through the reader is the only form of this assertion
// that goes red when the mock and live drift apart, which is the whole point.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { migrationSchema } from "@/lib/test-support/fake-supabase";

// Through import.meta.url, never process.cwd(), so it reads THIS repo (the
// source-hygiene precedent).
const REPOSITORY_TS = fileURLToPath(new URL("./repository.ts", import.meta.url));

// A line comment or a block comment is prose, not code that names a column.
function stripTsComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

/** Every `backfill_*` column name the module's CODE (not its comments) names. */
function backfillColumnsNamedInCode(): string[] {
  const code = stripTsComments(readFileSync(REPOSITORY_TS, "utf8"));
  const found = new Set<string>();
  for (const m of code.matchAll(/\bbackfill_[a-z0-9_]+\b/g)) found.add(m[0]);
  return [...found].sort();
}

function syncStateColumns(): Map<string, (() => unknown) | null> {
  const def = migrationSchema().get("sync_state");
  expect(def, "supabase/migrations declares no `sync_state` table at all").toBeTruthy();
  return new Map(def!.columns.map((c) => [c.name, c.default]));
}

describe("sync_state backfill cursor columns", () => {
  it("names both cursor columns in code, so the scan below is not vacuously empty", () => {
    // Without this, deleting the two reads would make every assertion here pass.
    expect(backfillColumnsNamedInCode()).toEqual(["backfill_done", "backfill_page"]);
  });

  it("declares every backfill_* column the coordinator repository names in a migration", () => {
    const declared = syncStateColumns();
    const undeclared = backfillColumnsNamedInCode().filter((c) => !declared.has(c));
    expect(
      undeclared,
      `sync_state.${undeclared.join(", sync_state.")} is read or written by ` +
        "src/lib/coordinator/repository.ts and created by no migration. A database " +
        "replayed from supabase/migrations fails 42703 on the first tick of " +
        "app-sync-coordinator, app-sync-recall and app-sync-reactivation. Add the " +
        "column in its own `alter table ... add column` statement (one per " +
        "statement — the schema reader captures one column per statement).",
    ).toEqual([]);
  });

  it("gives backfill_done the live default (false) so a replayed database matches production", () => {
    // Read live off information_schema on 6 September 2026, project
    // qoiyaiiajdqydyrccixt: backfill_done boolean NOT NULL default false;
    // backfill_page integer, nullable, no default. A migration that omitted the
    // default would leave existing rows null, and `done ?? false` would then read
    // "not finished" forever — the sync would re-enter backfill on every tick.
    const declared = syncStateColumns();
    const done = declared.get("backfill_done");
    expect(done, "backfill_done must carry a default").toBeTruthy();
    expect(done!()).toBe(false);
    expect(declared.get("backfill_page") ?? null, "backfill_page takes no default live").toBeNull();
  });

  it("keeps sync_state's four original columns, so 0106 adds and never replaces", () => {
    const declared = syncStateColumns();
    for (const column of ["site_id", "resource", "high_water_mark", "last_run_at"]) {
      expect(declared.has(column), `sync_state.${column} (0001) has gone missing`).toBe(true);
    }
  });
});
