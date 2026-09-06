// ===========================================================================
// AN IN-MEMORY SUPABASE, WITH THE MIGRATIONS' OWN COLUMN DEFAULTS.
//
// TEST SUPPORT ONLY. Nothing in the application imports this, and nothing in it
// may ever be reachable from a page: it reads the filesystem.
//
// WHY IT EXISTS, WHICH IS NOT "TO SAVE TYPING". Every module in this platform
// already has a hand-rolled fake of `serviceClient()` inside its own test file,
// and each one declares its own table defaults by hand. That is fine for a test
// whose claim is about ONE module. It cannot work for a claim about the WIRING
// BETWEEN modules — "the recall sweep's queued row is the row the shared drain
// sends, and the message the Correspondence tab then shows" — because that trace
// crosses four modules, the drain, and the record read, and a per-file fake with
// hand-typed defaults would let each of them disagree about what a row looks like.
//
// So the defaults are not typed here. They are READ OUT OF supabase/migrations/,
// which means:
//
//   * `status` defaulting to 'queued' on an outbox insert is EXERCISED rather
//     than assumed — the same property the per-module fakes were written to
//     prove, now proven from the schema instead of from a copy of it;
//   * a migration that changes a default changes this fake on the next run, so a
//     scenario cannot keep passing against a schema that no longer exists;
//   * a table with no `create table` in the tree is a LOUD failure at seed time
//     (see MISSING_FROM_MIGRATIONS), not a silent empty-defaults row;
//   * and a COLUMN no migration declares is a loud failure too, in every
//     direction — written, read or filtered on (see assertColumnsDeclared).
//
// WHAT IT IS NOT. It is not Postgres. There are no foreign keys, no CHECK
// constraints, no triggers and no RLS, so it can hold a row Postgres would
// refuse. Every scenario that depends on a CHECK (the draft-cannot-send rule
// lives in one) asserts against the migration TEXT as well, exactly as
// src/lib/postop/outbox-isolation.test.ts does. This fake proves the code path;
// the migration text proves the constraint.
//
// BUT WHERE IT DOES MODEL POSTGRES, IT MODELS THE STRICTER SIDE. A fake that is
// more generous than live is worse than no fake at all, because it hands a green
// tick to the exact call that will fail in production. Two things are modelled on
// that principle and each cost a defect to learn: POSTGREST_MAX_ROWS, which clips
// every select at the server's row ceiling; and assertColumnsDeclared, which
// refuses a column no migration declares — PostgREST answers PGRST204 to a write
// naming one and 42703 to a read, and both fail the whole statement, while this
// fake used to invent the column on a write and hand back `undefined` on a read.
// ===========================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Row = Record<string, unknown>;

/** The repository root, resolved from THIS FILE — never process.cwd(). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/**
 * Tables the running platform reads and writes that have NO `create table` in
 * supabase/migrations/.
 *
 * These four were created out-of-band directly in Supabase before the repo kept
 * migrations, so their real constraints are invisible from the codebase (their
 * touch/outbox foreign keys are the reason every later module had to grow its own
 * pair of tables rather than reusing reactivation's). Their defaults are declared
 * here BY HAND, copied from the shape every later module's migration uses, and the
 * fact that they are hand-declared is stated rather than hidden: if reactivation's
 * live schema ever diverges from this, nothing in the repo can tell you.
 */
export const MISSING_FROM_MIGRATIONS: Record<string, () => Row> = {
  reactivation_target: () => ({ status: "pending", prior_attempts: 0, created_at: nowIso(), updated_at: nowIso() }),
  reactivation_cadence: () => ({ status: "active", current_step: 0, created_at: nowIso(), updated_at: nowIso() }),
  reactivation_touch: () => ({ direction: "outbound", status: "draft", approved_by: null, created_at: nowIso(), sent_at: null }),
  reactivation_outbox: () => ({ status: "queued", provider: null, to_address: null, provider_message_id: null, created_at: nowIso(), sent_at: null }),
};

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// The migration reader.
// ---------------------------------------------------------------------------

export interface ColumnDef {
  name: string;
  /** A thunk, so `now()` and `gen_random_uuid()` are evaluated per inserted row. */
  default: (() => unknown) | null;
}

export interface TableDef {
  name: string;
  columns: ColumnDef[];
  /** Primary-key columns, used as the default upsert conflict target. */
  primaryKey: string[];
}

let uuidCounter = 0;
function fakeUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

