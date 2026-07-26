// The whole-practice dentally sync is RETIRED (superseded by /api/sync/coordinator,
// which writes the same treatment_opportunity rows with the live field names and a
// real backfill cursor). This file used to prove the route took the shared cron
// lease-lock; those assertions were deleted with the behaviour they described.
//
// What matters now is that the route is inert and says so: it must still reject an
// unauthorized caller, must answer 410 Gone to an authorized one, and must never
// touch Dentally, the database or the cron lock again. A retired endpoint that
// quietly answered 200 would look healthy while syncing nothing, which is exactly
// the failure this retirement exists to end.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fakes = vi.hoisted(() => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
  listTreatmentPlans: vi.fn(async () => ({ treatment_plans: [] })),
  getPatient: vi.fn(async () => ({ patient: {} })),
  upsertOpportunities: vi.fn(async () => {}),
  setSyncState: vi.fn(async () => {}),
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: () => fakes.acquireCronLock(),
  releaseCronLock: () => fakes.releaseCronLock(),
}));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient {
    constructor(_opts: unknown) {}
    listTreatmentPlans() { return fakes.listTreatmentPlans(); }
    getPatient() { return fakes.getPatient(); }
  },
}));
vi.mock("@/lib/coordinator/repository", () => ({
  getSyncState: vi.fn(async () => null),
  setSyncState: () => fakes.setSyncState(),
  upsertOpportunities: () => fakes.upsertOpportunities(),
}));

import { POST, GET } from "./route";

function syncRequest(auth = "Bearer area4-test-secret"): Request {
  return new Request("http://localhost/api/sync/dentally", {
    method: "POST",
    headers: { authorization: auth },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "area4-test-secret");
  vi.stubEnv("DENTALLY_API_KEY", "area4-test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sync/dentally is retired", () => {
  it("answers 410 Gone and points at the coordinator sync", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(syncRequest());
    const body = (await res.json()) as { ok: boolean; retired: boolean; supersededBy: string };

    expect(res.status).toBe(410);
    expect(body.ok).toBe(false);
    expect(body.retired).toBe(true);
    expect(body.supersededBy).toBe("/api/sync/coordinator");
    // Loud, so a re-enabled cron job is noticed rather than assumed healthy.
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });

  it("touches no Dentally endpoint, no database write and no cron lock", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await POST(syncRequest());

    expect(fakes.listTreatmentPlans).not.toHaveBeenCalled();
    expect(fakes.getPatient).not.toHaveBeenCalled();
    expect(fakes.upsertOpportunities).not.toHaveBeenCalled();
    expect(fakes.setSyncState).not.toHaveBeenCalled();
    expect(fakes.acquireCronLock).not.toHaveBeenCalled();
    expect(fakes.releaseCronLock).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("still rejects an unauthorized caller before anything else", async () => {
    const res = await POST(syncRequest("Bearer wrong"));
    expect(res.status).toBe(401);
  });

  it("keeps the pg_cron GET contract", () => {
    expect(GET).toBe(POST);
  });

  it("no longer imports the Dentally client or the opportunity repository", () => {
    const code = readFileSync(resolve(__dirname, "route.ts"), "utf8");
    expect(code).not.toMatch(/^import .*dentally\/client/m);
    expect(code).not.toMatch(/^import .*coordinator\/repository/m);
  });
});
