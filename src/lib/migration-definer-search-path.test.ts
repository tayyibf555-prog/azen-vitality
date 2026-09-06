// A SECURITY DEFINER FUNCTION'S search_path IS PART OF ITS SECURITY, SO IT IS
// CHECKED LIKE ONE.
//
// WHY THIS EXISTS. Migration 0101 added `interest_counts_by_treatment`, the
// function behind the pre-visit screen's headline "how many patients said yes to
// each treatment" and the number the co-pilot reads out when a campaign is being
// sized. It is SECURITY DEFINER — deliberately, so the server can read a table the
// browser keys cannot — and it was written with the pin everybody writes:
//
//     set search_path = public
//
// and a header sentence claiming that this meant "a definer-rights body cannot be
// resolved against a caller-controlled schema". It does not mean that. Postgres
// searches the session's OWN temporary schema FIRST — ahead of every schema named
// in the path, and ahead of pg_catalog — PRECISELY WHEN pg_temp is not named in
// the path. Name it, and it is searched where it is named. The temporary schema is
// searched for RELATION names, and `treatment_interest` inside that function is a
// relation, so with the short pin a caller able to create a temp table of that
// name has the definer-rights body read THEIR table and return whatever they
// planted — printed on screen as the practice's own figures.
//
// WHAT THE REACH WAS, STATED HONESTLY: nil. EXECUTE on that function is revoked
// from public/anon/authenticated and granted to service_role alone; service_role
// already bypasses RLS on that table and could read it directly; and
// anon/authenticated reach the database only through PostgREST, which offers no
// way to CREATE TEMP TABLE. Nothing was exploitable. What was wrong was a file
// claiming a property its SQL did not have (W3/9: copy matches code, never the
// reverse) — in the file that the next definer function in this tree gets copied
// from. This guard exists so the copy is the corrected one.
//
// WHY A TEST AND NOT A CODE REVIEW. Nothing in this suite executes SQL: the fake
// Supabase client answers `rpc` from fixtures, so every test of the interest
// counts exercises either a stubbed reply or the keyset-walk fallback and none of
// them can observe how Postgres resolves a name. There is no migration linter in
// the gates either. A grep over the tree is the only instrument that can see this
// class at all, so it is written as one — over the migration DIRECTORY, not over
// one file, because the defect is a pattern and the next instance of it will
// arrive in a file that does not exist yet.
//
// IT READS `alter function` TOO, BECAUSE THAT IS HOW THIS TREE CHANGES A PIN.
// The first version of this guard parsed `create [or replace] function` and
// nothing else, which made it blind to the exact statement both hardening
// migrations in the programme are written as: 0102 and 0104 each pin an
// already-applied function with `alter function … set search_path = …`, and both
// argue at length (0102 lines 51-57) that ALTER is preferred to a redefinition
// precisely because it leaves the body alone. A guard that cannot read the house
// form for the change it polices is decoration: a later migration could have
// dropped `pg_temp` off the interest counter, or marked a plain function
// `security definer`, and every count here would still have balanced. So the scan
// now folds ALTERs onto the function they name, in migration order, last write
// wins — which is what a replay of the directory actually produces — and the
// non-vacuity check below counts ALTER statements as well, so an ALTER written in
// a shape this file cannot read fails loudly instead of passing invisibly.
//
// Two consequences worth stating. The fold keys on the bare function name (this
// tree has no overloaded functions); if one is ever added, the fold must key on
// argument types too, and until it does an ALTER would land on the wrong
// signature. And an ALTER naming a function this directory never creates is a
// hard failure rather than a shrug — the guard cannot reason about a definition
// it has not seen.
//
// THE EXEMPTION LIST IS NOW EMPTY, AND THAT IS THE POINT. It carried one entry:
// `verify_practice_brain_password` (0003), whose CREATE pins no search_path at
// all, with a reason saying the pgcrypto schema was unverified on this project and
// that a blind `public, pg_temp` pin could stop `crypt()` resolving. Ruling W3/35
// closed that: pgcrypto was read live (it is in `extensions`), migration 0104 was
// written and APPLIED on 6 September, and the password gate was exercised after.
// With ALTERs folded in, 0003+0104 resolves to `public, extensions, pg_temp` and
// the function is simply pinned — no exemption needed. The list stays here,
// empty, because the shape is load-bearing: a future entry has to be named, cited
// and defended, and the staleness test below now has the reach to notice when one
// stops describing something real, ALTER-delivered fixes included.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// Through import.meta.url, never process.cwd(), so it reads THIS repo's
// migrations and not a worktree copy's (the source-hygiene precedent).
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS = join(REPO_ROOT, "supabase", "migrations");

