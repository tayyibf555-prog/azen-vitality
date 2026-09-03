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
//     (see MISSING_FROM_MIGRATIONS), not a silent empty-defaults row.
//
// WHAT IT IS NOT. It is not Postgres. There are no foreign keys, no CHECK
// constraints, no triggers and no RLS, so it can hold a row Postgres would
// refuse. Every scenario that depends on a CHECK (the draft-cannot-send rule
// lives in one) asserts against the migration TEXT as well, exactly as
// src/lib/postop/outbox-isolation.test.ts does. This fake proves the code path;
// the migration text proves the constraint.
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

function parseCreateTable(sql: string, name: string, body: string): TableDef {
  const columns: ColumnDef[] = [];
  const primaryKey: string[] = [];
  for (const rawPart of splitTopLevel(stripSqlComments(body))) {
    const part = rawPart.split("\n").join(" ").replace(/\s+/g, " ").trim();
    if (!part) continue;
    if (TABLE_CONSTRAINT.test(part)) {
      const pk = /^primary\s+key\s*\(([^)]*)\)/i.exec(part);
      if (pk) primaryKey.push(...pk[1].split(",").map((c) => c.trim()));
      continue;
    }
    const nameMatch = /^"?([a-z_][a-z0-9_]*)"?\s/i.exec(part);
    if (!nameMatch) continue;
    const column = nameMatch[1];
    if (/\bprimary\s+key\b/i.test(part)) primaryKey.push(column);
    // `default <expr>` runs to the next clause keyword or the end of the column.
    const def =
      /\bdefault\s+([\s\S]+?)(?=\s+(?:not\s+null|null|references|check|unique|primary\s+key|generated|collate)\b|$)/i.exec(
        part,
      );
    columns.push({ name: column, default: def ? parseDefault(def[1]) : null });
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
    const ALTER =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?([^;]*);/gi;
    let a: RegExpExecArray | null;
    while ((a = ALTER.exec(sql)) !== null) {
      const [, table, column, rest] = a;
      const def = schema.get(table);
      if (!def) continue;
      const d =
        /\bdefault\s+([\s\S]+?)(?=\s+(?:not\s+null|null|references|check|unique|generated|collate)\b|$)/i.exec(
          rest,
        );
      if (!def.columns.some((c) => c.name === column)) {
        def.columns.push({ name: column, default: d ? parseDefault(d[1]) : null });
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
// The query builder.
// ---------------------------------------------------------------------------

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
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === "select") this.mode = "select";
    this.wantCount = opts?.count === "exact" || opts?.count === "planned" || opts?.count === "estimated";
    this.headOnly = opts?.head === true;
    this.returning = true;
    return this;
  }

  // --- filters --------------------------------------------------------------
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.filters.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
  gt(col: string, val: unknown) { this.filters.push((r) => compare(r[col], val) > 0); return this; }
  gte(col: string, val: unknown) { this.filters.push((r) => compare(r[col], val) >= 0); return this; }
  lt(col: string, val: unknown) { this.filters.push((r) => compare(r[col], val) < 0); return this; }
  lte(col: string, val: unknown) { this.filters.push((r) => compare(r[col], val) <= 0); return this; }
  like(col: string, pattern: string) { return this.matchPattern(col, pattern, false); }
  ilike(col: string, pattern: string) { return this.matchPattern(col, pattern, true); }
  private matchPattern(col: string, pattern: string, insensitive: boolean) {
    const rx = new RegExp(
      `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`,
      insensitive ? "i" : "",
    );
    this.filters.push((r) => rx.test(String(r[col] ?? "")));
    return this;
  }
  is(col: string, val: unknown) {
    const mustBeNull = val === null;
    this.filters.push((r) => (r[col] === null || r[col] === undefined) === mustBeNull);
    return this;
  }
  not(col: string, op: string, val: unknown) {
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
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) { this.max = n; return this; }
  range(from: number, to: number) { this.offset = from; this.max = to - from + 1; return this; }

  // --- writes ---------------------------------------------------------------
  insert(row: Row | Row[]) {
    this.mode = "insert";
    this.payload = row;
    this.returning = false;
    return this;
  }
  update(patch: Row) {
    this.mode = "update";
    this.payload = patch;
    this.returning = false;
    return this;
  }
  upsert(row: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
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
    for (const { col, asc } of [...this.orderBy].reverse()) {
      out = [...out].sort((a, b) => (asc ? compare(a[col], b[col]) : compare(b[col], a[col])));
    }
    if (this.offset > 0) out = out.slice(this.offset);
    if (this.max !== null) out = out.slice(0, this.max);
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
  /** Tables forced to return an error, for fail-direction scenarios. */
  failures: Map<string, string>;
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

export function createFakeSupabase(): FakeSupabase {
  const db: FakeDatabase = { tables: {}, writes: [], failures: new Map() };
  const client = { from: (table: string) => new FakeQuery(table, db) };
  return {
    db,
    client,
    reset() {
      for (const k of Object.keys(db.tables)) delete db.tables[k];
      db.writes.length = 0;
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
      const bucket = (db.tables[table] ??= []);
      for (const r of rows) bucket.push({ ...defaultsFor(table), ...r });
    },
  };
}
