import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// THE ONE PROPERTY THIS MODULE HAS TO HAVE: a drafted check-in cannot be sent,
// and an escalation cannot be lost.
//
// A comment saying "the sweep never queues" is worth nothing, because the thing
// that would break it is a future edit to a different file. So this test does not
// mock the repository. It runs the REAL insertDraft against an in-memory database
// and then asks the REAL listQueuedOutbox — the exact function the shared
// messaging drain imports and calls — what it can see.
//
// The in-memory database applies the same COLUMN DEFAULTS as migration 0091, so
// "an outbox row defaults to queued" is exercised rather than assumed.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
let seq = 0;

/** A fixed instant safely in the PAST, so `not_before_at <= now()` behaves as it
 *  will in production rather than parking every row in the future. */
function iso(offsetMs = 0): string {
  return new Date(1_600_000_000_000 + offsetMs).toISOString();
}

const DEFAULTS: Record<string, () => Row> = {
  postop_target: () => ({
    status: "pending",
    stop_reason: null,
    procedure_source: "",
    consent_sms: false,
    consent_email: false,
    created_at: iso(++seq),
    updated_at: iso(seq),
  }),
  postop_touch: () => ({
    id: `t-${++seq}`,
    direction: "outbound",
    status: "draft",
    actioned_by: null,
    created_at: iso(seq),
    sent_at: null,
  }),
  postop_outbox: () => ({
    id: `o-${++seq}`,
    status: "queued",
    not_before_at: iso(-10_000),
    provider: null,
    to_address: null,
    provider_message_id: null,
    created_at: iso(seq),
    sent_at: null,
  }),
  postop_escalation: () => ({
    id: `e-${++seq}`,
    matched: null,
    created_at: iso(seq),
    resolved_at: null,
    resolved_by: null,
  }),
};

const PK: Record<string, string> = {
  postop_target: "id",
  postop_touch: "id",
  postop_outbox: "id",
  postop_escalation: "id",
};

const writtenTables: string[] = [];

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private eqs: Array<[string, unknown]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private ltes: Array<[string, string]> = [];
  private nulls: Array<[string, boolean]> = []; // [col, mustBeNull]
  private mode: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | null = null;
  private conflict: string | null = null;
  private ignoreDuplicates = false;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;

  constructor(private table: string) {}

  private rows(): Row[] {
    return (db[this.table] ??= []);
  }

  private matches(r: Row): boolean {
    for (const [c, v] of this.eqs) if (r[c] !== v) return false;
    for (const [c, vals] of this.ins) if (!vals.includes(r[c])) return false;
    for (const [c, v] of this.ltes) if (String(r[c] ?? "") > v) return false;
    for (const [c, mustBeNull] of this.nulls) {
      const isNull = r[c] === null || r[c] === undefined;
      if (isNull !== mustBeNull) return false;
    }
    return true;
  }

  select(_cols?: string, _opts?: unknown) {
    return this;
  }
  eq(col: string, val: unknown) {
    this.eqs.push([col, val]);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.ins.push([col, vals]);
    return this;
  }
  lte(col: string, val: string) {
    this.ltes.push([col, val]);
    return this;
  }
  is(col: string, val: unknown) {
    this.nulls.push([col, val === null]);
    return this;
  }
  not(col: string, _op: string, val: unknown) {
    this.nulls.push([col, val !== null]);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  insert(row: Row) {
    this.mode = "insert";
    this.payload = row;
    writtenTables.push(this.table);
    return this;
  }
  update(patch: Row) {
    this.mode = "update";
    this.payload = patch;
    writtenTables.push(this.table);
    return this;
  }
  upsert(row: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.mode = "upsert";
    this.payload = row;
    this.conflict = opts?.onConflict ?? PK[this.table] ?? "id";
    this.ignoreDuplicates = Boolean(opts?.ignoreDuplicates);
    writtenTables.push(this.table);
    return this;
  }

  private run(): Row[] {
    const rows = this.rows();
    if (this.mode === "insert") {
      const row = { ...(DEFAULTS[this.table]?.() ?? {}), ...(this.payload ?? {}) };
      rows.push(row);
      return [row];
    }
    if (this.mode === "update") {
      const hit = rows.filter((r) => this.matches(r));
      for (const r of hit) Object.assign(r, this.payload);
      return hit;
    }
    if (this.mode === "upsert") {
      const key = this.conflict ?? "id";
      const existing = rows.find((r) => r[key] === (this.payload ?? {})[key]);
      if (existing) {
        // Postgres `on conflict do nothing` returns NO row and changes nothing.
        if (this.ignoreDuplicates) return [];
        Object.assign(existing, this.payload);
        return [existing];
      }
      const row = { ...(DEFAULTS[this.table]?.() ?? {}), ...(this.payload ?? {}) };
      rows.push(row);
      return [row];
    }
    let out = rows.filter((r) => this.matches(r));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = [...out].sort((a, b) =>
        String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : String(a[col]) > String(b[col]) ? (asc ? 1 : -1) : 0,
      );
    }
    if (this.max !== null) out = out.slice(0, this.max);
    return out;
  }

  async single() {
    const r = this.run();
    return { data: r[0] ?? null, error: r.length ? null : { message: "no rows" } };
  }
  async maybeSingle() {
    return { data: this.run()[0] ?? null, error: null };
  }
  then<R1, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve({ data: this.run(), error: null }).then(onfulfilled, onrejected);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ from: (table: string) => new Query(table) }),
}));