type DefinerFunction = {
  /** The migration that CREATEd it — where the SECURITY DEFINER marking is declared. */
  file: string;
  name: string;
  /** The SET clause on the CREATE statement itself, or null when it has none. */
  declaredSearchPath: string | null;
  /** The SET clause after every later `alter function` is folded on, in migration order. */
  searchPath: string | null;
  /** The migration whose statement set `searchPath` to its current value. */
  pinnedBy: string;
};

/**
 * Everything between `create [or replace] function` and the `$…$` that opens the
 * body: the name, the arguments, the RETURNS clause, and the option list where
 * `security definer` and `set search_path` live. Bodies are deliberately not
 * parsed — the property under test is entirely in the header.
 */
const FUNCTION_HEADER = /create\s+(?:or\s+replace\s+)?function\s+([A-Za-z0-9_.]+)\s*\(([\s\S]*?)\bas\s*\$/gi;
const ANY_CREATE_FUNCTION = /create\s+(?:or\s+replace\s+)?function\b/gi;
/** `alter function name(args) <actions>;` — the actions run to the first semicolon. */
const ALTER_FUNCTION = /alter\s+function\s+([A-Za-z0-9_.]+)\s*\(([^)]*)\)([^;]*);/gi;
const ANY_ALTER_FUNCTION = /alter\s+function\b/gi;
const SEARCH_PATH_SET = /\bset\s+search_path\s*(?:=|to)\s+([^\n;]*)/i;

/**
 * Comments out, everything else byte-for-byte. Both scans below are text scans, and
 * this file's own 0101 assertion once survived a mutation because a substring
 * search could not tell a comment from a statement — the same trap, one level up:
 * 0102 and 0104 both discuss `alter function` in their prose, so an unstripped scan
 * would count six ALTER statements where the directory has two. Dollar-quoted
 * bodies are stepped over intact (a `--` inside a function body is not a comment
 * about the migration), as are string literals and quoted identifiers.
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

function readMigration(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

function statementsOf(file: string): string {
  return stripSqlComments(readMigration(file));
}

function normaliseName(raw: string): string {
  return raw.replace(/^public\./i, "").toLowerCase();
}

function clause(raw: string | undefined): string | null {
  return raw === undefined ? null : raw.trim().replace(/;$/, "").trim();
}

type FunctionState = DefinerFunction & { isDefiner: boolean };

/**
 * Every function the directory defines, in replay order, with its final state:
 * a CREATE (re)declares it wholesale — `create or replace` without a SET clause
 * drops the old one, which is Postgres's own behaviour — and each later ALTER
 * edits the marking or the pin it names. `unknownAlterTargets` collects ALTERs
 * against a function no migration here creates; the parse test fails on them
 * rather than letting the guard reason about a definition it has never seen.
 */
function foldMigrations(): { functions: FunctionState[]; creates: number; alters: number; unknownAlterTargets: string[] } {
  const byName = new Map<string, FunctionState>();
  const unknownAlterTargets: string[] = [];
  let creates = 0;
  let alters = 0;

  for (const file of migrationFiles()) {
    const sql = statementsOf(file);
    const steps: { at: number; apply: () => void }[] = [];

    for (const match of sql.matchAll(FUNCTION_HEADER)) {
      creates += 1;
      const [, rawName, header] = match;
      const at = match.index ?? 0;
      steps.push({
        at,
        apply: () => {
          const pin = clause(header.match(SEARCH_PATH_SET)?.[1]);
          byName.set(normaliseName(rawName), {
            file,
            name: normaliseName(rawName),
            declaredSearchPath: pin,
            searchPath: pin,
            pinnedBy: file,
            isDefiner: /\bsecurity\s+definer\b/i.test(header),
          });
        },
      });
    }

    for (const match of sql.matchAll(ALTER_FUNCTION)) {
      alters += 1;
      const [, rawName, , actions] = match;
      const at = match.index ?? 0;
      steps.push({
        at,
        apply: () => {
          const name = normaliseName(rawName);
          const state = byName.get(name);
          if (!state) {
            unknownAlterTargets.push(`${file}::${name}`);
            return;
          }
          if (/\breset\s+(?:all|search_path)\b/i.test(actions)) {
            state.searchPath = null;
            state.pinnedBy = file;
          }
          const pin = clause(actions.match(SEARCH_PATH_SET)?.[1]);
          if (pin !== null) {
            state.searchPath = pin;
            state.pinnedBy = file;
          }
          if (/\bsecurity\s+definer\b/i.test(actions)) state.isDefiner = true;
          if (/\bsecurity\s+invoker\b/i.test(actions)) state.isDefiner = false;
        },
      });
    }

    for (const step of steps.sort((a, b) => a.at - b.at)) step.apply();
  }

  return { functions: [...byName.values()], creates, alters, unknownAlterTargets };
}

function definerFunctions(): DefinerFunction[] {
  return foldMigrations().functions.filter((fn) => fn.isDefiner);
}