/** Reset the synthetic uuid sequence so a test's row ids are deterministic. */
export function resetFakeIds(): void {
  uuidCounter = 0;
}

/**
 * A Postgres default expression → a JS thunk. Only the forms this tree's
 * migrations actually use are handled; anything else returns null, which means
 * "no default", which is the honest answer rather than a guessed one.
 */
function parseDefault(expr: string): (() => unknown) | null {
  const e = expr.trim().replace(/::[a-z_ ]+(\[\])?$/i, "").trim();
  if (/^now\(\)$/i.test(e)) return () => nowIso();
  if (/^to_timestamp\(\s*0\s*\)$/i.test(e)) return () => new Date(0).toISOString();
  if (/^gen_random_uuid\(\)$/i.test(e)) return () => fakeUuid();
  if (/^true$/i.test(e)) return () => true;
  if (/^false$/i.test(e)) return () => false;
  if (/^null$/i.test(e)) return () => null;
  if (/^'[\s\S]*'$/.test(e)) {
    const literal = e.slice(1, -1).replace(/''/g, "'");
    if (literal === "{}") return () => ({});
    if (literal === "[]") return () => [];
    return () => literal;
  }
  if (/^-?\d+(\.\d+)?$/.test(e)) return () => Number(e);
  return null;
}

/**
 * Strip `-- ...` line comments, BEFORE the body is split on commas.
 *
 * Order matters and getting it wrong is silent. Several column comments in this
 * tree contain a comma — `-- the threaded agent_conversation, once created` and
 * `-- { sms?, email?, whatsapp?, marketing? }` are both real — so splitting first
 * cuts the body mid-comment, and the fragment after the cut is then read as a
 * COLUMN. That produced a `speed_to_lead_lead` whose defaults included a column
 * called `once` and no `created_at` at all: the fake would have been quietly wrong
 * about the shape of a table, which is exactly the failure it exists to prevent.
 */
