import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ===========================================================================
// THE SWEEP ROUTE, end to end over mocked edges.
//
// What is being proven is the ORDER and the COST of the guards, not the
// detection (detect.test.ts owns that). In particular:
//
//   - a disabled system costs NOTHING: no lease, no read, no Dentally call. The
//     switch is checked first, so registering the cron job before the client
//     wants the feature is safe rather than merely harmless.
//   - the lease is always released, including down the failure path, so a crash
//     cannot wedge the job until its TTL expires.
//   - the response tells an operator apart the two kinds of silence: `detected:0`
//     with an empty `refused` is a quiet practice; `detected:0` with a full
//     `refused` is a blind pass.
// ===========================================================================

vi.mock("server-only", () => ({}));

let enabled = true;
let leaseAcquired = true;
let released = 0;
let collectCalls = 0;
let collectThrows = false;
const collectOpenKeys: string[][] = [];
let raisedAlerts: unknown[] = [];
let storedAlerts: unknown[] = [];
let unproven: string[] = [];
let refusals: string[] = [];
const writes: Array<[string, string]> = [];

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => enabled,
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: async () => leaseAcquired,
  releaseCronLock: async () => {
    released += 1;
  },
}));

vi.mock("@/lib/anomaly/collect", () => ({
  collectReadings: async (_client: string, _now: Date, openKeys: string[] = []) => {
    collectCalls += 1;
    collectOpenKeys.push(openKeys);
    if (collectThrows) throw new Error("everything is on fire");
    return { readings: { now: new Date() }, unproven, refusals };
  },
}));

vi.mock("@/lib/anomaly/detect", () => ({
  detectAnomalies: () => raisedAlerts,
}));

vi.mock("@/lib/anomaly/repository", () => ({
  listAlerts: async () => storedAlerts,
  insertAlert: async (_c: string, a: { dedupeKey: string }) => {
    writes.push(["insert", a.dedupeKey]);
  },
  refreshAlert: async (_c: string, a: { dedupeKey: string }) => {
    writes.push(["refresh", a.dedupeKey]);
  },
  reraiseAlert: async (_c: string, a: { dedupeKey: string }) => {
    writes.push(["reraise", a.dedupeKey]);
  },
  resolveAlerts: async (_c: string, keys: string[]) => {
    for (const k of keys) writes.push(["resolve", k]);
  },
}));

import { GET, POST } from "./route";

const SECRET = "test-cron-secret";
const authed = () =>
  new Request("https://example.test/api/anomaly/sweep", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });

function alert(key: string, over: Record<string, unknown> = {}) {
  return {
    kind: "lead_sla",
    severity: "high",
    dedupeKey: key,
    sentence: "Somebody enquired and nobody rang them.",
    href: "speed-to-lead",
    at: "2026-08-21T10:00:00.000Z",
    ...over,
  };
}

function storedRow(key: string, over: Record<string, unknown> = {}) {
  return {
    id: key,
    kind: "lead_sla",
    severity: "high",
    dedupeKey: key,
    sentence: "old wording",
    href: "speed-to-lead",
    at: "2026-08-20T10:00:00.000Z",
    firstRaisedAt: "2026-08-20T10:00:00.000Z",
    lastSeenAt: "2026-08-20T10:00:00.000Z",
    resolvedAt: null,
    ...over,
  };
}

const originalSecret = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  enabled = true;
  leaseAcquired = true;
  released = 0;
  collectCalls = 0;
  collectThrows = false;
  raisedAlerts = [];
  storedAlerts = [];
  unproven = [];
  refusals = [];
  writes.length = 0;
  collectOpenKeys.length = 0;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("the guards, in order", () => {
  it("rejects a caller without the cron secret, and does no work", async () => {
    const res = await POST(
      new Request("https://example.test/api/anomaly/sweep", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(collectCalls).toBe(0);
  });

  it("A DISABLED SYSTEM COSTS NOTHING: no lease, no reads", async () => {
    enabled = false;
    const res = await POST(authed());
    expect(await res.json()).toEqual({ ok: true, skipped: "system off" });
    expect(collectCalls).toBe(0);
    // Not even a lease was taken, so nothing to release.
    expect(released).toBe(0);
  });

  it("stands down rather than racing another run", async () => {
    leaseAcquired = false;
    const res = await POST(authed());
    expect(await res.json()).toEqual({ ok: true, skipped: "another run holds the lease" });
    expect(collectCalls).toBe(0);
  });

  it("GET does the same work as POST, under the same guards", async () => {
    enabled = false;
    const res = await GET(authed());
    expect(await res.json()).toEqual({ ok: true, skipped: "system off" });
  });
});

describe("a pass", () => {
  it("inserts what is new, refreshes what is open, resolves what has cleared", async () => {
    raisedAlerts = [alert("lead_sla:new"), alert("lead_sla:open")];
    storedAlerts = [storedRow("lead_sla:open"), storedRow("lead_sla:gone")];

    const res = await POST(authed());
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      detected: 2,
      raised: 1,
      refreshed: 1,
      held: 0,
      resolved: 1,
      refused: [],
    });
    expect(writes).toEqual([
      ["insert", "lead_sla:new"],
      ["refresh", "lead_sla:open"],
      ["resolve", "lead_sla:gone"],
    ]);
    expect(released).toBe(1);
  });

  it("A QUIET PRACTICE IS A CLEAN, EMPTY RUN", async () => {
    const body = await (await POST(authed())).json();
    expect(body).toEqual({
      ok: true,
      detected: 0,
      raised: 0,
      refreshed: 0,
      held: 0,
      resolved: 0,
      refused: [],
    });
    expect(writes).toEqual([]);
  });

  it("A BLIND PASS LOOKS DIFFERENT: nothing detected, and the refusals are named", async () => {
    unproven = ["takings_trend:", "lead_sla:"];
    refusals = ["takings: the live scan does not reach back this far", "leads: unreadable"];
    storedAlerts = [storedRow("lead_sla:open"), storedRow("takings_trend:last7", { kind: "takings_trend" })];

    const body = await (await POST(authed())).json();
    expect(body.detected).toBe(0);
    expect(body.refused).toEqual(refusals);
    // And, critically, it resolved nothing: it never looked.
    expect(body.resolved).toBe(0);
    expect(writes).toEqual([]);
  });

  it("TELLS THE COLLECTOR WHAT IS ALREADY OPEN, so a bound cannot close an alert", async () => {
    // The store is read BEFORE the collection, and the open keys are handed over,
    // because a collector whose query can no longer reach a live condition has to
    // check it directly or declare it unproven — and it can do neither for a row
    // it does not know exists. Resolved rows are NOT passed: a closed condition
    // needs no proof, and re-checking one could only re-raise it. See collectLeads.
    storedAlerts = [
      storedRow("lead_sla:open"),
      storedRow("lead_sla:done", { resolvedAt: "2026-08-20T12:00:00.000Z" }),
    ];
    await POST(authed());
    expect(collectOpenKeys).toEqual([["lead_sla:open"]]);
  });

  it("releases the lease even when the pass falls over", async () => {
    collectThrows = true;
    const res = await POST(authed());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "sweep failed" });
    expect(released).toBe(1);
  });
});
