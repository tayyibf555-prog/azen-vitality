// AREA 4 (sync overlap locks): the dentally sync route must take the shared
// cron lease-lock before touching Dentally, skip cleanly when another run
// holds it, and always release its own lease. Without the lock, a slow run
// overlapping the next hourly tick would double the Dentally load and race
// the high-water mark. The lock module and Dentally client are mocked; no
// network or database is touched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fakes = vi.hoisted(() => ({
  acquireCronLock: vi.fn<(name: string, ttl: number) => Promise<boolean>>(),
  releaseCronLock: vi.fn(async (_name: string) => {}),
  listTreatmentPlans: vi.fn(async (_args: unknown) => ({ treatment_plans: [] })),
  getPatient: vi.fn(async (_id: unknown) => ({ patient: {} })),
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: (name: string, ttl: number) => fakes.acquireCronLock(name, ttl),
  releaseCronLock: (name: string) => fakes.releaseCronLock(name),
}));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient {
    constructor(_opts: unknown) {}
    listTreatmentPlans(args: unknown) {
      return fakes.listTreatmentPlans(args as never);
    }
    getPatient(id: string) {
      return fakes.getPatient(id as never);
    }
  },
}));
vi.mock("@/lib/coordinator/repository", () => ({
  getSyncState: vi.fn(async () => null),
  setSyncState: vi.fn(async () => {}),
  upsertOpportunities: vi.fn(async () => {}),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
}));

import { POST } from "./route";

function syncRequest(auth = "Bearer area4-test-secret"): Request {
  return new Request("http://localhost/api/sync/dentally", {
    method: "POST",
    headers: { authorization: auth },
  });
}

beforeEach(() => {
  fakes.acquireCronLock.mockReset();
  fakes.releaseCronLock.mockClear();
  fakes.listTreatmentPlans.mockClear();
  fakes.getPatient.mockClear();
  vi.stubEnv("CRON_SECRET", "area4-test-secret");
  vi.stubEnv("DENTALLY_API_KEY", "area4-test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sync/dentally cron lock", () => {
  it("skips the run (and never calls Dentally) when the lock is held", async () => {
    fakes.acquireCronLock.mockResolvedValue(false);

    const res = await POST(syncRequest());
    const body = await res.json();

    expect(body).toEqual({ ok: true, skipped: "another run in progress" });
    expect(fakes.listTreatmentPlans).not.toHaveBeenCalled();
    // We did not win the lease, so we must not clobber the other run's lease.
    expect(fakes.releaseCronLock).not.toHaveBeenCalled();
  });

  it("acquires a unique lease (sync-dentally, maxDuration + 10) and releases after the run", async () => {
    fakes.acquireCronLock.mockResolvedValue(true);

    const res = await POST(syncRequest());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.perSite).toHaveLength(1);
    expect(fakes.acquireCronLock).toHaveBeenCalledWith("sync-dentally", 310);
    expect(fakes.listTreatmentPlans).toHaveBeenCalled();
    expect(fakes.releaseCronLock).toHaveBeenCalledWith("sync-dentally");
  });

  it("releases the lease even when the Dentally pull fails", async () => {
    fakes.acquireCronLock.mockResolvedValue(true);
    fakes.listTreatmentPlans.mockRejectedValueOnce(new Error("dentally down"));

    const res = await POST(syncRequest());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.perSite[0].error).toContain("dentally down");
    expect(fakes.releaseCronLock).toHaveBeenCalledWith("sync-dentally");
  });

  it("rejects an unauthorized caller BEFORE touching the lock", async () => {
    fakes.acquireCronLock.mockResolvedValue(true);

    const res = await POST(syncRequest("Bearer wrong"));

    expect(res.status).toBe(401);
    expect(fakes.acquireCronLock).not.toHaveBeenCalled();
    expect(fakes.releaseCronLock).not.toHaveBeenCalled();
  });
});