function stripSqlComments(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** Split a `create table (...)` body on top-level commas (parens are nested). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inString = false;
  for (const ch of body) {
    if (ch === "'") inString = !inString;
    if (!inString) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const TABLE_CONSTRAINT = /^(primary\s+key|unique|check|constraint|foreign\s+key|exclude)\b/i;

/** `default <expr>` runs to the next clause keyword or the end of the column. */
const COLUMN_DEFAULT =
  /\bdefault\s+([\s\S]+?)(?=\s+(?:not\s+null|null|references|check|unique|primary\s+key|generated|collate)\b|$)/i;

/** Collapse a SQL fragment onto one line — the shape both parsers below want. */
function oneLine(part: string): string {
  return part.split("\n").join(" ").replace(/\s+/g, " ").trim();
}

/**
 * ONE column definition — `status text not null default 'queued'` — wherever it
 * came from: a `create table (...)` body, or an `add column` clause of an
 * `alter table`. Shared on purpose. These two used to be parsed by two different
 * expressions against two differently-shaped strings, and they disagreed; the
 * ALTER loop in migrationSchema() records exactly what that cost.
 */
function parseColumnDefinition(part: string): { column: ColumnDef; primaryKey: boolean } | null {
  const nameMatch = /^"?([a-z_][a-z0-9_]*)"?\s/i.exec(part);
  if (!nameMatch) return null;
  const def = COLUMN_DEFAULT.exec(part);
  return {
    column: { name: nameMatch[1], default: def ? parseDefault(def[1]) : null },
    primaryKey: /\bprimary\s+key\b/i.test(part),
  };
}

function parseCreateTable(sql: string, name: string, body: string): TableDef {
  const columns: ColumnDef[] = [];
  const primaryKey: string[] = [];
  for (const rawPart of splitTopLevel(stripSqlComments(body))) {
    const part = oneLine(rawPart);
    if (!part) continue;
    if (TABLE_CONSTRAINT.test(part)) {
      const pk = /^primary\s+key\s*\(([^)]*)\)/i.exec(part);
      if (pk) primaryKey.push(...pk[1].split(",").map((c) => c.trim()));
      continue;
    }
    const parsed = parseColumnDefinition(part);
    if (!parsed) continue;
    if (parsed.primaryKey) primaryKey.push(parsed.column.name);
    columns.push(parsed.column);
  }
  void sql;
  return { name, columns, primaryKey };
}

let cachedSchema: Map<string, TableDef> | null = null;

/**
 * Every table the migrations declare, with its column defaults and primary key.
 *
 * `alter table ... add column ... default ...` is applied on top of the create,
 * because several columns this platform depends on (an outbox's `to_address`,
 * a touch's `provider_message_id`) were added by a later migration and a fake
 * built only from `create table` would not have them.
 */
export function migrationSchema(): Map<string, TableDef> {
  if (cachedSchema) return cachedSchema;
  const schema = new Map<string, TableDef>();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const CREATE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = CREATE.exec(sql)) !== null) {
      const name = m[1];
      // Walk to the matching close paren so a nested `check (...)` does not end it.
      let depth = 1;
      let i = CREATE.lastIndex;
      while (i < sql.length && depth > 0) {
        const ch = sql[i];
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        i += 1;
      }
      const body = sql.slice(CREATE.lastIndex, i - 1);
      const parsed = parseCreateTable(sql, name, body);
      const existing = schema.get(name);
      if (existing) {
        // A later `create table if not exists` is a no-op in Postgres; keep the first.
        for (const col of parsed.columns) {
          if (!existing.columns.some((c) => c.name === col.name)) existing.columns.push(col);
        }
      } else {
        schema.set(name, parsed);
      }
    }
    // THE ALTER SCAN RUNS ON THE COMMENT-STRIPPED FILE, and that is not tidiness.
    //
    // `alter table` statements are found by a regex over the whole file, so a
    // `--` comment is just more text to it. Two things followed. Migrations that
    // write a note BETWEEN the table name and the first `add column` — 0078, 0079
    // and 0082 all do, explaining the column they are about to add — were skipped
    // ENTIRELY, which is why smile_assessment_campaign.flow_published (`not null
    // default false`) was absent from this fake while being present in every real
    // database. And 0075_staff_hr_profile.sql, whose header spends three
    // paragraphs on WHY pay must never be a column on rota_staff, opens that
    // explanation with the words `alter table rota_staff add column hourly_pence
    // int` — so this reader invented `rota_staff.hourly_pence` out of the comment
    // that forbids it. A fake carrying a column live does not have is the exact
    // direction the header of this file says it must never fail in: a write naming
    // it is green here and 400s in production.
    //
    // stripSqlComments FIRST, therefore, exactly as the create-table body does it
    // and for the same reason.
    //
    // ONE `alter table` STATEMENT CAN ADD MANY COLUMNS, and five in this tree do.
    //
    // This loop used to read `add column <name> <the rest of the statement>` and
    // take exactly one column from it, so every column after the first comma was
    // INVISIBLE to the fake — rota_shift's published_at, patient_note's colour and
    // updated_at, smile_assessment_campaign's flow_version and flow_published,
    // speed_to_lead_lead's nurture_next_at. Worse than invisible, actually: the
    // FIRST column's `default` expression then ran on through the comma and
    // swallowed the columns behind it, so `origin text not null default
    // 'generated', add column ...` parsed as an unrecognised expression and
    // `origin` came out with NO DEFAULT AT ALL. A table whose defaults are read
    // out of the migrations, silently missing the defaults the migrations declare,
    // is the one failure this whole file exists to prevent (see the header, and
    // stripSqlComments, which is the same bug found one comma earlier).
    //
    // So: take the WHOLE statement, split it on top-level commas the way a create
    // body is split, and parse each `add column` clause with the same
    // parseColumnDefinition the create path uses. Clauses that are not `add
    // column` (a statement may mix in `add constraint`) declare no column and are
    // skipped, which is what the single-column expression achieved by accident.
    const ALTER =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+(add\s+column\b[^;]*);/gi;
    const alterSql = stripSqlComments(sql);
    let a: RegExpExecArray | null;
    while ((a = ALTER.exec(alterSql)) !== null) {
      const [, table, statement] = a;
      const def = schema.get(table);
      if (!def) continue;
      for (const rawClause of splitTopLevel(statement)) {
        const added = /^add\s+column\s+(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(oneLine(rawClause));
        if (!added) continue;
        const parsed = parseColumnDefinition(added[1]);
        if (!parsed) continue;
        if (!def.columns.some((c) => c.name === parsed.column.name)) def.columns.push(parsed.column);
      }
    }
  }
  cachedSchema = schema;
  return schema;
}

