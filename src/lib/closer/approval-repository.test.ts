import { describe, it, expect, beforeEach, vi } from "vitest";

// ===========================================================================
// THE APPROVAL SURFACE'S READS AND ITS ONE DESTRUCTIVE WRITE.
//
// `outbox-isolation.test.ts` proves the thing the module exists for: a draft is
// invisible to the shared messaging drain until it is approved. This file covers
// the other half of the human loop, which that file does not reach:
//
//   discardDraft         the conditional draft -> discarded transition, the reason
//                        it records, and the two DIFFERENT things it then does to
//                        the opportunity depending on that reason;
//   listAwaitingApproval what the queue actually contains;
//   closerQueueCounts    the three numbers on the status strip.
//
// It runs the REAL repository against an in-memory database rather than mocking
// it, for the same reason the sibling file does: what would break these rules is a
// future edit to a query, and a mocked query cannot break.
// ===========================================================================

type Row = Record<string, unknown>;

const db: Record<string, Row[]> = {};
let seq = 0;

function iso(offsetMs = 0): string {
  return new Date(1_800_000_000_000 + offsetMs).toISOString();
}

/** Migration 0085 + 0087 column defaults, so a default is exercised not assumed. */
const DEFAULTS: Record<string, () => Row> = {
  closer_touch: () => ({
    id: `t-${++seq}`,
    step: 0,
    direction: "outbound",
    status: "draft",
    approved_by: null,
    discard_reason: null,
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
  closer_outbox: () => ({ id: `o-${++seq}`, status: "queued", created_at: iso(seq) }),
  coordinator_touch: () => ({ direction: "outbound" }),
};

const PK: Record<string, string> = {
  closer_touch: "id",
  closer_state: "opportunity_id",
  closer_outbox: "id",
  coordinator_touch: "id",
};

class Query implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private eqs: Array<[string, unknown]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private mode: "select" | "insert" | "update" | "upsert" = "select";
  private payload: Row | null = null;
  private conflict: string | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private counting = false;

  constructor(private table: string) {}

  private rows(): Row[] {
    return (db[this.table] ??= []);
  }
  private matches(r: Row): boolean {
    for (const [c, v] of this.eqs) if (r[c] !== v) return false;
    for (const [c, vals] of this.ins) if (!vals.includes(r[c])) return false;
    return true;
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.counting = true;
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
    return this;
  }
  update(patch: Row) {
    this.mode = "update";
    this.payload = patch;
    return this;
  }
  upsert(row: Row, opts?: { onConflict?: string }) {
    this.mode = "upsert";
    this.payload = row;
    this.conflict = opts?.onConflict ?? PK[this.table] ?? "id";
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
    onfulfilled?: ((v: { data: unknown; error: null; count?: number }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const rows = this.run();
    const value = this.counting
      ? { data: null, error: null, count: rows.length }
      : { data: rows, error: null };
    return Promise.resolve(value as { data: unknown; error: null; count?: number }).then(
      onfulfilled,
      onrejected,
    );
  }
}

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({ from: (table: string) => new Query(table) }),
}));

import {
  closerQueueCounts,
  discardDraft,
  getState,
  getTouch,
  insertDraft,
  listAwaitingApproval,
} from "./repository";
import { discardOutcome, type CloserDiscardReason } from "./discard";

const SITE = "site-ng";
const OTHER = "site-rv";
const ELSEWHERE = "site-of-another-practice";
const OPP = "site-ng:p1:pl1";

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  db.closer_touch = [];
  db.closer_state = [];
  db.closer_outbox = [];
  seq = 0;
});

const draft = (opportunityId = OPP, siteId = SITE) =>
  insertDraft({ opportunityId, siteId, step: 1, channel: "sms", body: "Hi Sarah." });

const outcomeFor = (r: CloserDiscardReason) => discardOutcome(r, { cooldownHours: 24 });

// ---------------------------------------------------------------------------
// discardDraft
// ---------------------------------------------------------------------------