/** A pin is safe when the caller's temp schema cannot come first: it is either
 *  named explicitly (so it sits where it is named) or the path is empty and every
 *  name in the body is schema-qualified. */
function keepsTempSchemaBehind(searchPath: string | null): boolean {
  if (searchPath === null) return false;
  if (searchPath === "''" || searchPath === '""') return true;
  return searchPath
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .includes("pg_temp");
}

function key(fn: DefinerFunction): string {
  return `${fn.file}::${fn.name}`;
}

// NAMED, CITED, and load-bearing: each entry says which function, and why the pin
// is not simply added. Adding a line here is a decision somebody has to defend.
// EMPTY since ruling W3/35: its one entry (0003's verify_practice_brain_password)
// was closed by migration 0104, which pins `public, extensions, pg_temp` — folded
// in above, so the function needs no exemption to pass.
const UNPINNED_BY_EXCEPTION = new Map<string, string>();

describe("a SECURITY DEFINER migration function cannot be shadowed by a temp table", () => {
  it("parses every create-function and alter-function statement in the migration directory", () => {
    // The guard is a text scan, so an unparseable form would pass by being
    // invisible. Counting both ways makes that impossible: a function written with
    // a quoted body, or an ALTER written in a shape this regex does not know, fails
    // HERE with a sentence rather than silently leaving itself unchecked.
    const { creates, alters, unknownAlterTargets } = foldMigrations();
    const rawCreates = migrationFiles().reduce(
      (total, file) => total + [...statementsOf(file).matchAll(ANY_CREATE_FUNCTION)].length,
      0,
    );
    const rawAlters = migrationFiles().reduce(
      (total, file) => total + [...statementsOf(file).matchAll(ANY_ALTER_FUNCTION)].length,
      0,
    );
    expect(
      creates,
      "a create-function statement in supabase/migrations is written in a form this guard cannot read; teach FUNCTION_HEADER about it rather than leaving it unscanned",
    ).toBe(rawCreates);
    expect(
      alters,
      "an alter-function statement in supabase/migrations is written in a form this guard cannot read; teach ALTER_FUNCTION about it rather than leaving a pin change unscanned",
    ).toBe(rawAlters);
    expect(rawCreates, "no create-function statements found at all — the path is wrong").toBeGreaterThan(0);
    expect(
      rawAlters,
      "no alter-function statements found at all — the ALTER arm of this guard is what 0102 and 0104 are read by, and it is now unexercised",
    ).toBeGreaterThan(0);
    expect(
      unknownAlterTargets,
      `these alter-function statements name a function no migration in this directory creates, so the guard cannot know what it is altering: ${unknownAlterTargets.join(", ")}`,
    ).toEqual([]);
  });

  it("every SECURITY DEFINER function pins a search_path that keeps pg_temp behind it", () => {
    const offenders = definerFunctions()
      .filter((fn) => !keepsTempSchemaBehind(fn.searchPath))
      .filter((fn) => !UNPINNED_BY_EXCEPTION.has(key(fn)))
      .map((fn) => `${key(fn)} (search_path: ${fn.searchPath ?? "not set"}, last set by ${fn.pinnedBy})`);
    expect(
      offenders,
      `these definer-rights bodies would resolve a relation name against the caller's own temporary schema before public: ${offenders.join(", ")}. Pin \`set search_path = public, pg_temp\` (pg_temp named last is searched last), or \`set search_path = ''\` with every name schema-qualified.`,
    ).toEqual([]);
  });

  it("the exemption list holds nothing stale", () => {
    const unpinned = new Set(
      definerFunctions()
        .filter((fn) => !keepsTempSchemaBehind(fn.searchPath))
        .map(key),
    );
    const stale = [...UNPINNED_BY_EXCEPTION.keys()].filter((k) => !unpinned.has(k));
    expect(
      stale,
      `named exemptions that no longer describe an unpinned definer function: ${stale.join(", ")}. Either the function is gone or it has been fixed — delete the entry.`,
    ).toEqual([]);
  });

  it("folds a later migration's alter-function pin onto the function it names", () => {
    // The behaviour the CREATE-only scan did not have, asserted on the pair that
    // needed it: 0003 declares no pin at all and 0104 supplies one, so the fold is
    // the only reason this function reads as pinned. Break the fold and the
    // exemption-free offender test above goes red with it.
    const fn = definerFunctions().find((f) => f.name === "verify_practice_brain_password");
    expect(fn, "0003's practice-brain password function is no longer parsed as a SECURITY DEFINER function").toBeDefined();
    expect(fn?.file, "the offender key names the migration that CREATEd the function").toBe("0003_practice_brain.sql");
    expect(fn?.declaredSearchPath, "0003 itself pins nothing — that is the state 0104 exists to close").toBeNull();
    expect(fn?.searchPath, "0104's pin is not being folded onto 0003's function").toBe("public, extensions, pg_temp");
    expect(fn?.pinnedBy).toBe("0104_practice_brain_password_definer_hardening.sql");
  });
});

