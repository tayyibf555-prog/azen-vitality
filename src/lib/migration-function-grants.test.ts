// A REVOKE THAT NAMES anon AND authenticated BUT NOT public REVOKES NOTHING,
// SO THE MIGRATION DIRECTORY IS CRAWLED FOR ONE.
//
// WHY THIS EXISTS. Postgres grants EXECUTE on a newly created function to PUBLIC
// by default. `anon` and `authenticated` hold that EXECUTE *through* the PUBLIC
// grant, not through a grant of their own, so
//
//     revoke all on function f(...) from anon, authenticated;
//
// removes a grant neither role has, leaves PUBLIC's in place, and both can still
// execute the function afterwards. The statement reads like a lock and is a
// no-op. Ruling W3/35 diagnosed exactly this on
// `verify_practice_brain_password` and migration 0104 fixed it by naming PUBLIC
// first — "revoking those two by name while leaving PUBLIC's grant in place would
// change nothing" (0104, GRANTS section).
//
// THE RULING PRODUCED A FIX, NOT A GUARD, WHICH IS WHY THIS FILE IS HERE.
// The test W3/35 left behind (src/lib/migration-definer-search-path.test.ts:439)
// asserts 0104's two grant statements by name: one hard-coded expectation about
// one file. It cannot see a second instance of the class, and there was one.
// 0023_api_budget.sql shipped `revoke all on function consume_rate_budget(text,
// integer, integer) from anon, authenticated;` in the ineffective form, and it
// was still ineffective when this guard was written — read live off pg_proc on
// 6 September 2026, `proacl` carried the leading `=X` that IS the PUBLIC grant
// and both browser roles returned true for has_function_privilege. 0105 corrects
// the live database and 0023 is corrected in place for a fresh replay; this file
// is the half that stops the third instance arriving unnoticed. W3/17: a
// grep-pinned ruling becomes a behavioural test over the class, not an assertion
// about the one file that happened to be fixed.
//
// WHY A TEST AND NOT A CODE REVIEW. Nothing in this suite executes SQL — the fake
// Supabase client answers `rpc` from fixtures — and there is no migration linter
// in the gates. A scan over the migration DIRECTORY is the only instrument that
// can see this class at all, and it is written over the directory rather than
// over a file list because the next instance will arrive in a migration that does
// not exist yet.
//
// WHAT IT DOES NOT POLICE, ON PURPOSE.
//
//   * TABLE revokes. `revoke all on <table> from anon, authenticated` is the
//     correct and sufficient form: Postgres gives tables NO default PUBLIC grant,
//     so there is nothing for a missing `public` to leave behind. Roughly forty
//     of those statements in this directory are right as they stand.
//   * The BLANKET function revokes in 0012, 0019 and 0033 (`revoke all on all
//     functions in schema public …` and `alter default privileges … revoke all on
//     functions …`). They have the identical hole — 0019 ran AFTER 0023 and did
//     not remove PUBLIC's grant on `consume_rate_budget` either — but revoking
//     PUBLIC's EXECUTE across an entire schema, and changing the default
//     privileges every future function inherits, is a far larger posture change
//     than fixing one named function, and it is a live-gate decision under
//     charter §0 item 12 rather than a lane's. They are listed below as a named,
//     cited exception so a fourth blanket revoke cannot slip in beside them, and
//     they are raised as a BLOCKED question rather than guessed at.
//
// THE COMMENT STRIPPER IS A SECOND COPY, DELIBERATELY. The identical routine sits
// in migration-definer-search-path.test.ts. Importing it would mean importing a
// test file (re-running its describes), and lifting it into a shared module means
// creating a source file outside this lane's directory. It is duplicated with
// this note, and consolidating the two is a handoff. It earns its place here for
// the same reason it does there and one more: 0105's header QUOTES the broken
// statement it exists to correct, so a scan that could not tell prose from SQL
// would fail on the very file that fixes the defect.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// Through import.meta.url, never process.cwd(), so it reads THIS repo's
// migrations and not a worktree copy's (the source-hygiene precedent).
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS = join(REPO_ROOT, "supabase", "migrations");

/**
 * Comments out, everything else byte-for-byte. Dollar-quoted bodies are stepped
 * over intact (a `--` inside a function body is not a comment about the
 * migration), as are string literals and quoted identifiers.
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
      }
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          out += quote + quote;
          i += 2;
          continue;
        }
        out += sql[i];
        i += 1;
        if (sql[i - 1] === quote) break;
      }
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag) {
        const closesAt = sql.indexOf(tag[0], i + tag[0].length);
        const stop = closesAt === -1 ? sql.length : closesAt + tag[0].length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function statementsOf(file: string): string {
  return stripSqlComments(readFileSync(join(MIGRATIONS, file), "utf8"));
}

/** `revoke … on function name(args) from roles;` — every quantifier is `[^;]`, so
 *  a match can never run past the end of its own statement. */
const FUNCTION_REVOKE =
  /\brevoke\s+[^;]*?\bon\s+function\s+([A-Za-z0-9_.]+)\s*\(([^)]*)\)\s*from\s+([^;]+);/gi;