describe("a discard is conditional, reasoned, and does what the reason says", () => {
  it("records the reason on the touch", async () => {
    const t = await draft();
    const d = await discardDraft(t.id, "u-1", "wrong_tone", outcomeFor("wrong_tone"));
    expect(d?.status).toBe("discarded");
    expect(d?.discardReason).toBe("wrong_tone");
    // And it is on the stored row, not merely on the returned object.
    expect(db.closer_touch[0].discard_reason).toBe("wrong_tone");
    expect(db.closer_touch[0].approved_by).toBe("u-1");
  });

  it("a 'try again' reason leaves the opportunity ACTIVE behind a cool-off", async () => {
    const t = await draft();
    const now = new Date("2026-08-21T10:00:00.000Z");
    await discardDraft(t.id, "u-1", "too_soon", outcomeFor("too_soon"), now);
    const s = await getState(OPP);
    expect(s?.status).toBe("active");
    expect(s?.stopReason).toBeNull();
    // The cool-off is the OUTCOME's, computed from the clock it was given.
    const hours = (outcomeFor("too_soon") as { coolOffHours: number }).coolOffHours;
    expect(s?.retryNotBefore).toBe(new Date(now.getTime() + hours * 3_600_000).toISOString());
  });

  it("a 'stop' reason stops the opportunity, with the outcome's own stop reason", async () => {
    const t = await draft();
    await discardDraft(t.id, "u-1", "do_not_contact", outcomeFor("do_not_contact"));
    const s = await getState(OPP);
    expect(s?.status).toBe("stopped");
    expect(s?.stopReason).toBe("staff_stopped");
    // Not a cool-off. The two branches must not both run.
    expect(s?.retryNotBefore).toBeNull();
  });

  it.each([
    ["already_contacted", "patient_replied"],
    ["plan_not_live", "opportunity_closed"],
    ["do_not_contact", "staff_stopped"],
  ] as const)("%s writes stop reason %s", async (reason, stopReason) => {
    const t = await draft();
    await discardDraft(t.id, "u-1", reason, outcomeFor(reason));
    expect((await getState(OPP))?.stopReason).toBe(stopReason);
  });

  it("REFUSES to discard a touch that is no longer a draft", async () => {
    const t = await draft();
    db.closer_touch[0].status = "sent";
    const d = await discardDraft(t.id, "u-1", "do_not_contact", outcomeFor("do_not_contact"));
    expect(d).toBeNull();
    // ...and the opportunity is untouched — still exactly what insertDraft left —
    // so a late discard cannot retire a follow-up that has already gone out.
    const s = await getState(OPP);
    expect(s?.status).toBe("awaiting_approval");
    expect(s?.stopReason).toBeNull();
    expect(s?.retryNotBefore).toBeNull();
    expect(db.closer_touch[0].status).toBe("sent");
    expect(db.closer_touch[0].discard_reason).toBeNull();
  });

  it("a second discard changes nothing, so one draft cannot stop an opportunity twice", async () => {
    const t = await draft();
    const first = await discardDraft(t.id, "u-1", "wrong_tone", outcomeFor("wrong_tone"));
    const second = await discardDraft(t.id, "u-2", "do_not_contact", outcomeFor("do_not_contact"));
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    // The first reason stands, and the state is still the first outcome's.
    expect(db.closer_touch[0].discard_reason).toBe("wrong_tone");
    expect((await getState(OPP))?.status).toBe("active");
  });

  it("never writes to the outbox, whatever the reason", async () => {
    for (const r of ["wrong_tone", "too_soon", "already_contacted", "plan_not_live", "do_not_contact"] as const) {
      const t = await draft(`${OPP}:${r}`);
      await discardDraft(t.id, "u-1", r, outcomeFor(r));
    }
    expect(db.closer_outbox).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getTouch
// ---------------------------------------------------------------------------

describe("getTouch is where the approval route learns the site, channel and plan", () => {
  it("returns the stored row, including its reason column", async () => {
    const t = await draft();
    const got = await getTouch(t.id);
    expect(got).toMatchObject({
      id: t.id,
      opportunityId: OPP,
      siteId: SITE,
      channel: "sms",
      direction: "outbound",
      status: "draft",
      discardReason: null,
    });
  });

  it("returns null for an id nobody has", async () => {
    expect(await getTouch("t-nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listAwaitingApproval
// ---------------------------------------------------------------------------

describe("the queue holds outbound drafts, for the caller's sites, and nothing else", () => {
  it("excludes touches that have already been acted on", async () => {
    const waiting = await draft("opp-waiting");
    const approved = await draft("opp-approved");
    const sent = await draft("opp-sent");
    const discarded = await draft("opp-discarded");
    db.closer_touch.find((r) => r.id === approved.id)!.status = "approved";
    db.closer_touch.find((r) => r.id === sent.id)!.status = "sent";
    db.closer_touch.find((r) => r.id === discarded.id)!.status = "discarded";

    const queue = await listAwaitingApproval([SITE]);
    expect(queue.map((t) => t.id)).toEqual([waiting.id]);
  });

  it("excludes the patient's own inbound messages", async () => {
    const outbound = await draft("opp-out");
    db.closer_touch.push({
      ...DEFAULTS.closer_touch(),
      opportunity_id: "opp-in",
      site_id: SITE,
      direction: "inbound",
      status: "draft",
      body: "Please stop texting me",
    });
    const queue = await listAwaitingApproval([SITE]);
    expect(queue.map((t) => t.id)).toEqual([outbound.id]);
  });

  it("is scoped to the sites asked for", async () => {
    const mine = await draft("opp-mine", SITE);
    await draft("opp-theirs", ELSEWHERE);
    expect((await listAwaitingApproval([SITE])).map((t) => t.id)).toEqual([mine.id]);
    expect(await listAwaitingApproval([ELSEWHERE])).toHaveLength(1);
    expect((await listAwaitingApproval([SITE, OTHER])).map((t) => t.id)).toEqual([mine.id]);
  });

  it("is empty rather than everything when no sites are given", async () => {
    await draft();
    expect(await listAwaitingApproval([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// closerQueueCounts
// ---------------------------------------------------------------------------

describe("the status strip counts exactly what it says it counts", () => {
  beforeEach(async () => {
    await draft("opp-1"); // draft, outbound  -> awaiting
    await draft("opp-2"); // draft, outbound  -> awaiting
    const sent = await draft("opp-3");
    db.closer_touch.find((r) => r.id === sent.id)!.status = "sent";
    const discarded = await draft("opp-4");
    db.closer_touch.find((r) => r.id === discarded.id)!.status = "discarded";
    // Two replies, and an inbound row is stored with status 'sent' by the webhook.
    for (const opp of ["opp-1", "opp-3"]) {
      db.closer_touch.push({
        ...DEFAULTS.closer_touch(),
        opportunity_id: opp,
        site_id: SITE,
        direction: "inbound",
        status: "sent",
        body: "yes please",
      });
    }
    // Another practice's rows, which must not be counted.
    db.closer_touch.push({
      ...DEFAULTS.closer_touch(),
      opportunity_id: "opp-elsewhere",
      site_id: ELSEWHERE,
      direction: "outbound",
      status: "draft",
    });
  });

  it("counts awaiting, sent and replies separately and correctly", async () => {
    expect(await closerQueueCounts([SITE])).toEqual({ awaiting: 2, sent: 1, replies: 2 });
  });

  it("'awaiting' is outbound drafts only: not discards, not the patient's replies", async () => {
    const { awaiting } = await closerQueueCounts([SITE]);
    // Four outbound rows exist for this site and two inbound; only two are waiting.
    expect(db.closer_touch.filter((r) => r.site_id === SITE)).toHaveLength(6);
    expect(awaiting).toBe(2);
  });

  it("'awaiting' does not depend on inbound rows happening to carry another status", async () => {
    // The webhook writes inbound rows with status 'sent', but that is a convention
    // in one file, and migration 0085 DEFAULTS closer_touch.status to 'draft'. So an
    // inbound row that took the default is a draft, and a count that filtered on
    // status alone would show a patient's own reply as a message awaiting approval.
    db.closer_touch.push({
      ...DEFAULTS.closer_touch(), // status defaults to 'draft', as the column does
      opportunity_id: "opp-2",
      site_id: SITE,
      direction: "inbound",
      body: "sounds good, can I come Thursday?",
    });
    expect(db.closer_touch[db.closer_touch.length - 1].status).toBe("draft");
    const { awaiting, replies } = await closerQueueCounts([SITE]);
    expect(awaiting).toBe(2);
    expect(replies).toBe(3);
  });

  it("'sent' does not count the inbound rows the webhook stores as sent", async () => {
    // The inbound rows carry status 'sent' too (that is how the webhook writes
    // them), so a count that forgot the direction would read 3 here.
    expect((await closerQueueCounts([SITE])).sent).toBe(1);
  });

  it("is scoped to the sites asked for, and is all zeroes for none", async () => {
    expect(await closerQueueCounts([ELSEWHERE])).toEqual({ awaiting: 1, sent: 0, replies: 0 });
    expect(await closerQueueCounts([])).toEqual({ awaiting: 0, sent: 0, replies: 0 });
  });
});
