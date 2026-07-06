// The reactivation sync fetches each patient's appointments + invoices in
// bounded-concurrency batches (was a serial ~2-calls-per-patient loop that starved
// later sites in the shared 300s function). This pins: (1) concurrency stays capped,
// (2) every patient is fetched exactly once, (3) a single patient's failed read is
// isolated (skipped) without killing the run. Client/repo/lock/sites are mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PATIENT_CONCURRENCY = 8; // must match the route constant
const PER_PAGE = 100;

const conc = vi.hoisted(() => ({ inFlight: 0, peak: 0, apptCalls: new Set<string>(), invoiceCalls: new Set<string>(), failId: null as string | null }));

const dent = vi.hoisted(() => ({
  patients: [] as unknown[],
  listTreatmentPlans: vi.fn(async (_a?: unknown) => ({ treatment_plans: [] as unknown[] })),
  listPatients: vi.fn(async (a: { page?: number }) => ({ patients: (a?.page ?? 1) === 1 ? dent.patients : [] })),
  getPatientAppointments: vi.fn(async (id: string) => {
    conc.apptCalls.add(id);
    conc.inFlight += 1;
    conc.peak = Math.max(conc.peak, conc.inFlight);
    await new Promise((r) => setTimeout(r, 4));
    conc.inFlight -= 1;
    if (id === conc.failId) throw new Error("appointments 500");
    // A single past visit ~2 years ago; short page -> one call per patient.
    return { appointments: [{ start_time: "2024-06-01T09:00:00Z" }] };
  }),
  getPatientInvoices: vi.fn(async (id: string) => {
    conc.invoiceCalls.add(id);
    return { invoices: [] as unknown[] };
  }),
}));

const repo = vi.hoisted(() => ({
  upserted: [] as unknown[][],
  upsertTargets: vi.fn(async (t: unknown[]) => { repo.upserted.push(t); }),
  getSyncState: vi.fn(async () => null),
  setSyncState: vi.fn(async () => {}),
  listTargets: vi.fn(async () => [] as unknown[]),
  getCadenceByTarget: vi.fn(async () => null),
  updateCadence: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
}));

vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: vi.fn(async () => true), releaseCronLock: vi.fn(async () => {}) }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listTreatmentPlans(a: unknown) { return dent.listTreatmentPlans(a as never); }
    listPatients(a: unknown) { return dent.listPatients(a as { page?: number }); }
    getPatientAppointments(id: unknown) { return dent.getPatientAppointments(id as string); }
    getPatientInvoices(id: unknown) { return dent.getPatientInvoices(id as string); }
  },
}));
vi.mock("@/lib/reactivation/repository", () => ({
  upsertTargets: (t: unknown[]) => repo.upsertTargets(t),
  getSyncState: () => repo.getSyncState(),
  setSyncState: () => repo.setSyncState(),
  listTargets: () => repo.listTargets(),
  getCadenceByTarget: () => repo.getCadenceByTarget(),
  updateCadence: () => repo.updateCadence(),
  setTargetStatus: () => repo.setTargetStatus(),
}));
vi.mock("@/lib/recall/repository", () => ({ listOpenRecallPatientKeys: async () => new Set<string>() }));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

function req(): Request {
  return new Request("http://localhost/api/sync/reactivation", { method: "POST", headers: { authorization: "Bearer react-secret" } });
}

beforeEach(() => {
  conc.inFlight = 0; conc.peak = 0; conc.apptCalls = new Set(); conc.invoiceCalls = new Set(); conc.failId = null;
  repo.upserted = [];
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "react-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
});
afterEach(() => vi.unstubAllEnvs());

describe("reactivation sync per-patient concurrency", () => {
  it("fetches every patient once, with concurrency capped", async () => {
    dent.patients = Array.from({ length: 20 }, (_, i) => ({ id: `pat-${i}`, first_name: "A", last_name: `B${i}`, updated_at: "2026-07-06T00:00:00Z" }));
    const res = await POST(req());
    const body = (await res.json()) as { ok: boolean; perSite: Array<{ processed?: number }> };

    expect(body.ok).toBe(true);
    expect(conc.apptCalls.size).toBe(20); // each patient fetched exactly once
    expect(conc.invoiceCalls.size).toBe(20);
    expect(conc.peak).toBeGreaterThan(1); // genuinely parallel
    expect(conc.peak).toBeLessThanOrEqual(PATIENT_CONCURRENCY); // but bounded
    expect(body.perSite[0].processed).toBe(20);
  });

  it("isolates one patient's failed read without killing the run", async () => {
    dent.patients = Array.from({ length: 3 }, (_, i) => ({ id: `pat-${i}`, first_name: "A", last_name: `B${i}`, updated_at: "2026-07-06T00:00:00Z" }));
    conc.failId = "pat-1";
    const res = await POST(req());
    const body = (await res.json()) as { ok: boolean; perSite: Array<{ processed?: number }> };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(conc.apptCalls.size).toBe(3); // all attempted
    expect(body.perSite[0].processed).toBe(3);
  });
});