describe("the interest counter's pin, and the applied database that has to catch up", () => {
  const FILE_0101 = "0101_previsit_unreadable_and_interest_counts.sql";
  const FILE_0102 = "0102_interest_counts_search_path.sql";

  it("0101 pins public ahead of pg_temp, and its header says pg_temp rather than claiming the short pin is enough", () => {
    // ASSERTED OFF THE PARSED STATEMENT, NOT OFF THE FILE'S TEXT. The first draft
    // of this test was `expect(sql).toContain("set search_path = public, pg_temp")`
    // and it SURVIVED the mutation that put the short pin back — because the
    // file's own prose quotes the corrected clause, and a substring search cannot
    // tell a comment from a statement. Reading the SET clause out of the create
    // statement is the only form of this assertion that fails when the SQL
    // regresses, which is the only thing it is here to catch. It reads the
    // DECLARED pin, not the folded one, on purpose: 0102 alters the same function,
    // so the folded value would stay correct while 0101's own file rotted.
    const fn = definerFunctions().find((f) => f.file === FILE_0101);
    expect(fn, `${FILE_0101} no longer declares a SECURITY DEFINER function`).toBeDefined();
    expect(
      fn?.declaredSearchPath,
      "0101's interest counter is back on the short pin; a caller's temp table would shadow treatment_interest",
    ).toBe("public, pg_temp");

    const prose = readMigration(FILE_0101).split(/create\s+(?:or\s+replace\s+)?function/i)[0];
    expect(
      /pg_temp/.test(prose),
      "0101's prose must name pg_temp: the header is what the next definer function gets copied from, and a header claiming a pin the SQL does not deliver is the defect this file was corrected for",
    ).toBe(true);
  });

  it("0102 alters the already-applied function so the live database matches the file", () => {
    // 0101 was applied on 5 September with the short pin. Correcting 0101 alone
    // fixes fresh replays and leaves production exactly as it was, so the fix is
    // only real if the follow-up migration exists and alters that same function.
    expect(migrationFiles(), `${FILE_0102} is missing: correcting 0101 alone never reaches the applied database`).toContain(
      FILE_0102,
    );
    const sql = readMigration(FILE_0102);
    expect(sql).toMatch(
      /alter\s+function\s+public\.interest_counts_by_treatment\(text\[\]\)\s*\n?\s*set\s+search_path\s*=\s*public,\s*pg_temp/i,
    );
  });
});

describe("the practice-brain password function, hardened in 0104 (ruling W3/35)", () => {
  const FILE_0104 = "0104_practice_brain_password_definer_hardening.sql";

  it("0104 names extensions ahead of pg_temp, because pgcrypto does not live in public here", () => {
    // The one migration in this programme that changed a SECURITY DEFINER
    // function's rights over a CREDENTIAL table had no test of any kind, which is
    // how the obvious tidy-up — making this pin match 0101/0102's `public,
    // pg_temp` — would have gone green. It must not: 0003's body calls `crypt()`,
    // pgcrypto is installed into `extensions` on this project (read live before
    // 0104 was written), and dropping that schema from the path stops crypt
    // resolving and fails every practice-brain login closed.
    expect(migrationFiles(), `${FILE_0104} is missing: 0003's definer function goes back to an unpinned search_path`).toContain(
      FILE_0104,
    );
    const sql = readMigration(FILE_0104);
    expect(
      sql,
      "0104's pin must name `extensions` (where pgcrypto lives on this project) ahead of pg_temp — `public, pg_temp` would break the password gate",
    ).toMatch(
      /alter\s+function\s+public\.verify_practice_brain_password\(text,\s*text\)\s*\n?\s*set\s+search_path\s*=\s*public,\s*extensions,\s*pg_temp/i,
    );
  });

  it("0104 narrows EXECUTE to service_role, the only caller in the tree", () => {
    // 0003 never revoked EXECUTE from PUBLIC, so anon and authenticated both held
    // this function. Revoking the two by name while leaving PUBLIC's grant would
    // change nothing, which is why PUBLIC is named first.
    const sql = readMigration(FILE_0104);
    expect(sql, "0104 must revoke EXECUTE from public (the grant anon and authenticated actually hold it through)").toMatch(
      /revoke\s+all\s+on\s+function\s+public\.verify_practice_brain_password\(text,\s*text\)\s*\n?\s*from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(sql, "0104 must grant EXECUTE back to service_role explicitly rather than leave it resting on the revoked grant").toMatch(
      /grant\s+execute\s+on\s+function\s+public\.verify_practice_brain_password\(text,\s*text\)\s*\n?\s*to\s+service_role/i,
    );
  });
});