/** The default row for a table, from the migrations (or the hand-declared four). */
export function defaultsFor(table: string): Row {
  const hand = MISSING_FROM_MIGRATIONS[table];
  if (hand) return hand();
  const def = migrationSchema().get(table);
  if (!def) {
    throw new Error(
      `fake-supabase: no "create table" for "${table}" in supabase/migrations/, and it is not ` +
        `declared in MISSING_FROM_MIGRATIONS. A scenario writing to a table the repo cannot see ` +
        `would be proving nothing, so this is loud rather than an empty row.`,
    );
  }
  const row: Row = {};
  for (const col of def.columns) if (col.default) row[col.name] = col.default();
  return row;
}

/** The primary key columns for a table, or ["id"] when it declares none. */
export function primaryKeyFor(table: string): string[] {
  const pk = migrationSchema().get(table)?.primaryKey ?? [];
  return pk.length > 0 ? pk : ["id"];
}

// ---------------------------------------------------------------------------
// Column existence.
// ---------------------------------------------------------------------------

const columnCache = new Map<string, Set<string> | null>();

/**
 * Every column the migrations declare for a table, or `null` when the repo cannot
 * see the table's shape and this fake therefore has nothing to check against.
 *
 * `null` is returned for exactly two things, and both are already accounted for
 * elsewhere: the four MISSING_FROM_MIGRATIONS tables, whose real shape is
 * invisible from the codebase and which say so in a paragraph of their own; and a
 * table with no `create table` at all, which `defaultsFor` already turns into a
 * loud failure on the first write.
 */
export function knownColumns(table: string): Set<string> | null {
  const cached = columnCache.get(table);
  if (cached !== undefined) return cached;
  const def = MISSING_FROM_MIGRATIONS[table] ? undefined : migrationSchema().get(table);
  const known = def ? new Set(def.columns.map((c) => c.name)) : null;
  columnCache.set(table, known);
  return known;
}

/** A plain column name, or null for anything this reader will not claim to parse. */
function plainColumn(name: string): string | null {
  const bare = name.trim();
  return /^[a-z_][a-z0-9_]*$/i.test(bare) ? bare : null;
}

/**
 * The columns a PostgREST projection string NAMES.
 *
 * Deliberately conservative, and the conservatism is the point: a projection may
 * embed a related resource (`patient(id,name)`), reach into json (`consent->>sms`),
 * cast, or rename (`shown:patient_name`). This reader claims only the shapes it can
 * read with certainty — a bare column, and the column half of an alias — and hands
 * back NOTHING for a string containing an embedded resource. A guard that guessed
 * at the rest would fail a correct read, which is a worse failure than the one it
 * is here to catch, because it would be paid on every green day.
 */
function projectedColumns(cols: string | undefined): string[] {
  if (cols === undefined || cols.includes("(")) return [];
  const out: string[] = [];
  for (const raw of cols.split(",")) {
    const part = raw.trim();
    if (!part || part === "*") continue;
    const named = part.includes(":") ? part.slice(part.indexOf(":") + 1) : part;
    const column = plainColumn(named);
    if (column) out.push(column);
  }
  return out;
}

/**
 * A COLUMN NO MIGRATION DECLARES IS A LOUD FAILURE, IN BOTH DIRECTIONS.
 *
 * The row ceiling above made this fake as strict as live about how MANY rows come
 * back. This makes it as strict about WHICH COLUMNS EXIST, which was the other
 * half and stayed open longer:
 *
 *   * a WRITE naming a column the schema has no cache entry for is answered
 *     PGRST204 by PostgREST and lands NOTHING — while this fake hydrated the row
 *     as `{ ...defaults, ...input }` and cheerfully invented the column on a plain
 *     JS object, so the test went green and the first production call 400ed;
 *   * a READ naming one fails the WHOLE statement with 42703 — while this fake
 *     discarded the projection string entirely and handed back `undefined`, which
 *     most callers normalise into a perfectly plausible answer. `sync_state`'s
 *     backfill cursor is the worked example: neither column was declared by any
 *     migration, three registered syncs read them first thing every tick, and the
 *     whole suite was green (see src/lib/coordinator/sync-state-backfill-columns
 *     .test.ts and migration 0106, which is what fixing one instance looks like).
 *   * a FILTER naming one is 42703 too, and here it was worse than merely allowed:
 *     `.is("typo", null)` matched EVERY row, because a column that is not there
 *     reads `undefined`. A read live would refuse outright instead silently
 *     widened, which is the fail-open direction this file exists to close.
 *
 * NO ESCAPE HATCH, ON PURPOSE. A column that exists in the database and in no
 * migration is a real defect with a known correct fix — write the migration, as
 * 0106 did — and an allowlist would let the next one be waved through instead.
 * There is nothing to wave through today either: every column of every table that
 * both the migration tree and the live database hold was compared on 6 September
 * 2026 (information_schema on project qoiyaiiajdqydyrccixt, read-only) and the two
 * agreed exactly, in both directions, once the ALTER reader above was fixed.
 */
