// RELIABILITY regressions for the no-show sync reconciliation (findings #4, #5).
//
// #4: an appointment cancelled/completed in Dentally (or vanished from a fully
// covered window) must retire the existing target and END its cadence — otherwise
// the sweep keeps sending "please confirm" for a dead appointment. A cancellation
// must also free the slot to the waitlist.
//
// #5: a rescheduled appointment (same Dentally id, new start_time) must RE-ANCHOR
// its cadence to the new time and drop any stale "confirmed" status, instead of
// leaving the cadence firing against the old time.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const repo = vi.hoisted(() => ({
  existing: [] as unknown[],
  cadence: null as unknown,
  upsertTargets: vi.fn(async (..._a: unknown[]) => {}),
  listTargets: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => repo.existing),
  getCadenceByTarget: vi.fn(async (..._a: unknown[]): Promise<unknown> => repo.cadence),
  createCadence: vi.fn(async (..._a: unknown[]) => {}),
  updateCadence: vi.fn(async (..._a: unknown[]) => {}),
  setTargetStatus: vi.fn(async (..._a: unknown[]) => {}),
  getSyncState: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  setSyncState: vi.fn(async (..._a: unknown[]) => {}),
  offerSlotToNextCandidate: vi.fn(async (..._a: unknown[]) => ({ waitlistId: "w-next" })),
}));

