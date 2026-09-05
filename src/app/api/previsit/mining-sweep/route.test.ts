import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// THE SCHEDULER'S DOOR ONTO THE IMPLANT-INTEREST SCAN.
//
// The scan is shared with the owner's "Build candidates" button (../mining-run),
// so what this file proves is the DOOR: the cron secret, the kill switch, the
// lease and the priority — in that order, and each of them BEFORE the practice's
// Dentally quota is touched.
//
// The scan itself is faked; it has its own tests in ../_mining.test.ts.
// ===========================================================================

const store = vi.hoisted(() => ({
  authorized: true,
  systemOn: true,
  lockAvailable: true,
  keySet: true,
  priorities: [] as string[],
  locks: [] as string[],
  released: [] as string[],
  ran: 0,
}));

vi.mock("@/lib/cron", () => ({
  cronUnauthorized: () =>
    store.authorized ? null : Response.json({ error: "unauthorized" }, { status: 401 }),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => store.systemOn }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => (store.keySet ? "key" : "") }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {} }));
vi.mock("@/lib/dentally/budget", () => ({
  runWithDentallyPriority: async (p: string, fn: () => Promise<Response>) => {
    store.priorities.push(p);
    return fn();
  },
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: async (name: string) => {
    store.locks.push(name);
    return store.lockAvailable;
  },
  releaseCronLock: async (name: string) => {
    store.released.push(name);
  },
}));
vi.mock("../_mining", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_mining")>();
  return {
    MINING_LOCK: actual.MINING_LOCK,
    runMiningSweep: async () => {
      store.ran += 1;
      return { patientReads: 0, budgetRefused: false, sites: [] };
    },
  };
});

import { POST } from "./route";
import { MINING_LOCK } from "../_mining";

async function run(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(new Request("http://localhost/api/previsit/mining-sweep", { method: "POST" }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  store.authorized = true;
  store.systemOn = true;
  store.lockAvailable = true;
  store.keySet = true;
  store.priorities = [];
  store.locks = [];
  store.released = [];
  store.ran = 0;
});

describe("the scheduler's door", () => {
  it("refuses a caller without the cron secret, before anything else happens", async () => {
    store.authorized = false;
    const { status } = await run();
    expect(status).toBe(401);
    expect(store.ran).toBe(0);
    expect(store.locks).toEqual([]);
  });

  it("an off system's list does not grow overnight, and costs nothing", async () => {
    store.systemOn = false;
    const { body } = await run();
    expect(body).toEqual({ ok: true, skipped: "system off" });
    expect(store.ran).toBe(0);
    expect(store.locks, "an off system still took the lease").toEqual([]);
  });

  it("takes the shared lease, runs the scan, and releases it", async () => {
    const { body } = await run();
    expect(store.ran).toBe(1);
    expect(store.locks).toEqual([MINING_LOCK]);
    expect(store.released).toEqual([MINING_LOCK]);
    expect(body).toMatchObject({ ok: true, patientReads: 0, budgetRefused: false });
  });

  it("does not run a second scan on top of one already in progress", async () => {
    store.lockAvailable = false;
    const { body } = await run();
    expect(store.ran).toBe(0);
    expect(body).toMatchObject({ skipped: "another run in progress" });
  });

  it("spends the practice's Dentally quota as BACKGROUND work", async () => {
    // The incident this rule exists for: an unclassified cache warmer outcompeted
    // the people it was warming the cache for. A nightly scan of historical book
    // must be the first thing refused when the practice is busy.
    await run();
    expect(store.priorities).toEqual(["background"]);
  });

  it("says so rather than half-running when the practice management system is not connected", async () => {
    store.keySet = false;
    const { status } = await run();
    expect(status).toBe(503);
    expect(store.ran).toBe(0);
  });
});