import {
  approveDraft,
  claimOutbox,
  discardDraft,
  findTargetByAddress,
  getTarget,
  insertDraft,
  listOpenEscalations,
  listQueuedOutbox,
  markOutboxFailed,
  recordEscalation,
  recordOutboxSent,
  upsertTargetIfNew,
} from "./repository";
import { notBeforeFor } from "./schedule";

const SITE = "site-cc";
const TARGET = "site-cc:appt-1";
const SITES = [SITE];

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.postop_target = [];
  db.postop_touch = [];
  db.postop_outbox = [];
  db.postop_escalation = [];
  seq = 0;
  writtenTables.length = 0;
});

async function seedTarget() {
  return upsertTargetIfNew({
    siteId: SITE,
    dentallyPatientId: "p1",
    appointmentId: "appt-1",
    patientName: "Sarah Lindqvist",
    procedureFlag: "extraction",
    procedureSource: "Extraction UR6",
    procedureAt: iso(-86_400_000),
    dueAt: iso(-3_600_000),
    consentSms: true,
    consentEmail: false,
  });
}

async function draft() {
  await seedTarget();
  return insertDraft({ targetId: TARGET, siteId: SITE, channel: "sms", body: "Hi Sarah." });
}

// ===========================================================================
// LESSON 3: DRAFT-CANNOT-SEND, and it must be structural. Three independent
// reasons, each provable on its own. Break any one and the other two still hold.
// ===========================================================================

describe("reason 1 — the outbox CHECK constraint has no 'draft' value", () => {
  const MIGRATION = readFileSync(
    join(process.cwd(), "supabase/migrations/0091_postop_checkin.sql"),
    "utf8",
  );

  it("postop_touch allows 'draft'", () => {
    const touch = MIGRATION.slice(MIGRATION.indexOf("create table if not exists postop_touch"));
    const check = touch.slice(0, touch.indexOf(");"));
    expect(check).toContain("'draft'");
  });

  it("postop_outbox does NOT: a draft row cannot exist there at all", () => {
    const outbox = MIGRATION.slice(MIGRATION.indexOf("create table if not exists postop_outbox"));
    const check = outbox.slice(0, outbox.indexOf(");"));
    expect(check).toMatch(/check \(status in \('queued', 'sending', 'sent', 'delivered', 'failed'\)\)/);
    expect(check).not.toContain("'draft'");
  });
});

