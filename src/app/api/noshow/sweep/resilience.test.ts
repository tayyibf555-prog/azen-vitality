// RESILIENCE: the no-show sweep must fail CLOSED under an injected list/sync
// failure - it must release the cron lock (never leave it held / deadlocking
// every future tick) and surface an error, rather than hang or silently hold
// the lease.
//
// The sweep acquires "sweep-noshow" for 310s, then lists due cadences and
// expired offers. If listDueCadences throws (DB / Dentally sync down) the run
// must still release the lock in its finally. A held lock is the dangerous
// failure: the lease outlives maxDuration by design, so a leaked lock would
// silence the module for ~5 minutes every tick until it self-heals.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
  releaseCronLock: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));

vi.mock("@/lib/cron", () => ({
  cronUnauthorized: vi.fn((..._a: unknown[]): Response | null => null),
}));

vi.mock("@/lib/noshow/repository", () => ({
  listDueCadences: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  getTarget: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  incrementPriorAttempts: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  updateCadence: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  insertTouch: vi.fn(async (..._a: unknown[]): Promise<{ id: string }> => ({ id: "touch-1" })),
  approveTouch: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  enqueueOutbox: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  listExpiredOffers: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  setOfferStatus: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  setWaitlistStatus: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));

vi.mock("@/lib/noshow/draft", () => ({
  draftNoshow: vi.fn(async (..._a: unknown[]) => ({ body: "hi" })),
}));
vi.mock("@/lib/noshow/fill", () => ({
  offerSlotToNextCandidate: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));
vi.mock("@/lib/noshow/cadence", () => ({
  stepDef: vi.fn(() => null),
  advanceAfter: vi.fn(() => ({ currentStep: 1, status: "active", nextDueAt: null, endedAt: null })),
  NOSHOW_CADENCE: [],
}));

import { POST as sweepPOST } from "./route";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { cronUnauthorized } from "@/lib/cron";
import { listDueCadences, listExpiredOffers } from "@/lib/noshow/repository";

const BASE = "http://localhost:3000/api/noshow/sweep";
function req(): Request {
  return new Request(BASE, { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.mocked(cronUnauthorized).mockReturnValue(null);
  vi.mocked(acquireCronLock).mockResolvedValue(true);
  vi.mocked(releaseCronLock).mockResolvedValue(undefined);
  vi.mocked(listDueCadences).mockResolvedValue([]);
  vi.mocked(listExpiredOffers).mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("noshow sweep: lock discipline on the happy path", () => {
  it("acquires then releases the lock", async () => {
    const res = await sweepPOST(req());
    expect(res.status).toBe(200);
    expect(acquireCronLock).toHaveBeenCalledWith("sweep-noshow", 310);
    expect(releaseCronLock).toHaveBeenCalledWith("sweep-noshow");
  });
});

describe("noshow sweep: another run already in progress", () => {
  it("skips without touching the queue when the lock is not won", async () => {
    vi.mocked(acquireCronLock).mockResolvedValueOnce(false);
    const res = await sweepPOST(req());
    const json = (await res.json()) as { ok?: boolean; skipped?: string };
    expect(res.status).toBe(200);
    expect(json.skipped).toBeTruthy();
    // Must NOT release a lock it does not own (that would drop the real holder's lease).
    expect(releaseCronLock).not.toHaveBeenCalled();
    expect(listDueCadences).not.toHaveBeenCalled();
  });
});

describe("noshow sweep: listDueCadences throws (DB / sync down)", () => {
  it("fails closed - releases the lock and never leaves it held", async () => {
    vi.mocked(listDueCadences).mockRejectedValueOnce(new Error("sync down"));
    // The run may reject (fail closed) rather than returning a 200, but the lock
    // MUST be released so the next tick is not silenced for the full lease.
    await expect(sweepPOST(req())).rejects.toThrow("sync down");
    expect(releaseCronLock).toHaveBeenCalledWith("sweep-noshow");
    // The lock was won once and released once: no leak, no double-hold.
    expect(acquireCronLock).toHaveBeenCalledTimes(1);
    expect(releaseCronLock).toHaveBeenCalledTimes(1);
  });
});

describe("noshow sweep: listExpiredOffers throws mid-run", () => {
  it("still releases the lock (finally runs after the offer phase throws)", async () => {
    vi.mocked(listExpiredOffers).mockRejectedValueOnce(new Error("offers query failed"));
    await expect(sweepPOST(req())).rejects.toThrow("offers query failed");
    expect(releaseCronLock).toHaveBeenCalledWith("sweep-noshow");
  });
});
