// THE INTEREST LIST'S HOT READ HAS AN INDEX THAT MATCHES IT, AND THAT IS CHECKED
// HERE BECAUSE NOTHING ELSE IN THIS SUITE CAN SEE IT.
//
// WHY THIS EXISTS. `treatment_interest` (migration 0097) shipped with two indexes,
// one of them `(site_id, treatment, answer, created_at desc)` — built for the
// per-treatment list. Three of the module's reads ask the TREATMENT-LESS question,
// "everybody who said yes, newest first": the pre-visit screen's own panel
// (listInterest with no treatment, inside a force-dynamic render), the
// All-treatments export walk (listInterestToCompletion, the only export this
// module has after ruling W3/29), and the counts fallback
// (countInterestByTreatmentDetailed's keyset walk). A btree cannot skip a middle
// column, so all three got nothing past the `site_id` prefix and Postgres sorted
// the whole matching set on every page. Migration 0103 adds
// `(site_id, answer, created_at desc, id)`, which those three read in index order.
//
// WHY A TEST AND NOT A CODE REVIEW. Nothing in this suite executes SQL. The fake
// Supabase client sorts JavaScript arrays and has no notion of an index at all, so
// every existing test of these three reads tests their CORRECTNESS — which was
// never in question — and not one of them can observe a query plan. A read of the
// migration directory is the only instrument this suite has for this class, so the
// guard is written as one. It is the same instrument, for the same reason, as
// migration-definer-search-path.test.ts.
//
// AND IT IS PARSED, NOT GREPPED. 0103's own prose quotes the statement it adds
// ("ONE `create index if not exists`"), and 0086's prose quotes the queries its
// indexes serve. A substring search over the file text cannot tell a comment from
// a statement, so this guard strips comments and string literals first and reads
// the column list out of the parsed statement — the only form of the assertion
// that goes red when the SQL regresses, which is the only thing it is here for.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// Through import.meta.url, never process.cwd(), so it reads THIS repo's migrations
// and not a worktree copy's (the source-hygiene precedent).
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS = join(REPO_ROOT, "supabase", "migrations");

interface IndexDef {
  file: string;
  name: string;
  table: string;
  /** Key columns in order, each normalised to `name` or `name desc`. */
  columns: string[];
}

/**
 * Everything a `--` comment, a '…' literal or a $…$ body says is prose as far as
 * this guard is concerned. Stripping them is what stops the parser reading a
 * sentence about an index as an index.
 */