const dent = vi.hoisted(() => ({
  appointments: [] as unknown[],
  // Consent map source (built once per site from paged listPatients). pat-1 carries
  // consent so a LIVE appointment for it can be built into a target.
  patients: [{ id: "pat-1", first_name: "A", last_name: "B", use_sms: true, use_email: true }] as unknown[],
  listPatients: vi.fn(async (..._a: unknown[]) => ({ patients: dent.patients })),
  getPatientAppointments: vi.fn(async (..._a: unknown[]) => ({ appointments: [] as unknown[] })),
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listAppointments() { return Promise.resolve({ appointments: dent.appointments }); }
    listPatients(a: unknown) { return dent.listPatients(a); }
    getPatientAppointments(id: unknown) { return dent.getPatientAppointments(id); }
  },
}));
vi.mock("@/lib/noshow/repository", () => ({
  upsertTargets: (...a: unknown[]) => repo.upsertTargets(...a),
  listTargets: (...a: unknown[]) => repo.listTargets(...a),
  getCadenceByTarget: (...a: unknown[]) => repo.getCadenceByTarget(...a),
  // Batched variant used by the enrolment pass: mirror getCadenceByTarget's
  // single-cadence fixture for every requested id.
  getCadencesByTargets: async (ids: string[]) => {
    const m = new Map<string, unknown>();
    if (repo.cadence) for (const id of ids) m.set(id, repo.cadence);
    return m;
  },
  createCadence: (...a: unknown[]) => repo.createCadence(...a),
  updateCadence: (...a: unknown[]) => repo.updateCadence(...a),
  setTargetStatus: (...a: unknown[]) => repo.setTargetStatus(...a),
  getSyncState: (...a: unknown[]) => repo.getSyncState(...a),
  setSyncState: (...a: unknown[]) => repo.setSyncState(...a),
}));
vi.mock("@/lib/noshow/fill", () => ({
  offerSlotToNextCandidate: (...a: unknown[]) => repo.offerSlotToNextCandidate(...a),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

const IN_2_DAYS = () => new Date(Date.now() + 2 * 86_400_000).toISOString();
const IN_9_DAYS = () => new Date(Date.now() + 9 * 86_400_000).toISOString();

function existingTarget(over: Record<string, unknown> = {}) {
  return {
    id: "site-1:pat-1:appt-1",
    siteId: "site-1",
    dentallyPatientId: "pat-1",
    appointmentId: "appt-1",
    patientName: "A B",
    appointmentStartAt: IN_2_DAYS(),
    appointmentState: "booked",
    durationMin: 30,
    practitioner: "Dr Khan",
    riskScore: 40,
    riskBand: "medium",
    status: "scheduled",
    priorAttempts: 0,
    consent: { sms: true, email: true, marketing: false },
    updatedFromDentallyAt: new Date().toISOString(),
    ...over,
  };
}

function req(): Request {
  return new Request("http://localhost/api/sync/noshow", {
    method: "POST",
    headers: { authorization: "Bearer reconcile-secret" },
  });
}

beforeEach(() => {
  repo.existing = [];
  repo.cadence = null;
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "reconcile-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
  repo.listTargets.mockImplementation(async () => repo.existing);
  repo.getCadenceByTarget.mockImplementation(async () => repo.cadence);
});

afterEach(() => vi.unstubAllEnvs());

describe("#4: Dentally-side cancellation reconciles the target", () => {
  it("cancels the target, ends the cadence, and offers the freed slot to the waitlist", async () => {
    const start = IN_2_DAYS();
    repo.existing = [existingTarget({ appointmentStartAt: start, status: "scheduled" })];
    repo.cadence = { id: "cad-1", status: "active" };
    // Dentally now returns the appointment as cancelled.
    dent.appointments = [{ id: "appt-1", patient_id: "pat-1", start_time: start, state: "cancelled", duration: 30 }];

    const res = await POST(req());
    expect(res.status).toBe(200);

    expect(repo.setTargetStatus).toHaveBeenCalledWith("site-1:pat-1:appt-1", "cancelled");
    expect(repo.updateCadence).toHaveBeenCalledWith("cad-1", expect.objectContaining({ status: "cancelled" }));
    expect(repo.offerSlotToNextCandidate).toHaveBeenCalledTimes(1);
    const slot = repo.offerSlotToNextCandidate.mock.calls[0][0] as { appointmentId: string };
    expect(slot.appointmentId).toBe("appt-1");
    // The cancelled appointment must NOT be re-enrolled as a live target.
    expect(repo.createCadence).not.toHaveBeenCalled();
  });

  it("does NOT re-offer a slot already reconciled to cancelled (idempotent)", async () => {
    const start = IN_2_DAYS();
    repo.existing = [existingTarget({ appointmentStartAt: start, status: "cancelled" })];
    repo.cadence = { id: "cad-1", status: "cancelled" };
    dent.appointments = [{ id: "appt-1", patient_id: "pat-1", start_time: start, state: "cancelled", duration: 30 }];

    await POST(req());
    expect(repo.setTargetStatus).not.toHaveBeenCalled();
    expect(repo.offerSlotToNextCandidate).not.toHaveBeenCalled();
  });
});

describe("#4: an appointment that vanished from a fully-covered window", () => {
  it("is reconciled to cancelled (empty pull, no cap hit)", async () => {
    repo.existing = [existingTarget({ status: "scheduled" })];
    repo.cadence = { id: "cad-1", status: "active" };
    dent.appointments = []; // gone from Dentally; remaining === 0

    await POST(req());
    expect(repo.setTargetStatus).toHaveBeenCalledWith("site-1:pat-1:appt-1", "cancelled");
    expect(repo.updateCadence).toHaveBeenCalledWith("cad-1", expect.objectContaining({ status: "cancelled" }));
    expect(repo.offerSlotToNextCandidate).toHaveBeenCalledTimes(1);
  });

  it("does NOT cancel a target whose appointment is outside the sync window", async () => {
    // Start 9 days out is inside the 14-day lead window; push it well beyond.
    repo.existing = [existingTarget({ appointmentStartAt: new Date(Date.now() + 40 * 86_400_000).toISOString() })];
    repo.cadence = { id: "cad-1", status: "active" };
    dent.appointments = [];

    await POST(req());
    expect(repo.setTargetStatus).not.toHaveBeenCalled();
    expect(repo.offerSlotToNextCandidate).not.toHaveBeenCalled();
  });
});

describe("#5: rescheduled appointment re-anchors the cadence", () => {
  it("resets a stale 'confirmed' to scheduled and re-anchors the cadence to the new time", async () => {
    const oldStart = IN_9_DAYS();
    const newStart = IN_2_DAYS();
    repo.existing = [existingTarget({ appointmentStartAt: oldStart, status: "confirmed" })];
    repo.cadence = { id: "cad-1", status: "confirmed" };
    // Same appointment id, moved earlier.
    dent.appointments = [{ id: "appt-1", patient_id: "pat-1", start_time: newStart, state: "booked", duration: 30 }];

    const res = await POST(req());
    expect(res.status).toBe(200);

    // Re-anchored, not freshly created; re-activated with a new due time.
    expect(repo.updateCadence).toHaveBeenCalledWith(
      "cad-1",
      expect.objectContaining({ status: "active", endedAt: null }),
    );
    expect(repo.createCadence).not.toHaveBeenCalled();
    // The upserted target carries the NEW start and a reset 'scheduled' status.
    const upserted = repo.upsertTargets.mock.calls[0][0] as Array<{ appointmentStartAt: string; status: string }>;
    expect(upserted[0].appointmentStartAt).toBe(newStart);
    expect(upserted[0].status).toBe("scheduled");
  });

  it("leaves an unchanged appointment's cadence untouched (no re-anchor)", async () => {
    const start = IN_2_DAYS();
    repo.existing = [existingTarget({ appointmentStartAt: start, status: "scheduled" })];
    repo.cadence = { id: "cad-1", status: "active" };
    dent.appointments = [{ id: "appt-1", patient_id: "pat-1", start_time: start, state: "booked", duration: 30 }];

    await POST(req());
    expect(repo.updateCadence).not.toHaveBeenCalled();
    expect(repo.createCadence).not.toHaveBeenCalled();
  });
});