function assertColumnsDeclared(table: string, how: string, columns: readonly string[]): void {
  const known = knownColumns(table);
  if (!known) return;
  const unknown = columns.filter((c) => !known.has(c));
  if (unknown.length === 0) return;
  throw new Error(
    `fake-supabase: ${how} on "${table}" names ${unknown.map((c) => `"${c}"`).join(", ")}, which ` +
      `no migration in supabase/migrations/ declares. Live PostgREST answers PGRST204 to a write ` +
      `naming an undeclared column and 42703 to a read or filter naming one, and BOTH fail the ` +
      `whole statement — so a fake that invented the column would hand a green tick to a call ` +
      `that 400s in production (the header's rule: never more generous than live). Either the ` +
      `name is a typo, or the column is real and out of band, in which case the fix is a ` +
      `migration that declares it (supabase/migrations/0106_sync_state_backfill_cursor_columns` +
      `.sql is the worked example), never a looser fake.`,
  );
}

// ---------------------------------------------------------------------------
// The query builder.
// ---------------------------------------------------------------------------

/**
 * POSTGREST'S SERVER-SIDE ROW CEILING. EVERY SELECT IS CLIPPED HERE, LIMIT OR NO
 * LIMIT — because that is what the real database does, and a fake that did not
 * was the reason four separate reads shipped a floor dressed up as a total.
 *
 * MEASURED, NOT ASSUMED. On this project, with the service-role key, `limit=1500`
 * and `limit=2001` both returned exactly 1,000 rows, `content-range: 0-999/*`, and
 * NO error (the calibration is written up in src/lib/dentally/sync-ledger.test.ts,
 * which is where it was first paid for). So the ceiling is not "what you get when
 * you forget to ask for a page" — it is a hard cap that a bigger `.limit()` cannot
 * lift, and asking for 20,000 rows gets you a thousand and a cheerful 200.
 *
 * WHY THAT IS A CORRECTNESS BUG AND NOT A PERFORMANCE ONE. A response clipped by
 * this ceiling is byte-for-byte indistinguishable from a short one: same status,
 * same shape, no flag. Code that reads `rows.length` off it and prints the figure
 * is printing a FLOOR as a total (charter §0/5), and code that proves "there is
 * more" by asking for cap + 1 rows can never see the extra row once cap + 1 climbs
 * past a thousand — the detection is structurally dead rather than merely wrong.
 * This tree has now found and fixed that same defect four times over:
 * task-queue/repository.ts, coordinator/repository.ts, telemetry.ts and
 * triage/repository.ts. Every one of them passed against this fake, because this
 * fake handed back every row it held.
 *
 * SO THE FAKE IS AT LEAST AS STRICT AS LIVE (charter §0/11). A scenario that reads
 * an unbounded table now sees the same truncation production would, at the point
 * where fixing it costs nothing. An unbounded select is not made an ERROR here on
 * purpose: live does not error, and a fake that threw would prove the read is
 * unbounded rather than proving what the caller then does with the clipped rows —
 * which is the half that reaches a screen.
 *
 * NOT CLIPPED, deliberately: the `count` of an `{ count: 'exact' }` read, which
 * PostgREST reports as the true total in `content-range` no matter how few rows it
 * hands back (that asymmetry is exactly why §0/5 prefers a head count); and the
 * rows an insert/update/upsert/delete hands back, which this tree only ever reads
 * back one at a time and whose live clipping behaviour has not been measured here.
 * Guessing at an uncalibrated number is the one thing this file does not do.
 *
 * A test may LOWER the ceiling (`createFakeSupabase({ maxRows: 3 })`) so a claim
 * about what a screen says when a read hits its bound does not cost a thousand
 * seeded rows. It may never raise it — see createFakeSupabase.
 */
export const POSTGREST_MAX_ROWS = 1000;

