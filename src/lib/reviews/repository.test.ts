// ===========================================================================
// THE REVIEWS REPOSITORY, AGAINST A COLUMN-STRICT DATABASE.
//
// Wave 3d, 6 Sep 2026. `claimForSend` shipped writing `review_request.sent_at`,
// a column no migration has ever created (0026_reviews.sql declares ten columns
// and nothing since alters the table; the live database returns exactly those
// ten). PostgREST answers a patch naming a column outside its schema cache with
// PGRST204, the repository re-throws it, and the throw leaves the reviews sweep
// as an unhandled 500 with the row still `scheduled` — so the NEXT tick picks the
// same row and throws again, for ever. The module could never ask one patient for
// a review, and no screen would say so.
//
// Nothing caught it, for two structural reasons this file fixes:
//
//   1. `claimForSend` had NO test. The route test (area13-sweep.test.ts) mocks
//      `@/lib/reviews/repository` wholesale and reimplements the claim in memory,
//      and the W1-B trace (agent-wiring/scenarios.test.ts `seedReviews`) seeds a
//      review_request row and jumps straight to insertTouch. The transition
//      between trigger and draft was the one step nothing drove.
//   2. The shared fake's write path is `Object.assign(row, payload)` — it guards
//      TABLE existence loudly and COLUMN existence not at all, so a phantom
//      column is silently accepted. Charter §0/11: the mock must be at least as
//      strict as live.
//
// So the stand-in below takes its schema FROM THE MIGRATION FILE (the create
// table plus any later `alter table ... add column`), and refuses an insert or
// update naming anything else with the same PGRST204 live answers with. Every
// write in the repository is then driven through it. A phantom column anywhere in
// this module is now a red test, not a silent production outage.
// ===========================================================================
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

type Row = Record<string, unknown>;

interface ColumnSpec {
  /** A `default '<literal>'` on the column, if it has one. */
  literal?: string;
  /** `default now()` — stamped with the current instant on insert. */
  now?: boolean;
  /** `default gen_random_uuid()` — stamped with a generated id on insert. */
  uuid?: boolean;
}

/**
 * Split a `create table (...)` body on top-level commas. Depth matters: a
 * `check (status in ('scheduled', 'sent'))` carries commas that are NOT column
 * separators, and a naive split would invent columns called `'sent'`.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

const NON_COLUMN_LINE = /^(unique|check|primary|foreign|constraint|exclude)\b/i;

/**
 * The declared shape of a table, read from the migrations rather than restated
 * here — a copy of the column list in a test is just a second thing to forget to
 * update. Reads the `create table` and then every later `alter table ... add
 * column`, so a table that grew after its first migration is still described
 * truthfully.
 */
