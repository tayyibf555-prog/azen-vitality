import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE ONE PROPERTY THIS MODULE HAS TO HAVE: a drafted message cannot be sent.
//
// A comment saying "the sweep never queues" is worth nothing, because the thing
// that would break it is a future edit to a different file. So this test does not
// mock the repository. It runs the REAL insertDraft against an in-memory database
// and then asks the REAL listQueuedOutbox — the exact function the shared
// messaging drain imports and calls — what it can see. A draft has to be
// invisible to that query, and it has to become visible the moment, and only the
// moment, a human approves it.
//
// The in-memory database applies the same COLUMN DEFAULTS as migration 0085, so
// "an outbox row defaults to queued" is exercised rather than assumed.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
let seq = 0;

function iso(offsetMs = 0): string {
  return new Date(1_800_000_000_000 + offsetMs).toISOString();
}

const DEFAULTS: Record<string, () => Row> = {
  closer_touch: () => ({
    id: `t-${++seq}`,
    step: 0,
    direction: "outbound",
    status: "draft",
    approved_by: null,
    created_at: iso(seq),
    sent_at: null,
  }),
  closer_outbox: () => ({
    id: `o-${++seq}`,
    status: "queued",
    provider: null,
    to_address: null,
    provider_message_id: null,
    created_at: iso(seq),
    sent_at: null,
  }),
  closer_state: () => ({
    status: "active",
    step: 0,
    stop_reason: null,
    first_qualified_at: iso(),
    last_touch_at: null,
    last_drafted_at: null,
    retry_not_before: null,
    consecutive_failures: 0,
    updated_at: iso(),
  }),
  coordinator_touch: () => ({ direction: "outbound" }),
};

const PK: Record<string, string> = {
  closer_touch: "id",
  closer_outbox: "id",
  closer_state: "opportunity_id",
  coordinator_touch: "id",
};

/** Every table a call touched this test, so a write to the wrong one is visible. */
const touchedTables: string[] = [];
const writtenTables: string[] = [];

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private eqs: Array<[string, unknown]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private mode: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | null = null;
  private conflict: string | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;

  constructor(private table: string) {
    touchedTables.push(table);
  }

  private rows(): Row[] {
    return (db[this.table] ??= []);
  }

  private matches(r: Row): boolean {
    for (const [c, v] of this.eqs) if (r[c] !== v) return false;
    for (const [c, vals] of this.ins) if (!vals.includes(r[c])) return false;
    return true;
  }

  select(_cols?: string) {
    if (this.mode === "select") this.mode = "select";
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
  upsert(row: Row, opts?: { onConflict?: string }) {
    this.mode = "upsert";
    this.payload = row;
    this.conflict = opts?.onConflict ?? PK[this.table] ?? "id";
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
  getState,
  insertDraft,
  listQueuedOutbox,
  markOutboxFailed,
  recordOutboxSent,
  stopOpportunity,
} from "./repository";

const SITE = "site-cc";
const OPP = "site-cc:p1:pl1";
const SITES = [SITE];

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.closer_touch = [];
  db.closer_outbox = [];
  db.closer_state = [];
  db.coordinator_touch = [];
  seq = 0;
  touchedTables.length = 0;
  writtenTables.length = 0;
});

async function draft() {
  return insertDraft({ opportunityId: OPP, siteId: SITE, step: 1, channel: "sms", body: "Hi Sarah." });
}

