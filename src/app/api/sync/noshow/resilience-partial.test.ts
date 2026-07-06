// RESILIENCE: the no-show sync must survive a mid-run Dentally failure on the
// biggest site. Consent now comes from a per-site listPatients map (not a
// getPatient call per appointment), and each appointment page is upserted as it
// is built. So when a later listing page fails (rate limit / timeout):
//   1. the pages already processed keep their targets (no total loss), and
//   2. the partial pull must NOT reconcile still-booked, unseen appointments to
//      "cancelled" (which would wrongly free their slots to the waitlist).
// The client, repository, lock and site list are mocked; no network or DB.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PER_PAGE = 100;

const repo = vi.hoisted(() => ({
  existing: [] as unknown[],
  upsertCalls: [] as unknown[][],
  upsertTargets: vi.fn(async (batch: unknown[]) => { repo.upsertCalls.push(batch); }),
  listTargets: vi.fn(async (): Promise<unknown[]> => repo.existing),
  getCadenceByTarget: vi.fn(async (): Promise<unknown> => null),
  createCadence: vi.fn(async () => {}),
  updateCadence: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async (..._a: unknown[]) => {}),
  getSyncState: vi.fn(async (): Promise<unknown> => null),
  setSyncState: vi.fn(async () => {}),
  offerSlotToNextCandidate: vi.fn(async () => ({ waitlistId: "w" })),
}));

// listAppointments: page 1 returns a full page of future booked appointments;
// page 2 throws (simulating a rate limit / timeout partway through the window).
const dent = vi.hoisted(() => ({
  listAppointments: vi.fn(async (a: { page?: number }) => {
    const page = a?.page ?? 1;
    if (page === 1) {
      const appointments = Array.from({ length: PER_PAGE }, (_, i) => ({
        id: `appt-${i}`,
        patient_id: `pat-${i}`,
        start_time: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        state: "booked",
        duration: 30,
      }));
      return { appointments };
    }
    throw new Error("Dentally 403: rate limit");
  }),
  listPatients: vi.fn(async (a: { page?: number }) => {
    const page = a?.page ?? 1;
    if (page > 1) return { patients: [] };
    const patients = Array.from({ length: PER_PAGE }, (_, i) => ({
      id: `pat-${i}`, first_name: "A", last_name: "B", use_sms: true, use_email: true,
    }));
    return { patients };
  }),
  getPatientAppointments: vi.fn(async () => ({ appointments: [] as unknown[] })),
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
    getPatientAppointments(id: unknown) { return dent.getPatientAppointments(); }
  },
}));
vi.mock("@/lib/noshow/repository", () => ({
  upsertTargets: (...a: unknown[]) => repo.upsertTargets(a[0] as unknown[]),
  listTargets: (...a: unknown[]) => repo.listTargets(),
  getCadenceByTarget: (...a: unknown[]) => repo.getCadenceByTarget(),
  getCadencesByTargets: async () => new Map(),
  createCadence: (...a: unknown[]) => repo.createCadence(),
  updateCadence: (...a: unknown[]) => repo.updateCadence(),
  setTargetStatus: (...a: unknown[]) => repo.setTargetStatus(...a),
  getSyncState: (...a: unknown[]) => repo.getSyncState(),
  setSyncState: (...a: unknown[]) => repo.setSyncState(),
}));
vi.mock("@/lib/noshow/fill", () => ({
  offerSlotToNextCandidate: (...a: unknown[]) => repo.offerSlotToNextCandidate(),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

function req(): Request {
  return new Request("http://localhost/api/sync/noshow", {
    method: "POST", headers: { authorization: "Bearer partial-secret" },
  });
}

beforeEach(() => {
  repo.existing = [];
  repo.upsertCalls = [];
  vi.clearAllMocks();
  repo.listTargets.mockImplementation(async () => repo.existing);
  vi.stubEnv("CRON_SECRET", "partial-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
});
afterEach(() => vi.unstubAllEnvs());

describe("no-show sync partial-pull resilience", () => {
  it("keeps the pages it processed when a later listing page fails", async () => {
    const res = await POST(req());
    const body = (await res.json()) as { ok: boolean; perSite: Array<{ upserted?: number }> };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // Page 1's 100 targets were upserted before page 2 threw (durable, not lost).
    expect(repo.upsertCalls.length).toBeGreaterThanOrEqual(1);
    const totalUpserted = repo.upsertCalls.reduce((n, b) => n + b.length, 0);
    expect(totalUpserted).toBe(PER_PAGE);
    expect(body.perSite[0].upserted).toBe(PER_PAGE);
  });

  it("does NOT cancel a still-booked, unseen appointment on a partial window", async () => {
    // An existing scheduled target whose appointment sits on the page that never
    // loaded. A full-window pull would treat it as vanished -> cancelled; a partial
    // pull must leave it alone.
    repo.existing = [{
      id: "site-1:pat-900:appt-900",
      siteId: "site-1",
      dentallyPatientId: "pat-900",
      appointmentId: "appt-900",
      patientName: "Z Z",
      appointmentStartAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      appointmentState: "booked",
      durationMin: 30,
      practitioner: null,
      riskScore: 40,
      riskBand: "medium",
      status: "scheduled",
      priorAttempts: 0,
      consent: { sms: true, email: true, marketing: false },
      updatedFromDentallyAt: new Date().toISOString(),
    }];

    await POST(req());

    // Never reconciled to cancelled, and its slot never offered to the waitlist.
    expect(repo.setTargetStatus).not.toHaveBeenCalledWith("site-1:pat-900:appt-900", "cancelled");
    expect(repo.offerSlotToNextCandidate).not.toHaveBeenCalled();
  });
});
