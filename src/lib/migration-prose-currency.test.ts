// A MIGRATION'S PROSE IS READ AS THE CURRENT STATE OF THE DATABASE, SO IT IS
// CHECKED AGAINST THE MIGRATIONS THAT CAME AFTER IT.
//
// WHY THIS EXISTS. Migration 0102 hardened one SECURITY DEFINER function and
// closed with a long paragraph about the tree's OTHER one,
// `verify_practice_brain_password` — the definer over the practice-brain
// credential table. That paragraph said, in the present tense, that the function
// "pins no search_path at all" and that "EXECUTE on it was never revoked from
// PUBLIC, so unlike this function it is callable by the browser keys". Both
// sentences were true when they were written and both stopped being true on
// 6 September 2026, when 0104 pinned `public, extensions, pg_temp` on it, revoked
// EXECUTE from PUBLIC/anon/authenticated and granted it to service_role alone
// (ruling W3/35 — the check 0102's own footer demanded).
//
// Nothing noticed. No test in this suite reads a migration for what it CLAIMS,
// the search_path guard next door parses `create function` headers and cannot see
// an `alter function` at all, and a migration directory is read in NUMBER order by
// anyone auditing it — so the last long description of that function was one that
// described the state 0104 had already closed. The cost of that is not academic:
// the next security reviewer either re-opens a closed ledger item, or records that
// anon holds EXECUTE over the bcrypt hashes, which is exactly wrong.
//
// THE RULE, STATED AS A RULE RATHER THAN AS THIS ONE FILE'S BUG. If migration M
// alters a function's `search_path`, then every EARLIER migration whose comments
// discuss that function is describing a state M changed, and must cite M. Citing
// it is all that is asked — a paragraph may still describe the old state at
// length (0102's now does, in the past tense, because that state still governs a
// database replayed from scratch that stops before 0104) as long as the reader is
// pointed at the file that closed it.
//
// WHY COMMENTS AND STATEMENTS ARE SPLIT. The rule is about prose, so a mention
// inside the SQL itself must not trip it: 0003 names the function only in its own
// `create or replace function` line, and 0003 is not making a claim about a later
// state by defining it. Whole-line `--` comments are the prose; everything else is
// the statement.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// Through import.meta.url, never process.cwd(), so it reads THIS repo's
// migrations and not a worktree copy's (the source-hygiene precedent).
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS = join(REPO_ROOT, "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/** Whole-line `--` comments only: the file's prose. */
function commentsOf(file: string): string {
  return readMigration(file)
    .split("\n")
    .filter((line) => line.trimStart().startsWith("--"))
    .join("\n");
}

/** Everything that is not a whole-line comment: the file's statements. */
function statementsOf(file: string): string {
  return readMigration(file)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** The migration number a file leads with — what a citation has to name. */
function numberOf(file: string): string {
  return file.slice(0, 4);
}

const ALTER_PIN = /alter\s+function\s+(?:public\.)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*set\s+search_path\s*=/gi;

/**
 * function name -> the FIRST migration whose statements alter its search_path.
 * Read off statements, so a file that merely writes about hardening cannot
 * present itself as the file that did it.
 */
function pinAlterations(): Map<string, string> {
  const byFunction = new Map<string, string>();
  for (const file of migrationFiles()) {
    for (const [, name] of statementsOf(file).matchAll(ALTER_PIN)) {
      const key = name.toLowerCase();
      if (!byFunction.has(key)) byFunction.set(key, file);
    }
  }
  return byFunction;
}

describe("a migration's prose keeps up with the migrations that came after it", () => {
  it("finds the alter-function pins it is supposed to be reasoning about", () => {
    // A rule that matches nothing passes forever. If the parse breaks, or every
    // hardening migration is deleted, this fails here with a sentence instead of
    // letting the two rules below go quietly green over an empty set.
    expect(
      [...pinAlterations().keys()].sort(),
      "no `alter function ... set search_path` statement found in supabase/migrations; either the parse is broken or the hardening migrations (0102, 0104) are gone",
    ).toEqual(["interest_counts_by_treatment", "verify_practice_brain_password"]);
  });

  it("every earlier migration that discusses a hardened function cites the migration that hardened it", () => {
    const offenders: string[] = [];
    for (const [fn, hardener] of pinAlterations()) {
      for (const file of migrationFiles()) {
        if (file >= hardener) continue;
        if (!commentsOf(file).toLowerCase().includes(fn)) continue;
        if (commentsOf(file).includes(numberOf(hardener))) continue;
        offenders.push(`${file} discusses ${fn} without naming ${hardener}`);
      }
    }
    expect(
      offenders,
      `these migrations describe a function as it was before a later migration changed it, with nothing pointing the reader at that migration: ${offenders.join("; ")}. Name the later file in the paragraph — the old state may still be described at length, in the past tense, because it governs a database replayed from scratch that stops before it.`,
    ).toEqual([]);
  });

  it("no migration still claims in the present tense that a hardened function pins no search_path", () => {
    // The exact sentence that went stale, kept as a regression guard rather than
    // a general grammar check: the citation rule above is what catches the class,
    // and this is what catches the revert.
    const offenders = migrationFiles()
      .filter((file) => /\bpins no search_path\b/i.test(commentsOf(file)))
      .map((file) => `${file}`);
    expect(
      offenders,
      `these migrations say a definer function "pins no search_path" in the present tense: ${offenders.join(", ")}. 0104 pinned verify_practice_brain_password on 6 September 2026 (ruling W3/35); describe the unpinned state in the past tense and say which file closed it.`,
    ).toEqual([]);
  });
});