/** `grant … on function name(args) to roles;` — the other half of the house form. */
const FUNCTION_GRANT =
  /\bgrant\s+[^;]*?\bon\s+function\s+([A-Za-z0-9_.]+)\s*\(([^)]*)\)\s*to\s+([^;]+);/gi;
/** Anything at all that revokes something on a function: the non-vacuity yardstick. */
const ANY_FUNCTION_REVOKE = /\brevoke\b[^;]*?\bon\s+function\b/gi;
/** The blanket forms, which are counted and named rather than policed. */
const BLANKET_FUNCTION_REVOKE = /\brevoke\b[^;]*?\bon\s+all\s+functions\s+in\s+schema\b[^;]*;/gi;
const DEFAULT_PRIVILEGE_FUNCTION_REVOKE =
  /\balter\s+default\s+privileges\b[^;]*?\brevoke\b[^;]*?\bon\s+functions\b[^;]*;/gi;

type FunctionAcl = {
  file: string;
  /** `name(args)` normalised: schema prefix dropped, whitespace collapsed, lower-cased. */
  signature: string;
  roles: string[];
};

function normaliseSignature(rawName: string, rawArgs: string): string {
  const name = rawName.replace(/^public\./i, "").toLowerCase();
  const args = rawArgs
    .split(",")
    .map((a) => a.trim().replace(/\s+/g, " ").toLowerCase())
    .filter((a) => a.length > 0)
    .join(", ");
  return `${name}(${args})`;
}

function roleList(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.length > 0);
}

function collect(pattern: RegExp): FunctionAcl[] {
  const found: FunctionAcl[] = [];
  for (const file of migrationFiles()) {
    for (const match of statementsOf(file).matchAll(pattern)) {
      const [, rawName, rawArgs, rawRoles] = match;
      found.push({ file, signature: normaliseSignature(rawName, rawArgs), roles: roleList(rawRoles) });
    }
  }
  return found;
}

const functionRevokes = (): FunctionAcl[] => collect(FUNCTION_REVOKE);
const functionGrants = (): FunctionAcl[] => collect(FUNCTION_GRANT);

function countAcross(pattern: RegExp): number {
  return migrationFiles().reduce((total, file) => total + [...statementsOf(file).matchAll(pattern)].length, 0);
}

// NAMED, CITED, and pinned to the exact statement count, so a fourth blanket
// revoke cannot hide behind the three that are excused. Each entry says which
// file, and why the `public`-naming rule is not simply applied to it.
const BLANKET_REVOKE_BY_EXCEPTION = new Map<string, { statements: number; reason: string }>([
  [
    "0012_lock_rls.sql",
    {
      statements: 1,
      reason:
        "The original server-only lock. `revoke all on all functions in schema public from anon, authenticated` leaves PUBLIC's default EXECUTE in place for exactly the reason this file polices, but revoking PUBLIC across a whole schema also strips it from every extension function installed in `public` and from anything a trigger resolves as a non-owner role. That is a live-gate posture change under charter §0 item 12, not a lane's call, and it is raised as a BLOCKED question by the wave-3d supabase/migrations lane (6 Sep 2026) rather than guessed at.",
    },
  ],
  [
    "0019_lock_default_privileges.sql",
    {
      statements: 2,
      reason:
        "Re-runs 0012's blanket revoke and adds `alter default privileges in schema public revoke all on functions from anon, authenticated`, which likewise does not touch the default PUBLIC grant every future function is created with — which is why 0023, created BEFORE this file ran, still had PUBLIC's EXECUTE on 6 Sep 2026 when it was read live. Same BLOCKED question as 0012; changing a default-privilege rule reaches every function this database will ever have.",
    },
  ],
  [
    "0033_drop_leftover_pilot_policies.sql",
    {
      statements: 1,
      reason:
        "Re-asserts 0012's blanket revoke after dropping the leftover pilot RLS policies. Same statement, same hole, same BLOCKED question.",
    },
  ],
]);

