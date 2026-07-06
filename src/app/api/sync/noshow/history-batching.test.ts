// BOUNDED-CONCURRENCY history batching (the fix that stopped the last site being
// starved). The no-show sync fetches each live patient's risk history at most ONCE,
// in parallel batches capped at HISTORY_CONCURRENCY. A single patient's history
// failure isolates to that patient (their appointments are skipped), never killing
// the run or the other patients' targets. Client, repo, lock and sites are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const HISTORY_CONCURRENCY = 6; // must match the route constant

const repo = vi.hoisted(() => ({
  upsertCalls: [] as Array<Array<{ dentallyPatientId: string }>>,
  upsertTargets: vi.fn(async (b: Array<{ dentallyPatientId: string }>) => { repo.upsertCalls.push(b); }),
  listTargets: vi.fn(async (): Promise<unknown[]> => []),
  getCadenceByTarget: vi.fn(async (): Promise<unknown> => null),
  createCadence: vi.fn(async () => {}),
  updateCadence: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
  getSyncState: vi.fn(async (): Promise<unknown> => null),
  setSyncState: vi.fn(async () => {}),
  offerSlotToNextCandidate: vi.fn(async () => ({ waitlistId: "w" })),
}));

const hist = vi.hoisted(() => ({
  inFlight: 0,
  peak: 0,
  callsByPid: new Map<string, number>(),
  failPid: null as string | null,
}));

const dent = vi.hoisted(() => ({
  appointments: [] as unknown[],
  patients: [] as unknown[],
  listAppointments: vi.fn(async (a: { page?: number }) => ({
    appointments: (a?.page ?? 1) === 1 ? dent.appointments : [],
  })),
  listPatients: vi.fn(async (a: { page?: number }) => ({
    patients: (a?.page ?? 1) === 1 ? dent.patients : [],
  })),
  getPatientAppointments: vi.fn(async (pid: string) => {
    hist.callsByPid.set(pid, (hist.callsByPid.get(pid) ?? 0) + 1);
    hist.inFlight += 1;
    hist.peak = Math.max(hist.peak, hist.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    hist.inFlight -= 1;
    if (pid === hist.failPid) throw new Error("history 500");
    return { appointments: [] as unknown[] };
  }),
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listAppointments(a: unknown) { return dent.listAppointments(a as { page?: number }); }
    listPatients(a: unknown) { return dent.listPatients(a as { page?: number }); }
    getPatientAppointments(id: unknown) { return dent.getPatientAppointments(id as string); }
  },
}));
vi.mock("@/lib/noshow/repository", () => ({
  upsertTargets: (...a: unknown[]) => repo.upsertTargets(a[0] as Array<{ dentallyPatientId: string }>),
  listTargets: () => repo.listTargets(),
  getCadenceByTarget: () => repo.getCadenceByTarget(),
  createCadence: () => repo.createCadence(),
  updateCadence: () => repo.updateCadence(),
  setTargetStatus: () => repo.setTargetStatus(),
  getSyncState: () => repo.getSyncState(),
  setSyncState: () => repo.setSyncState(),
}));
vi.mock("@/lib/noshow/fill", () => ({
  offerSlotToNextCandidate: () => repo.offerSlotToNextCandidate(),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

function setup(patientIds: string[]) {
  dent.appointments = patientIds.map((pid, i) => ({
    id: `appt-${i}`,
    patient_id: pid,
    start_time: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    state: "booked",
    duration: 30,
  }));
  const uniq = [...new Set(patientIds)];
  dent.patients = uniq.map((pid) => ({ id: pid, first_name: "A", last_name: pid, use_sms: true, use_email: true }));
}

function req(): Request {
  return new Request("http://localhost/api/sync/noshow", {
    method: "POST", headers: { authorization: "Bearer batch-secret" },
  });
}

function upsertedPids(): string[] {
  return repo.upsertCalls.flat().map((t) => t.dentallyPatientId);
}

beforeEach(() => {
  hist.inFlight = 0; hist.peak = 0; hist.callsByPid = new Map(); hist.failPid = null;
  repo.upsertCalls = [];
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "batch-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
});
afterEach(() => vi.unstubAllEnvs());

describe("no-show history batching", () => {
  it("fetches each patient's history only once, even with multiple appointments", async () => {
    setup(["pat-0", "pat-0", "pat-1", "pat-2"]); // pat-0 has two appointments
    await POST(req());

    expect(hist.callsByPid.get("pat-0")).toBe(1); // deduped
    expect([...hist.callsByPid.values()].reduce((a, b) => a + b, 0)).toBe(3); // 3 unique patients
    // All 4 appointments still become targets (both of pat-0's slots).
    expect(upsertedPids().sort()).toEqual(["pat-0", "pat-0", "pat-1", "pat-2"]);
  });

  it("caps concurrent history fetches at HISTORY_CONCURRENCY", async () => {
    setup(Array.from({ length: 20 }, (_, i) => `pat-${i}`));
    await POST(req());

    expect(hist.callsByPid.size).toBe(20);
    expect(hist.peak).toBeGreaterThan(1); // genuinely parallel, not serial
    expect(hist.peak).toBeLessThanOrEqual(HISTORY_CONCURRENCY); // but bounded
  });

  it("isolates a single patient's history failure without losing the others", async () => {
    setup(["pat-0", "pat-1", "pat-2", "pat-3", "pat-4"]);
    hist.failPid = "pat-2";

    const res = await POST(req());
    expect(res.status).toBe(200);

    const pids = upsertedPids();
    expect(pids).not.toContain("pat-2"); // failed read -> skipped, never messaged
    expect(pids.sort()).toEqual(["pat-0", "pat-1", "pat-3", "pat-4"]);
  });
});