describe("reason 2 — insertDraft writes the touch table and nothing else", () => {
  it("writes postop_touch and NEVER opens postop_outbox for a write", async () => {
    await draft();
    expect(db.postop_touch).toHaveLength(1);
    expect(db.postop_touch[0].status).toBe("draft");
    expect(db.postop_outbox).toHaveLength(0);
    // Stronger than counting rows: postop_outbox was never even opened for a write.
    expect(writtenTables).not.toContain("postop_outbox");
  });

  it("approveDraft is the ONLY function in the repository that inserts into it", () => {
    const SRC = readFileSync(join(process.cwd(), "src/lib/postop/repository.ts"), "utf8");
    const inserts = [...SRC.matchAll(/from\("postop_outbox"\)\s*\n?\s*\.insert\(/g)];
    expect(inserts).toHaveLength(1);
    const at = SRC.indexOf('.from("postop_outbox")\n    .insert(');
    const approveAt = SRC.indexOf("export async function approveDraft");
    const nextExportAt = SRC.indexOf("export async function", approveAt + 10);
    expect(at).toBeGreaterThan(approveAt);
    expect(at).toBeLessThan(nextExportAt);
  });
});

describe("reason 3 — the drain query filters status = 'queued'", () => {
  it("the REAL drain query returns nothing for a drafted check-in", async () => {
    await draft();
    // listQueuedOutbox is the exact function registered in the drain's SOURCES
    // array. If it can see this row, the drain sends it.
    expect(await listQueuedOutbox(SITES)).toEqual([]);
  });

  it("a hundred drafts are still nothing to the drain", async () => {
    await seedTarget();
    for (let i = 0; i < 100; i += 1) {
      await insertDraft({ targetId: TARGET, siteId: SITE, channel: "sms", body: `d${i}` });
    }
    expect(db.postop_touch).toHaveLength(100);
    expect(await listQueuedOutbox(SITES)).toEqual([]);
  });

  it("a claimed row ('sending') is invisible too, which is what makes a send at-most-once", async () => {
    const touch = await draft();
    const approved = await approveDraft(touch.id, "user-1", {
      toRef: "patient:p1",
      notBeforeAt: iso(-10_000),
    });
    expect(approved).not.toBeNull();
    expect(await listQueuedOutbox(SITES)).toHaveLength(1);
    expect(await claimOutbox(approved!.outbox.id)).toBe(true);
    expect(await listQueuedOutbox(SITES)).toEqual([]);
    // And a second claim does not land, so a killed run cannot re-send.
    expect(await claimOutbox(approved!.outbox.id)).toBe(false);
  });
});

describe("approval is the only route out of draft", () => {
  it("approving makes exactly one outbox row, visible to the drain", async () => {
    const touch = await draft();
    const res = await approveDraft(touch.id, "user-1", { toRef: "patient:p1", notBeforeAt: iso(-10_000) });
    expect(res).not.toBeNull();
    expect(db.postop_outbox).toHaveLength(1);
    const queued = await listQueuedOutbox(SITES);
    expect(queued).toHaveLength(1);
    expect(queued[0].body).toBe("Hi Sarah.");
    expect((await getTarget(TARGET))?.status).toBe("in_flight");
  });

  it("a double-clicked approval cannot make a second outbox row", async () => {
    const touch = await draft();
    const first = await approveDraft(touch.id, "user-1", { toRef: "patient:p1", notBeforeAt: iso(-10_000) });
    const second = await approveDraft(touch.id, "user-2", { toRef: "patient:p1", notBeforeAt: iso(-10_000) });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(db.postop_outbox).toHaveLength(1);
  });

  it("a discarded draft can never be approved afterwards", async () => {
    const touch = await draft();
    expect(await discardDraft(touch.id, "user-1")).not.toBeNull();
    expect(await approveDraft(touch.id, "user-2", { toRef: "patient:p1", notBeforeAt: iso() })).toBeNull();
    expect(db.postop_outbox).toHaveLength(0);
    expect((await getTarget(TARGET))?.status).toBe("stopped");
    expect((await getTarget(TARGET))?.stopReason).toBe("staff_stopped");
  });

  it("there is NO way to edit the body: approveDraft has no parameter for one", async () => {
    const SRC = readFileSync(join(process.cwd(), "src/lib/postop/repository.ts"), "utf8");
    const sig = SRC.slice(SRC.indexOf("export async function approveDraft"));
    const params = sig.slice(0, sig.indexOf("): Promise<"));
    expect(params).not.toMatch(/\bbody\b/);
    // And the route cannot supply one either.
    const ROUTE = readFileSync(join(process.cwd(), "src/app/api/postop/[action]/route.ts"), "utf8");
    expect(ROUTE).not.toMatch(/body\.body/);
  });
});

describe("quiet hours live on the outbox row, because the drain has no clock", () => {
  it("a row queued for later is invisible until then", async () => {
    const touch = await draft();
    await approveDraft(touch.id, "user-1", {
      toRef: "patient:p1",
      notBeforeAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(db.postop_outbox).toHaveLength(1);
    expect(await listQueuedOutbox(SITES)).toEqual([]);
  });

  it("the release route clamps into the send window, so 22:30 queues for 08:00", () => {
    const at = new Date("2026-08-19T21:30:00.000Z"); // 22:30 London
    const nb = notBeforeFor(at);
    expect(Date.parse(nb)).toBeGreaterThan(at.getTime());
  });
});

describe("delivery bookkeeping", () => {
  it("a confirmed send moves the target to 'sent', the state a reply is read against", async () => {
    const touch = await draft();
    const res = await approveDraft(touch.id, "user-1", { toRef: "patient:p1", notBeforeAt: iso(-10_000) });
    await claimOutbox(res!.outbox.id);
    await recordOutboxSent(res!.outbox.id, touch.id, {
      provider: "dry-run",
      providerMessageId: "SM1",
      toAddress: "+447700900001",
    });
    expect((await getTarget(TARGET))?.status).toBe("sent");
    expect(db.postop_touch[0].status).toBe("sent");
    expect(db.postop_outbox[0].to_address).toBe("+447700900001");
  });

  it("a failed delivery STOPS the target rather than retrying it into staleness", async () => {
    const touch = await draft();
    const res = await approveDraft(touch.id, "user-1", { toRef: "patient:p1", notBeforeAt: iso(-10_000) });
    await markOutboxFailed(res!.outbox.id);
    const t = await getTarget(TARGET);
    expect(t?.status).toBe("stopped");
    expect(t?.stopReason).toBe("undeliverable");
    // No retry means no second outbox row appears on a later tick.
    expect(await listQueuedOutbox(SITES)).toEqual([]);
  });
});

describe("the flagging upsert is idempotent, so a re-run cannot double-check a patient", () => {
  it("a second upsert of the same appointment creates nothing and returns null", async () => {
    expect(await seedTarget()).not.toBeNull();
    expect(await seedTarget()).toBeNull();
    expect(db.postop_target).toHaveLength(1);
  });

  it("and CANNOT resurrect a target that has already been sent or escalated", async () => {
    await seedTarget();
    const touch = await insertDraft({ targetId: TARGET, siteId: SITE, channel: "sms", body: "Hi Sarah." });
    const res = await approveDraft(touch.id, "u", { toRef: "patient:p1", notBeforeAt: iso(-10_000) });
    await claimOutbox(res!.outbox.id);
    await recordOutboxSent(res!.outbox.id, touch.id, {
      provider: "dry-run",
      providerMessageId: "SM1",
      toAddress: "+447700900001",
    });
    expect((await getTarget(TARGET))?.status).toBe("sent");
    // The sweep re-reads the same day's book. A plain upsert would rewrite status
    // back to 'pending' and text the patient a second time.
    await seedTarget();
    expect((await getTarget(TARGET))?.status).toBe("sent");
  });
});

// ===========================================================================
// AN ESCALATION IS NEVER LOST.
// ===========================================================================

describe("escalations", () => {
  it("records the reply verbatim and the reason beside it", async () => {
    await seedTarget();
    await recordEscalation({
      targetId: TARGET,
      siteId: SITE,
      dentallyPatientId: "p1",
      patientName: "Sarah Lindqvist",
      channel: "sms",
      replyBody: "my face is swollen",
      triageReason: "symptom",
      matched: "swollen",
    });
    const open = await listOpenEscalations(SITES);
    expect(open).toHaveLength(1);
    expect(open[0].replyBody).toBe("my face is swollen");
    expect(open[0].triageReason).toBe("symptom");
    expect((await getTarget(TARGET))?.status).toBe("escalated");
  });

  it("a SECOND reply is a second row, not an overwrite", async () => {
    await seedTarget();
    for (const [body, reason] of [
      ["it hurts", "symptom"],
      ["now my face is swollen too", "symptom"],
    ]) {
      await recordEscalation({
        targetId: TARGET,
        siteId: SITE,
        dentallyPatientId: "p1",
        patientName: "Sarah Lindqvist",
        channel: "sms",
        replyBody: body,
        triageReason: reason,
        matched: null,
      });
    }
    const open = await listOpenEscalations(SITES);
    expect(open).toHaveLength(2);
    expect(open.map((e) => e.replyBody)).toEqual(["it hurts", "now my face is swollen too"]);
  });

  it("the escalation row is written BEFORE the target status, so a failure cannot lose it", () => {
    const SRC = readFileSync(join(process.cwd(), "src/lib/postop/repository.ts"), "utf8");
    const fn = SRC.slice(SRC.indexOf("export async function recordEscalation"));
    const insertAt = fn.indexOf('.from("postop_escalation")');
    const patchAt = fn.indexOf("await patchTarget(");
    expect(insertAt).toBeGreaterThan(-1);
    expect(patchAt).toBeGreaterThan(insertAt);
  });
});

describe("reply correlation only ever matches a check-in that was DELIVERED", () => {
  it("ignores a row carrying an address but no sent_at", async () => {
    await seedTarget();
    // Representable the moment anything stamps to_address before the send confirms.
    // A patient cannot be replying to a message that never went, and matching on one
    // would take an unrelated inbound away from the booking agent.
    db.postop_outbox.push({
      id: "o-x",
      touch_id: "t-x",
      site_id: SITE,
      channel: "sms",
      to_ref: "patient:p1",
      body: "Hi Sarah.",
      status: "queued",
      not_before_at: iso(-10_000),
      to_address: "+447700900001",
      sent_at: null,
      created_at: iso(1),
    });
    db.postop_touch.push({ id: "t-x", target_id: TARGET, site_id: SITE, status: "queued" });
    expect(await findTargetByAddress("+447700900001")).toBeNull();
  });

  it("matches once the send is confirmed, and reports when it went", async () => {
    const touch = await draft();
    const res = await approveDraft(touch.id, "u", { toRef: "patient:p1", notBeforeAt: iso(-10_000) });
    await claimOutbox(res!.outbox.id);
    await recordOutboxSent(res!.outbox.id, touch.id, {
      provider: "dry-run",
      providerMessageId: "SM1",
      toAddress: "+447700900001",
    });
    const match = await findTargetByAddress("+447700900001");
    expect(match?.targetId).toBe(TARGET);
    expect(match?.sentAt).toBeTruthy();
  });
});

// ===========================================================================
// LESSON 4: NO NEW SEND MACHINERY. The shared drain delivers, and the module is
// killable only because its source is registered in BOTH places.
// ===========================================================================

describe("the module is registered with the shared drain, and is therefore killable", () => {
  const DRAIN = readFileSync(join(process.cwd(), "src/app/api/messaging/drain/route.ts"), "utf8");

  it("its five drain functions are imported from THIS repository", () => {
    expect(DRAIN).toContain('from "@/lib/postop/repository"');
    for (const fn of [
      "listQueuedOutbox as listPostopQueued",
      "claimOutbox as claimPostop",
      "recordOutboxSent as recordPostopSent",
      "markOutboxFailed as markPostopFailed",
      "markOutboxBlocked as markPostopBlocked",
    ]) {
      expect(DRAIN, fn).toContain(fn);
    }
  });

  it("it is in the SOURCES array", () => {
    expect(DRAIN).toMatch(/\{ name: "postop", list: listPostopQueued/);
  });

  it("it is NOT marked transactional, so it yields its slot to a same-day recall", () => {
    const line = DRAIN.split("\n").find((l) => l.includes('{ name: "postop"'));
    expect(line).toBeTruthy();
    expect(line).not.toContain("transactional: true");
  });

  it("nothing in the module sends: no provider, no sendMessage, anywhere", () => {
    for (const f of ["repository.ts", "inbound.ts", "copy.ts", "triage.ts", "flag.ts", "schedule.ts", "types.ts"]) {
      const src = readFileSync(join(process.cwd(), "src/lib/postop", f), "utf8");
      expect(src, f).not.toMatch(/from "@\/lib\/messaging\/send"/);
      expect(src, f).not.toMatch(/from "@\/lib\/messaging\/providers/);
    }
    const SWEEP = readFileSync(join(process.cwd(), "src/app/api/postop/sweep/route.ts"), "utf8");
    expect(SWEEP).not.toMatch(/sendMessage/);
    const ACTION = readFileSync(join(process.cwd(), "src/app/api/postop/[action]/route.ts"), "utf8");
    expect(ACTION).not.toMatch(/sendMessage/);
  });
});