function declaredColumns(table: string): Map<string, ColumnSpec> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const cols = new Map<string, ColumnSpec>();

  const specOf = (line: string): ColumnSpec => {
    const spec: ColumnSpec = {};
    const literal = /default\s+'([^']*)'/i.exec(line);
    if (literal) spec.literal = literal[1];
    if (/default\s+now\(\)/i.test(line)) spec.now = true;
    if (/default\s+gen_random_uuid\(\)/i.test(line)) spec.uuid = true;
    return spec;
  };

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    const create = new RegExp(
      `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
      "i",
    ).exec(sql);
    if (create) {
      for (const raw of splitTopLevel(create[1])) {
        const line = raw.split("--")[0].trim();
        if (line === "" || NON_COLUMN_LINE.test(line)) continue;
        const name = /^([a-z_][a-z0-9_]*)/i.exec(line);
        if (name) cols.set(name[1], specOf(line));
      }
    }

    const add = new RegExp(
      `alter\\s+table\\s+(?:if\\s+exists\\s+)?${table}\\s+add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?([a-z_][a-z0-9_]*)([^;]*);`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = add.exec(sql)) !== null) cols.set(m[1], specOf(m[2]));
  }

  return cols;
}

const SCHEMA: Record<string, Map<string, ColumnSpec>> = {
  review_request: declaredColumns("review_request"),
  review_touch: declaredColumns("review_touch"),
  review_outbox: declaredColumns("review_outbox"),
};

const db: Record<string, Row[]> = {};
let idSeq = 0;

/** What PostgREST answers for a write naming a column its schema cache lacks. */
function unknownColumn(table: string, column: string) {
  return {
    code: "PGRST204",
    message: `Could not find the '${column}' column of '${table}' in the schema cache`,
    details: null,
    hint: null,
  };
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private eqs: Array<[string, unknown]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private ltes: Array<[string, string]> = [];
  private cols: string[] | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;

  constructor(private table: string) {}

  private rows(): Row[] {
    return (db[this.table] ??= []);
  }

  private matches(r: Row): boolean {
    for (const [c, v] of this.eqs) if (r[c] !== v) return false;
    for (const [c, vals] of this.ins) if (!vals.includes(r[c])) return false;
    for (const [c, v] of this.ltes) {
      const cell = r[c];
      if (typeof cell !== "string" || !(cell <= v)) return false;
    }
    return true;
  }

  select(cols?: string) {
    this.cols = cols && cols.trim() !== "*" ? cols.split(",").map((c) => c.trim()) : null;
    return this;
  }
  eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
  in(col: string, vals: unknown[]) { this.ins.push([col, vals]); return this; }
  lte(col: string, val: string) { this.ltes.push([col, val]); return this; }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) { this.max = n; return this; }
  insert(row: Row) { this.mode = "insert"; this.payload = row; return this; }
  update(patch: Row) { this.mode = "update"; this.payload = patch; return this; }

  /** THE STRICTNESS: a write may only name columns the migrations declare. */
  private rejectUnknownColumns(): { data: null; error: unknown } | null {
    const declared = SCHEMA[this.table];
    if (!declared) return { data: null, error: { code: "42P01", message: `relation "${this.table}" does not exist` } };
    for (const key of Object.keys(this.payload ?? {})) {
      if (!declared.has(key)) return { data: null, error: unknownColumn(this.table, key) };
    }
    return null;
  }

  private defaults(): Row {
    const out: Row = {};
    for (const [name, spec] of SCHEMA[this.table] ?? []) {
      if (spec.uuid) { idSeq += 1; out[name] = `row-${idSeq}`; continue; }
      if (spec.now) { out[name] = new Date().toISOString(); continue; }
      if (spec.literal !== undefined) { out[name] = spec.literal; continue; }
      out[name] = null;
    }
    return out;
  }

  private run(): { data: unknown; error: unknown } {
    if (this.mode !== "select") {
      const rejected = this.rejectUnknownColumns();
      if (rejected) return rejected;
    }

    if (this.mode === "insert") {
      const row: Row = { ...this.defaults(), ...(this.payload ?? {}) };
      this.rows().push(row);
      return { data: [this.project(row)], error: null };
    }

    if (this.mode === "update") {
      const hit = this.rows().filter((r) => this.matches(r));
      for (const r of hit) Object.assign(r, this.payload);
      return { data: hit.map((r) => this.project(r)), error: null };
    }

    let out = this.rows().filter((r) => this.matches(r));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = [...out].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (asc ? 1 : -1));
    }
    if (this.max !== null) out = out.slice(0, this.max);
    return { data: out.map((r) => this.project(r)), error: null };
  }

  private project(r: Row): Row {
    return this.cols ? Object.fromEntries(this.cols.map((c) => [c, r[c]])) : { ...r };
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    const { data, error } = this.run();
    if (error) return { data: null, error };
    const rows = data as Row[];
    if (rows.length !== 1) return { data: null, error: { code: "PGRST116", message: "expected one row" } };
    return { data: rows[0], error: null };
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const { data, error } = this.run();
    if (error) return { data: null, error };
    const rows = data as Row[];
    if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "more than one row" } };
    return { data: rows[0] ?? null, error: null };
  }

  then<R1, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ from: (table: string) => new Query(table) }),
}));

import {
  approveTouch,
  claimForSend,
  claimOutbox,
  createScheduled,
  enqueueOutbox,
  getByAppointment,
  insertTouch,
  listDue,
  markOutboxBlocked,
  markOutboxFailed,
  markStatus,
  recordOutboxSent,
  updateOutboxStatusByMessageId,
} from "./repository";

const ATTENDED = "2026-09-06T09:00:00.000Z";
const DUE = "2026-09-06T12:00:00.000Z";

async function seedRequest() {
  return createScheduled({
    siteId: "site-n15",
    dentallyAppointmentId: "appt-1",
    dentallyPatientId: "pat-1",
    patientName: "Ada L",
    channel: "sms",
    attendedAt: ATTENDED,
    sendAt: DUE,
  });
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  idSeq = 0;
});

describe("the migration is the schema this test holds the repository to", () => {
  it("reads review_request's ten declared columns, and no sent_at among them", () => {
    const cols = [...SCHEMA.review_request.keys()];
    expect(cols).toEqual([
      "id",
      "site_id",
      "dentally_appointment_id",
      "dentally_patient_id",
      "patient_name",
      "channel",
      "attended_at",
      "send_at",
      "status",
      "created_at",
    ]);
    // The send moment lives on the touch and the outbox, which DO carry it —
    // review_request never has, which is the whole point of this file.
    expect(SCHEMA.review_request.has("sent_at")).toBe(false);
    expect(SCHEMA.review_touch.has("sent_at")).toBe(true);
    expect(SCHEMA.review_outbox.has("sent_at")).toBe(true);
  });
});

describe("claimForSend", () => {
  it("patches only columns review_request actually has", async () => {
    const req = await seedRequest();
    // A phantom column in the patch is PGRST204 here exactly as it is live, and
    // this call re-throws it — which is how the sweep died on every tick.
    await expect(claimForSend(req.id)).resolves.toBe(true);
    const stored = await getByAppointment("appt-1");
    expect(stored?.status).toBe("sent");
  });

  it("transitions scheduled -> sent exactly once, so a second sweep cannot re-ask", async () => {
    const req = await seedRequest();
    await expect(claimForSend(req.id)).resolves.toBe(true);
    // The conditional .eq("status","scheduled") is what makes the claim atomic:
    // a racing or retrying run gets false and skips rather than double-enqueuing.
    await expect(claimForSend(req.id)).resolves.toBe(false);
    expect(await listDue("2026-09-06T23:00:00.000Z")).toEqual([]);
  });
});

describe("every review_* write names only columns its migration declares", () => {
  it("drives the whole request -> touch -> outbox -> drain path without a phantom column", async () => {
    const req = await seedRequest();
    expect((await listDue(DUE)).map((r) => r.id)).toEqual([req.id]);

    expect(await claimForSend(req.id)).toBe(true);

    const touch = await insertTouch({
      requestId: req.id,
      siteId: req.siteId,
      channel: "sms",
      body: "How did we do?",
      draftedBy: "human",
      status: "draft",
    });
    await approveTouch(touch.id, "auto");
    const item = await enqueueOutbox({
      touchId: touch.id,
      siteId: req.siteId,
      channel: "sms",
      toRef: "patient:pat-1",
      body: "How did we do?",
    });

    expect(await claimOutbox(item.id)).toBe(true);
    await recordOutboxSent(item.id, touch.id, {
      provider: "twilio",
      providerMessageId: "SM123",
      toAddress: "+447700900000",
    });
    await updateOutboxStatusByMessageId("SM123", "delivered");

    const outbox = db.review_outbox[0];
    expect(outbox.status).toBe("delivered");
    expect(outbox.sent_at).toBeTruthy();
    expect(db.review_touch[0].status).toBe("sent");
  });

  it("fails a touch alongside its outbox row on both failure paths", async () => {
    const req = await seedRequest();
    const failed = await insertTouch({ requestId: req.id, siteId: req.siteId, channel: "sms", body: "b", draftedBy: "human" });
    const failedItem = await enqueueOutbox({ touchId: failed.id, siteId: req.siteId, channel: "sms", toRef: "patient:pat-1", body: "b" });
    await markOutboxFailed(failedItem.id);
    expect(db.review_touch[0].status).toBe("failed");

    const blocked = await insertTouch({ requestId: req.id, siteId: req.siteId, channel: "sms", body: "b", draftedBy: "human" });
    const blockedItem = await enqueueOutbox({ touchId: blocked.id, siteId: req.siteId, channel: "sms", toRef: "patient:pat-1", body: "b" });
    await markOutboxBlocked(blockedItem.id);
    expect(db.review_touch[1].status).toBe("failed");
    expect(db.review_outbox[1].provider).toBe("suppressed");
  });

  it("marks a suppressed request without naming a column that is not there", async () => {
    const req = await seedRequest();
    await markStatus(req.id, "suppressed");
    expect((await getByAppointment("appt-1"))?.status).toBe("suppressed");
  });
});

describe("the stand-in is at least as strict as live (charter §0/11)", () => {
  it("answers PGRST204 for a write naming a column the migrations do not declare", async () => {
    const { serviceClient } = await import("@/lib/supabase/server");
    const { error } = await serviceClient()
      .from("review_request")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", "anything")
      .select("id");
    expect((error as { code?: string } | null)?.code).toBe("PGRST204");
    expect((error as { message?: string } | null)?.message).toContain("sent_at");
  });
});
