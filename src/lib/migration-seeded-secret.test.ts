// A PASSWORD COMPILED INTO A MIGRATION IS A PUBLISHED PASSWORD, SO THE
// MIGRATION DIRECTORY IS CHECKED FOR ONE.
//
// WHY THIS EXISTS. 0003_practice_brain.sql seeds the practice-brain credential
// table with three rows whose passwords are written out in full, twice over — in
// the `crypt('…', gen_salt('bf'))` calls of the insert, and in the comment that
// used to sit above it under the heading "rotate after handover". Everyone who
// can read this repository can read them, and they are in its history and in
// docs/superpowers/plans/2026-06-19-practice-brain-foundation.md as well, so
// there is no version of "delete the line" that takes them back.
//
// WHAT THAT REACHES, which is why this is a test and not a lint: the tier-4 row
// seeded there is the ONE credential row that exists for `vitality` in
// production (the manager and coordinator rows were cleaned up, it was not), and
// POST /api/practice-brain/unlock takes a password and nothing else — no
// platform account, no session, and src/proxy.ts excludes `api` from its matcher,
// so it is reachable from the internet. A correct password mints an eight-hour
// `pb_session` carrying maxTier 4, and `tree`/`ask` then serve every tier of the
// practice's knowledge base. The unlock rate caps stop guessing; a password that
// is already known needs one attempt.
//
// WHAT THIS TEST CAN AND CANNOT DO. It cannot rotate anything — that is a change
// to a live gate, a BLOCKED question for Fable under charter §0 item 12, and it
// is recorded as one. What it CAN do is stop the next seeded secret from arriving
// unnoticed, and make the one that is already here impossible to leave lying
// around silently: 0003 is carried below as a NAMED, CITED exemption pinned to
// the exact shape of its seed, so the day somebody rotates and strips the file,
// this test goes red and the exemption has to be deleted on purpose. A guard that
// only ever agreed with the tree would be decoration; this one has to be argued
// with before the tree can change.
//
// THE SIGNATURE. `crypt('<literal>', …)` — a string literal where the password
// goes. `crypt(p_password, c.password_hash)` in the verify function is the
// correct shape and does not match; neither does prose that mentions `crypt()`,
// because only statements are scanned.

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

/** A migration's statements: whole-line `--` comments dropped, so a file that
 *  merely writes about a seeded password is not accused of containing one. */
function statementsOf(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** `crypt('…'` — a plaintext first argument. The literal itself is never
 *  captured or printed: this counts occurrences, it does not repeat secrets. */
const PLAINTEXT_CRYPT = /\bcrypt\s*\(\s*'/gi;

function plaintextSeedCount(file: string): number {
  return [...statementsOf(file).matchAll(PLAINTEXT_CRYPT)].length;
}

// NAMED, CITED, and pinned to a shape rather than to a name, so it cannot quietly
// cover more than it was written for. `occurrences` is what the seed holds today;
// any change to it — a fourth password added, or the seed stripped after the
// rotation — reddens this file and forces the entry to be reconsidered.
const SEEDED_PLAINTEXT_BY_EXCEPTION = new Map<string, { occurrences: number; reason: string }>([
  [
    "0003_practice_brain.sql",
    {
      occurrences: 3,
      reason:
        "Predates the Dental OS programme and is outside its diff, so no secret scan in this repository has ever looked at it. Its three seeded practice-brain passwords are published — in the statement, in this file's git history, in eight worktrees under .claude/worktrees, and in docs/superpowers/plans/2026-06-19-practice-brain-foundation.md — and the tier-4 Owner row it seeds is the one credential row still live for `vitality` in production (ruling W3/35 recorded the count; wave-3 verification identified the survivor, 6 Sep 2026). Removing the literals here would rotate nothing and would hide which password the live hash answers to, so the order is: rotate in the live database first, then strip this file and the plan doc, then delete this entry. The rotation changes the security posture of a live, internet-reachable gate, so it is a BLOCKED question for Fable under charter §0 item 12 and not a thing this lane decided.",
    },
  ],
]);

describe("no migration compiles a plaintext password into the database", () => {
  it("scans statements, not prose, and finds the seed it is calibrated against", () => {
    // A signature that matches nothing passes forever. If PLAINTEXT_CRYPT ever
    // stops seeing the one seed in the tree, this fails here with a sentence
    // rather than letting the rule below go green over an empty scan.
    const seen = migrationFiles().filter((file) => plaintextSeedCount(file) > 0);
    expect(
      seen,
      "the plaintext-password signature no longer matches anything in supabase/migrations; either the seed was removed (delete the exemption below and this expectation with it) or the scan is broken",
    ).toEqual(["0003_practice_brain.sql"]);
  });

  it("every plaintext-seeded password is a named, cited exemption", () => {
    const offenders = migrationFiles()
      .map((file) => ({ file, count: plaintextSeedCount(file) }))
      .filter(({ file, count }) => count > (SEEDED_PLAINTEXT_BY_EXCEPTION.get(file)?.occurrences ?? 0))
      .map(({ file, count }) => `${file} (${count} plaintext crypt() argument${count === 1 ? "" : "s"})`);
    expect(
      offenders,
      `these migrations write a password into SQL in plaintext: ${offenders.join(", ")}. A migration is committed, cloned and kept in history, so a password in one is published the moment it is written. Seed a hash generated out of band, or leave the credential to be issued by hand — and if there is genuinely no other way, add a named, cited entry to SEEDED_PLAINTEXT_BY_EXCEPTION saying why and what the rotation plan is.`,
    ).toEqual([]);
  });

  it("the exemption still describes the seed it was written for", () => {
    const drifted = [...SEEDED_PLAINTEXT_BY_EXCEPTION.entries()]
      .filter(([file, entry]) => plaintextSeedCount(file) !== entry.occurrences)
      .map(([file, entry]) => `${file} (recorded ${entry.occurrences}, found ${plaintextSeedCount(file)})`);
    expect(
      drifted,
      `named exemptions that no longer match the seed they excuse: ${drifted.join(", ")}. If the count went DOWN the rotation has happened — strip the rest and delete the entry. If it went UP, a new plaintext password was added to a file that was excused for the old ones, which the exemption does not cover.`,
    ).toEqual([]);
  });
});
