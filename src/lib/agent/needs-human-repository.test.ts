import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The two reads/writes the Task Queue's escalation tasks stand on.
 *
 * Their whole meaning is in the PREDICATE, not in the mapping, so the stub records
 * every filter each query issues. A stub that just returned rows would let the
 * predicates be deleted one by one with every test still green: no site scope, no
 * status filter, no bound, no idempotence.
 */

type Call = [string, ...unknown[]];

const h = vi.hoisted(() => {
  let result: { data: unknown; error: unknown } = { data: [], error: null };
  const calls: Call[] = [];
  const makeBuilder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["insert", "update", "select", "eq", "neq", "is", "in", "lt", "gte", "order", "limit"]) {
      b[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return b;
      };
    }
    b.single = () => Promise.resolve(result);
    b.maybeSingle = () => Promise.resolve(result);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return b;
  };
  return {
    calls,
    set: (r: { data: unknown; error: unknown }) => {
      result = r;
    },
    reset: () => {
      calls.length = 0;
      result = { data: [], error: null };
    },
    serviceClient: vi.fn(() => ({
      from: (t: string) => {
        calls.push(["from", t]);
        return makeBuilder();
      },
    })),
  };
});

vi.mock("@/lib/supabase/server", () => ({ serviceClient: h.serviceClient }));

import { ensureNeedsHuman, listNeedsHumanConversations } from "./repository";

/** Did the query issue this exact filter? */
function issued(...call: Call): boolean {
  return h.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));
}

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
});

describe("ensureNeedsHuman", () => {
  it("flips the conversation to needs_human", async () => {
    h.set({ data: [{ id: "conv-1" }], error: null });
    expect(await ensureNeedsHuman("conv-1")).toBe("set");
    expect(issued("from", "agent_conversation")).toBe(true);
    expect(issued("eq", "id", "conv-1")).toBe(true);
    const update = h.calls.find((c) => c[0] === "update")![1] as { status: string };
    expect(update.status).toBe("needs_human");
  });

  it("is a NO-OP on a conversation already handed over, so it cannot churn the list", async () => {
    // The predicate, not a read-then-write: two concurrent handovers on one thread
    // must not both believe they were first, and a colleague reading Conversations
    // must not have the row jump under them on every repeat alert.
    expect(issued("neq", "status", "needs_human")).toBe(false); // nothing issued yet
    h.set({ data: [], error: null });
    expect(await ensureNeedsHuman("conv-1")).toBe("already");
    expect(issued("neq", "status", "needs_human")).toBe(true);
  });

  it("never drags a CLOSED conversation back open", async () => {
    // A thread a human has already finished with must not be reopened by a late
    // alert for a turn that happened before it closed.
    await ensureNeedsHuman("conv-1");
    expect(issued("neq", "status", "closed")).toBe(true);
  });

  it("reports 'set' only when a row actually changed", async () => {
    h.set({ data: [], error: null });
    expect(await ensureNeedsHuman("conv-1")).toBe("already");
    h.reset();
    h.set({ data: [{ id: "conv-1" }], error: null });
    expect(await ensureNeedsHuman("conv-1")).toBe("set");
  });

  it("throws a real DB error rather than reporting a write that did not happen", async () => {
    h.set({ data: null, error: { message: "permission denied" } });
    await expect(ensureNeedsHuman("conv-1")).rejects.toBeTruthy();
  });
});

describe("listNeedsHumanConversations", () => {
  it("is scoped to the given sites and to the handed-over status", async () => {
    await listNeedsHumanConversations(["site-cc", "site-rv"]);
    expect(issued("in", "site_id", ["site-cc", "site-rv"])).toBe(true);
    expect(issued("eq", "status", "needs_human")).toBe(true);
  });

  it("is BOUNDED, so one queue read can never become an unbounded scan", async () => {
    await listNeedsHumanConversations(["site-cc"]);
    const limit = h.calls.find((c) => c[0] === "limit");
    expect(limit).toBeDefined();
    expect(typeof limit![1]).toBe("number");
  });

  it("honours an explicit bound", async () => {
    await listNeedsHumanConversations(["site-cc"], 5);
    expect(issued("limit", 5)).toBe(true);
  });

  it("does not query AT ALL for an empty site list", async () => {
    // `.in("site_id", [])` is a shape that must never be issued: it is one typo
    // away from an unscoped read across every tenant.
    expect(await listNeedsHumanConversations([])).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it("maps the row to the shape the queue needs", async () => {
    h.set({
      data: [
        {
          id: "conv-1",
          site_id: "site-cc",
          dentally_patient_id: "998877",
          patient_name: "Amira Khan",
          channel: "whatsapp",
          updated_at: "2026-08-18T08:55:00.000Z",
        },
      ],
      error: null,
    });
    expect(await listNeedsHumanConversations(["site-cc"])).toEqual([
      {
        id: "conv-1",
        siteId: "site-cc",
        dentallyPatientId: "998877",
        patientName: "Amira Khan",
        channel: "whatsapp",
        updatedAt: "2026-08-18T08:55:00.000Z",
      },
    ]);
  });

  it("throws on a read error rather than reporting an empty escalation list", async () => {
    // "No escalations" and "we could not read the escalations" are different facts,
    // and the queue's own per-source catch is what tells them apart.
    h.set({ data: null, error: { message: "timeout" } });
    await expect(listNeedsHumanConversations(["site-cc"])).rejects.toBeTruthy();
  });
});