describe("a closer draft is invisible to the shared messaging drain", () => {
  it("writes closer_touch and NOTHING to closer_outbox", async () => {
    await draft();
    expect(db.closer_touch).toHaveLength(1);
    expect(db.closer_touch[0].status).toBe("draft");
    expect(db.closer_outbox).toHaveLength(0);
    // Stronger than counting rows: closer_outbox was never even opened for a write.
    expect(writtenTables).not.toContain("closer_outbox");
  });

  it("the REAL drain query returns nothing for a drafted message", async () => {
    await draft();
    // listQueuedOutbox is the exact function registered in the drain's SOURCES
    // array. If it can see this row, the drain sends it.
    expect(await listQueuedOutbox(SITES)).toEqual([]);
  });

  it("a hundred drafts are still nothing to the drain", async () => {
    for (let i = 0; i < 100; i += 1) {
      await insertDraft({ opportunityId: `${OPP}:${i}`, siteId: SITE, step: 1, channel: "sms", body: `d${i}` });
    }
    expect(db.closer_touch).toHaveLength(100);
    expect(await listQueuedOutbox(SITES)).toEqual([]);
  });

  it("only approval makes a message visible to the drain", async () => {
    const t = await draft();
    expect(await listQueuedOutbox(SITES)).toEqual([]);

    const approved = await approveDraft(t.id, "blerta@practice.test", { toRef: "patient:p1" });
    expect(approved).not.toBeNull();

    const queued = await listQueuedOutbox(SITES);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ touchId: t.id, siteId: SITE, channel: "sms", toRef: "patient:p1" });
    // The outbox row took migration 0085's column default rather than an explicit
    // status from the code, which is what makes 'queued' the schema's answer.
    expect(db.closer_outbox[0].status).toBe("queued");
  });

  it("a discarded draft never becomes visible, and is not left in limbo", async () => {
    const t = await draft();
    const discarded = await discardDraft(t.id, "blerta@practice.test", "wrong_tone", {
      kind: "retry",
      coolOffHours: 24,
    });
    expect(discarded?.status).toBe("discarded");
    expect(await listQueuedOutbox(SITES)).toEqual([]);
    expect(db.closer_outbox).toHaveLength(0);
    // The opportunity is ACTIVE again behind a cooldown. A discarded draft that
    // left the state stuck on awaiting_approval would retire the opportunity from
    // the cadence silently and forever.
    const s = await getState(OPP);
    expect(s?.status).toBe("active");
    expect(s?.retryNotBefore).not.toBeNull();
  });

  it("a draft cannot be approved twice, so one message cannot be queued twice", async () => {
    const t = await draft();
    const first = await approveDraft(t.id, "blerta@practice.test", { toRef: "patient:p1" });
    const second = await approveDraft(t.id, "blerta@practice.test", { toRef: "patient:p1" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(db.closer_outbox).toHaveLength(1);
    expect(await listQueuedOutbox(SITES)).toHaveLength(1);
  });

  it("an edited body is written in the SAME transition as the approval", async () => {
    // The coordinator's editor has a live defect: it posts the approval without the
    // edited body, so the AI's original text is what actually goes out. Here the
    // edit is part of the conditional draft -> approved update, so an edit that
    // lands and an approval that lands are the same write.
    const t = await draft();
    const r = await approveDraft(t.id, "blerta@practice.test", {
      toRef: "patient:p1",
      body: "Hi Sarah, softened by a human.",
    });
    expect(r?.touch.body).toBe("Hi Sarah, softened by a human.");
    expect(r?.touch.draftedBy).toBe("human");
    // And the OUTBOX carries the edited text, not the model's.
    expect((await listQueuedOutbox(SITES))[0].body).toBe("Hi Sarah, softened by a human.");
  });

  it("a body may not be smuggled onto a touch that is no longer a draft", async () => {
    const t = await draft();
    await approveDraft(t.id, "blerta@practice.test", { toRef: "patient:p1" });
    const late = await approveDraft(t.id, "someone@else.test", {
      toRef: "patient:p1",
      body: "Hi Sarah, rewritten after release.",
    });
    expect(late).toBeNull();
    expect(db.closer_touch[0].body).toBe("Hi Sarah.");
    expect(db.closer_outbox).toHaveLength(1);
  });

  it("a claimed row leaves the queue, so the drain cannot send it twice", async () => {
    const t = await draft();
    const r = await approveDraft(t.id, "x", { toRef: "patient:p1" });
    expect(await claimOutbox(r!.outbox.id)).toBe(true);
    expect(await claimOutbox(r!.outbox.id)).toBe(false);
    expect(await listQueuedOutbox(SITES)).toEqual([]);
  });

  it("does not leak another site's queued rows", async () => {
    const t = await draft();
    await approveDraft(t.id, "x", { toRef: "patient:p1" });
    expect(await listQueuedOutbox(["site-rv"])).toEqual([]);
  });
});

describe("the cadence advances only on a confirmed send", () => {
  it("drafting does not advance the step; sending does", async () => {
    const t = await draft();
    expect((await getState(OPP))?.step).toBe(0);
    expect((await getState(OPP))?.status).toBe("awaiting_approval");

    const r = await approveDraft(t.id, "x", { toRef: "patient:p1" });
    expect((await getState(OPP))?.step).toBe(0);
    expect((await getState(OPP))?.status).toBe("in_flight");

    await recordOutboxSent(r!.outbox.id, t.id, {
      provider: "dry-run",
      providerMessageId: "SM1",
      toAddress: "+447700900000",
    });
    const s = await getState(OPP);
    expect(s?.step).toBe(1);
    expect(s?.status).toBe("active");
    expect(s?.lastTouchAt).not.toBeNull();
  });

  it("the last step exhausts the opportunity for good", async () => {
    const t = await insertDraft({ opportunityId: OPP, siteId: SITE, step: 3, channel: "sms", body: "final" });
    const r = await approveDraft(t.id, "x", { toRef: "patient:p1" });
    await recordOutboxSent(r!.outbox.id, t.id, { provider: "dry-run", providerMessageId: "SM3", toAddress: "+44" });
    const s = await getState(OPP);
    expect(s?.status).toBe("exhausted");
    expect(s?.stopReason).toBe("exhausted");
  });

  it("a failed send counts, cools off, and does NOT advance the step", async () => {
    const t = await draft();
    const r = await approveDraft(t.id, "x", { toRef: "patient:p1" });
    await markOutboxFailed(r!.outbox.id);
    const s = await getState(OPP);
    expect(s?.step).toBe(0); // nothing was delivered, so nothing advanced
    expect(s?.consecutiveFailures).toBe(1);
    expect(s?.status).toBe("active");
    expect(s?.retryNotBefore).not.toBeNull();
    expect(db.closer_touch[0].status).toBe("failed");
  });

  it("a confirmed send clears the failure count", async () => {
    const t1 = await draft();
    const r1 = await approveDraft(t1.id, "x", { toRef: "patient:p1" });
    await markOutboxFailed(r1!.outbox.id);
    expect((await getState(OPP))?.consecutiveFailures).toBe(1);

    const t2 = await draft();
    const r2 = await approveDraft(t2.id, "x", { toRef: "patient:p1" });
    await recordOutboxSent(r2!.outbox.id, t2.id, { provider: "dry-run", providerMessageId: "SM2", toAddress: "+44" });
    expect((await getState(OPP))?.consecutiveFailures).toBe(0);
  });

  it("a stop is recorded with its reason", async () => {
    await stopOpportunity(OPP, SITE, "dispute");
    const s = await getState(OPP);
    expect(s?.status).toBe("stopped");
    expect(s?.stopReason).toBe("dispute");
  });
});
