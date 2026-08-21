// Recall-aware booking replies: the reads.
//
// The meaning of these queries is in their PREDICATES, so the stub records every
// filter issued. A stub that only returned rows would let the correlation key, the
// sent-only filter and the newest-first ordering all be deleted one at a time with
// every test still green.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = [string, ...unknown[]];

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  let rows: Record<string, unknown> = {};
  let failures: Record<string, string> = {};
  const METHODS = ["select", "eq", "not", "is", "in", "order", "limit"];
  const makeBuilder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of METHODS) {
      b[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return b;
      };
    }
    const settle = () => {
      if (failures[table]) return Promise.resolve({ data: null, error: new Error(failures[table]) });
      return Promise.resolve({ data: rows[table] ?? null, error: null });
    };
    b.maybeSingle = settle;
    b.single = settle;
    return b;
  };
  return {
    calls,
    setRows: (r: Record<string, unknown>) => {
      rows = r;
    },
    fail: (f: Record<string, string>) => {
      failures = f;
    },
    reset: () => {
      calls.length = 0;
      rows = {};
      failures = {};
    },
    serviceClient: vi.fn(() => ({
      from: (t: string) => {
        calls.push(["from", t]);
        return makeBuilder(t);
      },
    })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { collectReplyContext } from "./reply-context-repository";

const FROM = "+447700900123";
const SENT = "2026-08-20T09:00:00.000Z";

function issued(...call: Call): boolean {
  return h.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));
}

function touched(table: string): boolean {
  return issued("from", table);
}

const RECALL_ROWS = {
  recall_outbox: { touch_id: "rt-1", sent_at: SENT },
  recall_touch: { target_id: "site-cc:pat-1:hygienist" },
  recall_target: {
    id: "site-cc:pat-1:hygienist",
    site_id: "site-cc",
    dentally_patient_id: "pat-1",
    recall_type: "hygienist",
  },
};

const REACTIVATION_ROWS = {
  reactivation_outbox: { touch_id: "at-1", sent_at: SENT },
  reactivation_touch: { target_id: "site-cc:pat-1" },
  reactivation_target: {
    id: "site-cc:pat-1",
    site_id: "site-cc",
    dentally_patient_id: "pat-1",
    reason: "stalled_plan",
    treatment: "Upper Invisalign Lite",
  },
};

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
});

describe("collectReplyContext: the correlation key", () => {
  it("matches on the resolved to_address, newest SENT first, one row", async () => {
    h.setRows(RECALL_ROWS);
    await collectReplyContext(FROM);
    expect(issued("eq", "to_address", FROM)).toBe(true);
    // A queued or drafted message is not something a patient can be replying to.
    expect(issued("not", "sent_at", "is", null)).toBe(true);
    expect(issued("order", "sent_at", { ascending: false })).toBe(true);
    expect(issued("limit", 1)).toBe(true);
  });

  it("reads every module's OWN outbox, and never post-op's", async () => {
    h.setRows(RECALL_ROWS);
    await collectReplyContext(FROM);
    for (const t of ["recall_outbox", "reactivation_outbox", "closer_outbox", "collection_outbox"]) {
      expect(touched(t), `${t} was not read`).toBe(true);
    }
    // Post-op is answered and returned before the booking agent ever runs, and an
    // aftercare check must never steer a conversation towards a booking.
    expect(touched("postop_outbox")).toBe(false);
    expect(touched("postop_touch")).toBe(false);
  });

  it("does not touch the database at all for an empty address", async () => {
    const out = await collectReplyContext("");
    expect(out).toEqual({ candidates: [], vetoes: [] });
    expect(h.calls.length).toBe(0);
  });
});

describe("collectReplyContext: what it returns", () => {
  it("builds a recall candidate from the TARGET row, not from the composite id", async () => {
    h.setRows(RECALL_ROWS);
    const out = await collectReplyContext(FROM);
    expect(out.candidates).toEqual([
      {
        module: "recall",
        reference: "site-cc:pat-1:hygienist",
        siteId: "site-cc",
        patientId: "pat-1",
        sentAt: SENT,
        recallType: "hygienist",
      },
    ]);
  });

  it("carries the reactivation reason and the plan title as a hint", async () => {
    h.setRows(REACTIVATION_ROWS);
    const out = await collectReplyContext(FROM);
    expect(out.candidates[0]).toMatchObject({
      module: "reactivation",
      reactivationReason: "stalled_plan",
      treatmentHint: "Upper Invisalign Lite",
      patientId: "pat-1",
    });
  });

  it("treats an unrecognised reactivation reason as no reason at all", async () => {
    h.setRows({
      ...REACTIVATION_ROWS,
      reactivation_target: { ...REACTIVATION_ROWS.reactivation_target, reason: "something new" },
    });
    const out = await collectReplyContext(FROM);
    expect(out.candidates[0]).toMatchObject({ reactivationReason: null });
  });

  it("puts a balance reminder in vetoes, NEVER in candidates", async () => {
    h.setRows({
      collection_outbox: { touch_id: "ct-1", sent_at: SENT },
      collection_touch: { patient_id: "pat-1", site_id: "site-cc" },
    });
    const out = await collectReplyContext(FROM);
    expect(out.candidates).toEqual([]);
    expect(out.vetoes).toEqual([
      { module: "collection", siteId: "site-cc", patientId: "pat-1", sentAt: SENT },
    ]);
  });

  it("drops a module whose touch or target row has gone", async () => {
    h.setRows({ recall_outbox: { touch_id: "rt-1", sent_at: SENT } }); // no touch row
    expect((await collectReplyContext(FROM)).candidates).toEqual([]);
    h.reset();
    h.setRows({
      recall_outbox: { touch_id: "rt-1", sent_at: SENT },
      recall_touch: { target_id: "site-cc:pat-1:dentist" },
    }); // no target row
    expect((await collectReplyContext(FROM)).candidates).toEqual([]);
  });

  it("drops an outbox row with no sent_at, however it got past the filter", async () => {
    h.setRows({ ...RECALL_ROWS, recall_outbox: { touch_id: "rt-1", sent_at: null } });
    expect((await collectReplyContext(FROM)).candidates).toEqual([]);
  });
});

describe("collectReplyContext: one broken table costs one module, never the reply", () => {
  it("keeps the modules that read cleanly when another throws", async () => {
    h.setRows({ ...RECALL_ROWS, ...REACTIVATION_ROWS });
    h.fail({ recall_target: "permission denied" });
    const out = await collectReplyContext(FROM);
    expect(out.candidates.map((c) => c.module)).toEqual(["reactivation"]);
  });

  it("a total outage returns nothing and throws nothing", async () => {
    h.setRows({ ...RECALL_ROWS, ...REACTIVATION_ROWS });
    h.fail({
      recall_outbox: "down",
      reactivation_outbox: "down",
      closer_outbox: "down",
      collection_outbox: "down",
    });
    await expect(collectReplyContext(FROM)).resolves.toEqual({ candidates: [], vetoes: [] });
  });

  it("a broken balance-reminder read does not silently drop the veto's siblings", async () => {
    // The veto failing OPEN is deliberate and worth naming: it means a candidate
    // can survive a reminder we could not read. The compensating control is that
    // the collection module's own inbound linkage still stops the cadence and
    // raises a work item, and the agent still cannot write without a read-back.
    h.setRows({ ...RECALL_ROWS });
    h.fail({ collection_touch: "down" });
    const out = await collectReplyContext(FROM);
    expect(out.vetoes).toEqual([]);
    expect(out.candidates.map((c) => c.module)).toEqual(["recall"]);
  });
});