type Filter = (row: Row) => boolean;

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export interface FakeResult {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

class FakeQuery implements PromiseLike<FakeResult> {
  private filters: Filter[] = [];
  private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private conflict: string[] | null = null;
  private ignoreDuplicates = false;
  private orderBy: Array<{ col: string; asc: boolean }> = [];
  private max: number | null = null;
  private offset = 0;
  private wantCount = false;
  /** How many rows this query ASKED for (.limit / .range), or null for neither. */
  private asked: number | null = null;
  private headOnly = false;
  private returning = true;

  constructor(
    private table: string,
    private db: FakeDatabase,
  ) {}

  private rows(): Row[] {
    return (this.db.tables[this.table] ??= []);
  }

  private matches(r: Row): boolean {
    return this.filters.every((f) => f(r));
  }

  // --- projection -----------------------------------------------------------
  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    assertColumnsDeclared(this.table, "a select", projectedColumns(cols));
    if (this.mode === "select") this.mode = "select";
    this.wantCount = opts?.count === "exact" || opts?.count === "planned" || opts?.count === "estimated";
    this.headOnly = opts?.head === true;
    this.returning = true;
    return this;
  }

  // --- filters --------------------------------------------------------------
  /**
   * One filtered column, checked against the migrations before it can silently
   * match nothing (or, for `.is(col, null)`, silently match EVERYTHING). A name
   * this reader cannot parse as a plain column — a json path like
   * `consent->>sms` — is left alone rather than guessed at.
   */
  private filterOn(col: string): void {
    const column = plainColumn(col);
    if (column) assertColumnsDeclared(this.table, "a filter", [column]);
  }

  eq(col: string, val: unknown) { this.filterOn(col); this.filters.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.filterOn(col); this.filters.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.filterOn(col); this.filters.push((r) => vals.includes(r[col])); return this; }
  gt(col: string, val: unknown) { this.filterOn(col); this.filters.push((r) => compare(r[col], val) > 0); return this; }
  gte(col: string, val: unknown) { this.filterOn(col); this.filters.push((r) => compare(r[col], val) >= 0); return this; }
  lt(col: string, val: unknown) { this.filterOn(col); this.filters.push((r) => compare(r[col], val) < 0); return this; }
  lte(col: string, val: unknown) { this.filterOn(col); this.filters.push((r) => compare(r[col], val) <= 0); return this; }
  like(col: string, pattern: string) { return this.matchPattern(col, pattern, false); }
  ilike(col: string, pattern: string) { return this.matchPattern(col, pattern, true); }
  private matchPattern(col: string, pattern: string, insensitive: boolean) {
    this.filterOn(col);
    const rx = new RegExp(
      `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`,
      insensitive ? "i" : "",
    );
    this.filters.push((r) => rx.test(String(r[col] ?? "")));
    return this;
  }
  is(col: string, val: unknown) {
    this.filterOn(col);
    const mustBeNull = val === null;
    this.filters.push((r) => (r[col] === null || r[col] === undefined) === mustBeNull);
    return this;
  }
  not(col: string, op: string, val: unknown) {
    this.filterOn(col);
    if (op === "is") {
      const mustNotBeNull = val === null;
      this.filters.push((r) => (r[col] === null || r[col] === undefined) !== mustNotBeNull);
      return this;
    }
    if (op === "in") {
      const vals = Array.isArray(val) ? val : String(val).replace(/^\(|\)$/g, "").split(",");
      this.filters.push((r) => !vals.includes(r[col] as never));
      return this;
    }
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  match(criteria: Row) {
    for (const [col, val] of Object.entries(criteria)) this.eq(col, val);
    return this;
  }
  /**
   * supabase-js's compile-time escape hatch. It changes the TYPE of the result and
   * nothing about the query, so here it is the identity — but it must EXIST, or a
   * caller that uses it (src/lib/inbox/repository.ts does, on every source) throws
   * at runtime and the source is silently reported as "failed to load".
   */
  overrideTypes() {
    return this;
  }

  // --- shaping --------------------------------------------------------------
  order(col: string, opts?: { ascending?: boolean }) {
    const column = plainColumn(col);
    if (column) assertColumnsDeclared(this.table, "an order by", [column]);
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) { this.max = n; this.asked = n; return this; }
  range(from: number, to: number) {
    this.offset = from;
    this.max = to - from + 1;
    this.asked = this.max;
    return this;
  }

  // --- writes ---------------------------------------------------------------
  insert(row: Row | Row[]) {
    for (const r of Array.isArray(row) ? row : [row]) {
      assertColumnsDeclared(this.table, "an insert", Object.keys(r ?? {}));
    }
    this.mode = "insert";
    this.payload = row;
    this.returning = false;
    return this;
  }
  update(patch: Row) {
    assertColumnsDeclared(this.table, "an update", Object.keys(patch ?? {}));
    this.mode = "update";
    this.payload = patch;
    this.returning = false;
    return this;
  }
  upsert(row: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    for (const r of Array.isArray(row) ? row : [row]) {
      assertColumnsDeclared(this.table, "an upsert", Object.keys(r ?? {}));
    }
    if (opts?.onConflict) {
      assertColumnsDeclared(this.table, "an upsert conflict target", opts.onConflict.split(",").map((c) => c.trim()));
    }
    this.mode = "upsert";
    this.payload = row;
    this.conflict = opts?.onConflict ? opts.onConflict.split(",").map((c) => c.trim()) : null;
    this.ignoreDuplicates = Boolean(opts?.ignoreDuplicates);
    this.returning = false;
    return this;
  }
  delete() {
    this.mode = "delete";
    this.returning = false;
    return this;
  }

  // --- execution ------------------------------------------------------------
  private conflictKey(): string[] {
    return this.conflict ?? primaryKeyFor(this.table);
  }

  private hydrate(input: Row): Row {
    return { ...defaultsFor(this.table), ...input };
  }

  private run(): { rows: Row[]; count: number } {
    const table = this.rows();
    if (this.mode === "insert") {
      const inputs = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const made = inputs.map((i) => this.hydrate(i));
      table.push(...made);
      this.db.writes.push({ table: this.table, op: "insert" });
      return { rows: made, count: made.length };
    }
    if (this.mode === "upsert") {
      const inputs = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const out: Row[] = [];
      const key = this.conflictKey();
      for (const input of inputs) {
        const existing = table.find((r) => key.every((k) => r[k] === input[k]));
        if (existing) {
          // Postgres `on conflict do nothing` returns NO row and changes nothing.
          if (this.ignoreDuplicates) continue;
          Object.assign(existing, input);
          out.push(existing);
          continue;
        }
        const made = this.hydrate(input);
        table.push(made);
        out.push(made);
      }
      this.db.writes.push({ table: this.table, op: "upsert" });
      return { rows: out, count: out.length };
    }
    if (this.mode === "update") {
      const hit = table.filter((r) => this.matches(r));
      for (const r of hit) Object.assign(r, this.payload);
      this.db.writes.push({ table: this.table, op: "update" });
      return { rows: hit, count: hit.length };
    }
    if (this.mode === "delete") {
      const hit = table.filter((r) => this.matches(r));
      this.db.tables[this.table] = table.filter((r) => !this.matches(r));
      this.db.writes.push({ table: this.table, op: "delete" });
      return { rows: hit, count: hit.length };
    }
    let out = table.filter((r) => this.matches(r));
    const total = out.length;
    // EVERY SELECT'S REQUESTED WIDTH, RECORDED (ruling W3/32). A page size that
    // sits ON the server's ceiling is indistinguishable from a clipped page, and
    // the loops that page by offset use "a short page means the end" as their
    // completeness signal — so the WIDTH A LOOP ASKS FOR is a property worth
    // asserting, and it is only observable from in here. `asked` is null for a
    // select that set neither .limit() nor .range(), which is itself the shape
    // POSTGREST_MAX_ROWS exists to catch.
    this.db.reads.push({ table: this.table, asked: this.asked, offset: this.offset });
    for (const { col, asc } of [...this.orderBy].reverse()) {
      out = [...out].sort((a, b) => (asc ? compare(a[col], b[col]) : compare(b[col], a[col])));
    }
    if (this.offset > 0) out = out.slice(this.offset);
    // The requested window, then the server's ceiling on top of it — in that
    // order, and the ceiling wins. `.limit(2001)` returns a thousand rows in
    // production; see POSTGREST_MAX_ROWS.
    const ceiling = this.db.maxRows;
    const window = this.max === null ? ceiling : Math.min(this.max, ceiling);
    out = out.slice(0, window);
    // `count` stays the TRUE total: PostgREST's content-range reports the whole
    // matching set even when the body was clipped, so a fake that clipped the
    // count too would hide the very asymmetry a caller has to reckon with.
    return { rows: out, count: total };
  }

  private result(): FakeResult {
    const failure = this.db.failures.get(this.table);
    if (failure) return { data: null, error: { message: failure }, count: null };
    const { rows, count } = this.run();
    // A `head: true` count read returns NO rows at all, exactly as PostgREST does.
    const data = this.headOnly ? [] : rows.map((r) => ({ ...r }));
    return { data, error: null, count: this.wantCount ? count : null };
  }

  async single(): Promise<FakeResult> {
    const res = this.result();
    if (res.error) return res;
    const rows = res.data as Row[];
    if (rows.length !== 1) {
      return { data: null, error: { message: `expected 1 row, got ${rows.length}` }, count: res.count };
    }
    return { data: rows[0], error: null, count: res.count };
  }

  async maybeSingle(): Promise<FakeResult> {
    const res = this.result();
    if (res.error) return res;
    const rows = res.data as Row[];
    return { data: rows[0] ?? null, error: null, count: res.count };
  }

  then<R1, R2 = never>(
    onfulfilled?: ((v: FakeResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    void this.returning;
    return Promise.resolve(this.result()).then(onfulfilled, onrejected);
  }
}

export interface FakeDatabase {
  tables: Record<string, Row[]>;
  /** Every write that reached the database, in order — table plus operation. */
  writes: Array<{ table: string; op: string }>;
  /**
   * Every SELECT that reached the database, in order: which table, how many rows
   * it asked for (null when it asked for no bound at all) and from what offset.
   *
   * Here so a test can assert the SHAPE of a paging loop's request rather than
   * only its result — see ruling W3/32 and `this.db.reads.push` above.
   */
  reads: Array<{ table: string; asked: number | null; offset: number }>;
  /** Tables forced to return an error, for fail-direction scenarios. */
  failures: Map<string, string>;
  /**
   * The row ceiling every select is clipped at. POSTGREST_MAX_ROWS unless a test
   * lowered it, and it can only ever be LOWERED — see `createFakeSupabase`.
   */
  maxRows: number;
}

export interface FakeSupabase {
  db: FakeDatabase;
  client: { from: (table: string) => FakeQuery };
  reset: () => void;
  /** Make every query on `table` return an error, so a fail direction is testable. */
  failTable: (table: string, message?: string) => void;
  clearFailures: () => void;
  /** Rows currently held in a table (a copy). */
  rows: (table: string) => Row[];
  /** Seed rows directly, applying the migration defaults. */
  seed: (table: string, ...rows: Row[]) => void;
}

/**
 * A fake Supabase.
 *
 * `maxRows` LOWERS the select ceiling for a test and can never raise it. The
 * ceiling exists so a scenario meets the truncation production would hand it, but
 * a thousand seeded rows is a lot of setup to write for a claim about the sentence
 * a screen prints when a read runs out — so a scenario that wants to prove "this
 * count says AT LEAST when the read hit its bound" can set the bound to 3 and seed
 * four rows. It is clamped rather than trusted: passing 50,000 gets you
 * POSTGREST_MAX_ROWS, because a fake looser than the database it stands in for is
 * the failure this ceiling was added to end, and an option that could reintroduce
 * it by accident would be worse than having no option at all.
 */
export function createFakeSupabase(opts: { maxRows?: number } = {}): FakeSupabase {
  const maxRows =
    opts.maxRows === undefined
      ? POSTGREST_MAX_ROWS
      : Math.max(1, Math.min(Math.floor(opts.maxRows), POSTGREST_MAX_ROWS));
  const db: FakeDatabase = { tables: {}, writes: [], reads: [], failures: new Map(), maxRows };
  const client = { from: (table: string) => new FakeQuery(table, db) };
  return {
    db,
    client,
    reset() {
      for (const k of Object.keys(db.tables)) delete db.tables[k];
      db.writes.length = 0;
      db.reads.length = 0;
      db.failures.clear();
      resetFakeIds();
    },
    failTable(table: string, message = "db down") {
      db.failures.set(table, message);
    },
    clearFailures() {
      db.failures.clear();
    },
    rows(table: string) {
      return (db.tables[table] ?? []).map((r) => ({ ...r }));
    },
    seed(table: string, ...rows: Row[]) {
      for (const r of rows) assertColumnsDeclared(table, "a seed", Object.keys(r ?? {}));
      const bucket = (db.tables[table] ??= []);
      for (const r of rows) bucket.push({ ...defaultsFor(table), ...r });
    },
  };
}