describe("a function revoke in supabase/migrations names PUBLIC, or it revokes nothing", () => {
  it("reads every revoke-on-function statement in the directory, in a form it can parse", () => {
    // A signature that matches nothing passes forever. Counting the parsed
    // statements against a deliberately loose "anything that revokes on a
    // function" pattern makes an unreadable form fail HERE with a sentence,
    // rather than leaving itself silently unpoliced by the rule below.
    const parsed = functionRevokes().length;
    const raw = countAcross(ANY_FUNCTION_REVOKE);
    expect(
      parsed,
      "a revoke-on-function statement in supabase/migrations is written in a form this guard cannot read; teach FUNCTION_REVOKE about it rather than leaving a grant unscanned",
    ).toBe(raw);
    expect(
      raw,
      "no revoke-on-function statements found at all — the path is wrong, or the scan is broken, and this whole file is passing over an empty set",
    ).toBeGreaterThan(0);
  });

  it("every revoke on a named function names public, the grant anon and authenticated actually hold it through", () => {
    const offenders = functionRevokes()
      .filter((r) => !r.roles.includes("public"))
      .map((r) => `${r.file}::${r.signature} (from ${r.roles.join(", ")})`);
    expect(
      offenders,
      `these statements revoke EXECUTE from roles that do not hold it directly and leave PUBLIC's default grant in place, so they lock nothing: ${offenders.join(
        ", ",
      )}. Postgres grants EXECUTE on a new function to PUBLIC; anon and authenticated inherit it from there. Write \`from public, anon, authenticated\` and grant EXECUTE back to service_role explicitly (ruling W3/35; migrations 0101, 0104 and 0105 are the shape to copy).`,
    ).toEqual([]);
  });

  it("every function whose EXECUTE is revoked is granted back to service_role explicitly", () => {
    // The other half of the house form, and the half that makes the revoke safe
    // to write: service_role must not be left resting on the PUBLIC grant that
    // was just removed. It matters more than usual for consume_rate_budget,
    // whose caller (src/lib/rate-budget.ts) fails OPEN on an rpc error — a
    // revoke that caught the real caller would silently stop capping spend on
    // the public AI endpoints rather than raise anything.
    const granted = new Set(
      functionGrants()
        .filter((g) => g.roles.includes("service_role"))
        .map((g) => g.signature),
    );
    const stranded = functionRevokes()
      .filter((r) => !granted.has(r.signature))
      .map((r) => `${r.file}::${r.signature}`);
    expect(
      stranded,
      `EXECUTE is revoked on these functions and never granted back to service_role: ${stranded.join(
        ", ",
      )}. Every one of them is called from the server with the service-role key; leaving its access resting on the grant just revoked is how a lock becomes an outage.`,
    ).toEqual([]);
  });

  it("the three blanket function revokes are a named, cited exception and no fourth has joined them", () => {
    const blanket = migrationFiles()
      .map((file) => ({
        file,
        statements:
          [...statementsOf(file).matchAll(BLANKET_FUNCTION_REVOKE)].length +
          [...statementsOf(file).matchAll(DEFAULT_PRIVILEGE_FUNCTION_REVOKE)].length,
      }))
      .filter(({ statements }) => statements > 0);
    expect(
      blanket.map(({ file, statements }) => `${file}:${statements}`),
      "a schema-wide function revoke has been added, removed or changed in supabase/migrations. These do not remove PUBLIC's default EXECUTE either, and naming PUBLIC in one reaches every function in the schema — a live-gate decision under charter §0 item 12. Add a named, cited entry to BLANKET_REVOKE_BY_EXCEPTION with the reasoning, or take the ruling first.",
    ).toEqual(
      [...BLANKET_REVOKE_BY_EXCEPTION.entries()].map(([file, entry]) => `${file}:${entry.statements}`),
    );
  });
});

describe("the two migrations that carry the consume_rate_budget correction (finding: 0023's ineffective revoke)", () => {
  const FILE_0023 = "0023_api_budget.sql";
  const FILE_0105 = "0105_consume_rate_budget_execute_grants.sql";
  const SIGNATURE = "consume_rate_budget(text, integer, integer)";

  it("0023 is corrected in place, so a database replayed from scratch gets the right grant", () => {
    // ASSERTED OFF THE PARSED STATEMENT, NOT OFF THE FILE'S TEXT — the precedent
    // in migration-definer-search-path.test.ts, whose first draft used
    // `expect(sql).toContain(...)` and survived the mutation because the file's
    // own prose quoted the corrected clause. Both 0023's header and 0105's quote
    // the BROKEN form on purpose; only a scan that reads statements can tell.
    const revoke = functionRevokes().find((r) => r.file === FILE_0023 && r.signature === SIGNATURE);
    expect(revoke, `${FILE_0023} no longer revokes EXECUTE on ${SIGNATURE} in a form this guard can read`).toBeDefined();
    expect(
      revoke?.roles,
      "0023's revoke is back on the ineffective `from anon, authenticated` form; PUBLIC keeps the grant and both browser roles keep EXECUTE",
    ).toEqual(["public", "anon", "authenticated"]);
  });

  it("0105 exists and carries the same correction to the already-applied database", () => {
    // Correcting 0023 alone fixes fresh replays and leaves production exactly as
    // it was — 0023 ran years ago — so the fix is only real if the follow-up
    // migration exists and names the same function. Same argument 0102 makes for
    // 0101 (0102, "WHY A WHOLE MIGRATION FOR ONE CLAUSE").
    expect(
      migrationFiles(),
      `${FILE_0105} is missing: correcting 0023 alone never reaches the applied database, where PUBLIC still holds EXECUTE`,
    ).toContain(FILE_0105);
    const revoke = functionRevokes().find((r) => r.file === FILE_0105 && r.signature === SIGNATURE);
    expect(revoke?.roles, `${FILE_0105} must revoke from public first`).toEqual(["public", "anon", "authenticated"]);
    const grant = functionGrants().find((g) => g.file === FILE_0105 && g.signature === SIGNATURE);
    expect(grant?.roles, `${FILE_0105} must grant EXECUTE back to service_role, the only caller in the tree`).toEqual([
      "service_role",
    ]);
  });
});