function stripNonCode(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (sql[i] === "'") {
      // A doubled '' inside a literal is an escaped quote, not the end of it.
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      out += " ";
      continue;
    }
    const dollar = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += " ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

// The head of the statement only, up to the `(` that opens the key list. The list
// itself is taken by matching parens rather than by regex, because this tree has
// three EXPRESSION indexes — `lower(serial)`, `coalesce(site_id, …)`,
// `to_tsvector(…)` — and `[^)]*` would cut each of them off at its first inner
// bracket and hand back a truncated column list that looks perfectly well formed.
const CREATE_INDEX_HEAD =
  /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?([A-Za-z0-9_]+)\s+on\s+([A-Za-z0-9_."]+)\s*(?:using\s+[A-Za-z0-9_]+\s*)?\(/gi;
const ANY_CREATE_INDEX = /create\s+(?:unique\s+)?index\b/gi;

/** The text inside the parens that start at `open`, or null if they never close. */
function balanced(sql: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

/** Split on commas that are not inside a nested call. */
function topLevelCommas(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function codeOf(file: string): string {
  return stripNonCode(readFileSync(join(MIGRATIONS, file), "utf8"));
}

function indexes(): IndexDef[] {
  const found: IndexDef[] = [];
  for (const file of migrationFiles()) {
    const code = codeOf(file);
    for (const match of code.matchAll(CREATE_INDEX_HEAD)) {
      const [head, name, table] = match;
      const cols = balanced(code, (match.index ?? 0) + head.length - 1);
      // An unclosed key list is a half-read statement wearing a parsed one's
      // clothes. Left out here so the counting guard below sees it as unreadable
      // and says so, rather than this file quietly indexing a truncated list.
      if (cols === null) continue;
      found.push({
        file,
        name,
        table: table.replace(/"/g, "").replace(/^public\./i, ""),
        columns: topLevelCommas(cols)
          .map((c) => c.trim().replace(/\s+/g, " ").toLowerCase())
          .filter((c) => c.length > 0),
      });
    }
  }
  return found;
}

function onTable(table: string): IndexDef[] {
  return indexes().filter((ix) => ix.table === table);
}

describe("the treatment-less interest read has an index shaped like it", () => {
  it("parses every create-index statement in the migration directory", () => {
    // The guard is a text scan, so a statement written in a shape this regex does
    // not know would pass by being invisible. Counting both ways makes that
    // impossible: an unreadable form fails HERE with a sentence rather than
    // quietly leaving itself unchecked.
    const parsed = indexes().length;
    const statements = migrationFiles().reduce(
      (total, file) => total + [...codeOf(file).matchAll(ANY_CREATE_INDEX)].length,
      0,
    );
    expect(
      parsed,
      "a create-index statement in supabase/migrations is written in a form this guard cannot read; teach CREATE_INDEX_HEAD about it rather than leaving it unscanned",
    ).toBe(statements);
    expect(statements, "no create-index statements found at all — the path is wrong").toBeGreaterThan(0);
  });

  it("an index leads with (site_id, answer, created_at desc, id)", () => {
    // The exact shape the three treatment-less reads want, in order: the two
    // equality columns first, then the sort key, then the keyset tiebreak. Any
    // other order — treatment in the middle, created_at ascending, id missing —
    // leaves at least one of them sorting the whole matching set on every page.
    const wanted = ["site_id", "answer", "created_at desc", "id"];
    const matching = onTable("treatment_interest").filter(
      (ix) => wanted.every((col, n) => ix.columns[n] === col),
    );
    expect(
      matching.map((ix) => `${ix.file}::${ix.name}`),
      `no index on treatment_interest leads with (${wanted.join(", ")}). Without it the pre-visit screen's interest panel, the All-treatments export walk and the counts fallback each seq-scan the table and top-N sort it on every page (0103 measured 5,938 buffers against 29 at 400k rows). Found: ${onTable(
        "treatment_interest",
      )
        .map((ix) => `${ix.name} (${ix.columns.join(", ")})`)
        .join("; ")}`,
    ).not.toEqual([]);
  });

  it("the per-treatment index it does NOT replace is still there", () => {
    // 0103 is additive. The per-treatment list and its export walk are served by
    // 0097's own index and were measured as fine (94 and 239 buffers); dropping it
    // in the belief that the new one covers everything would regress them to the
    // scan this file exists to remove.
    const perTreatment = onTable("treatment_interest").filter(
      (ix) =>
        ix.columns[0] === "site_id" &&
        ix.columns[1] === "treatment" &&
        ix.columns[2] === "answer" &&
        ix.columns[3] === "created_at desc",
    );
    expect(
      perTreatment.map((ix) => ix.name),
      "0097's (site_id, treatment, answer, created_at desc) index is gone; the per-treatment list and its export walk have nothing to read in order",
    ).not.toEqual([]);
  });
});

describe("the reads that index exists for still have that shape", () => {
  const repository = readFileSync(join(REPO_ROOT, "src", "lib", "triage", "repository.ts"), "utf8");

  function bodyOf(fn: string): string {
    const start = repository.indexOf(`export async function ${fn}`);
    expect(start, `${fn} is no longer exported from src/lib/triage/repository.ts`).toBeGreaterThan(-1);
    const next = repository.indexOf("\nexport ", start + 1);
    return repository.slice(start, next === -1 ? repository.length : next);
  }

  // A STALE INDEX IS A WRITE ON EVERY INSERT THAT BUYS NOTHING, so the guard says
  // out loud what has to remain true for 0103 to be worth its 23 MB. If one of
  // these goes red because the read genuinely changed, the answer may well be to
  // re-shape or drop the index — not to loosen the assertion.

  it("the counts fallback still filters (site_id, answer) with no treatment", () => {
    const body = bodyOf("countInterestByTreatmentDetailed");
    expect(body).toContain('.eq("answer", "yes")');
    expect(
      body.includes('.eq("treatment"'),
      "the counts walk now filters by treatment, which 0097's own index already serves — 0103's index may no longer be the right shape for it",
    ).toBe(false);
  });

  it("both walks page on (created_at desc, id asc), which is why id is in the key", () => {
    for (const fn of ["countInterestByTreatmentDetailed", "listInterestToCompletion"]) {
      const body = bodyOf(fn);
      expect(body, `${fn} no longer orders by created_at desc`).toContain(
        '.order("created_at", { ascending: false })',
      );
      expect(body, `${fn} no longer carries the id tiebreak, so the index's trailing id column is dead weight`).toContain(
        '.order("id", { ascending: true })',
      );
    }
  });

  it("listInterest can still be called without a treatment — the screen's own read", () => {
    const body = bodyOf("listInterest");
    expect(body, "listInterest no longer takes an optional treatment").toMatch(/treatment\?:/);
    expect(
      body,
      "listInterest now always filters by treatment, so the treatment-less shape 0103 indexes has no caller",
    ).toContain("if (args.treatment)");
  });
});
