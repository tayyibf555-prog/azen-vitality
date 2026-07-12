import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 2 (consent + suppression gates): the recall sweep's queue-time consent gate.
// Proves a patient WITHOUT consent for the step's channel never has a message
// drafted or queued, and the cadence is settled with the right status (exhausted,
// not left dangling); and that a consented patient IS queued (control), so the
// consent check is what blocks. The reactivation/noshow/coordinator sweeps use the
// same channelConsented predicate shape.

const listDueCadences = vi.fn();
const getTarget = vi.fn();
const listTouches = vi.fn();
const updateCadence = vi.fn();
const setTargetStatus = vi.fn();
const markGraduated = vi.fn();
const insertTouch = vi.fn();
const approveTouch = vi.fn();
const enqueueOutbox = vi.fn();
const incrementPriorAttempts = vi.fn();
const draftRecall = vi.fn();

vi.mock("@/lib/recall/repository", () => ({
  listDueCadences: (...a: unknown[]) => listDueCadences(...a),
  getTarget: (...a: unknown[]) => getTarget(...a),
  listTouches: (...a: unknown[]) => listTouches(...a),
  incrementPriorAttempts: (...a: unknown[]) => incrementPriorAttempts(...a),
  updateCadence: (...a: unknown[]) => updateCadence(...a),
  setTargetStatus: (...a: unknown[]) => setTargetStatus(...a),
  markGraduated: (...a: unknown[]) => markGraduated(...a),
  insertTouch: (...a: unknown[]) => insertTouch(...a),
  approveTouch: (...a: unknown[]) => approveTouch(...a),
  enqueueOutbox: (...a: unknown[]) => enqueueOutbox(...a),
  // Daily-cap counter: 0 used, so the default limit never blocks these consent tests.
  countContactedToday: async () => 0,
}));
vi.mock("@/lib/recall/draft", () => ({ draftRecall: (...a: unknown[]) => draftRecall(...a) }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/recall/sweep/route";

function sweepRequest(): Request {
  return new Request("http://localhost/api/recall/sweep", { method: "POST" });
}

// Step 1 of RECALL_CADENCE is SMS, so consent.sms drives the first touch.
function target(consent: { sms: boolean; email: boolean; marketing: boolean }) {
  return {
    id: "site-cc:p-1:dentist",
    siteId: "site-cc",
    dentallyPatientId: "p-1",
    patientName: "Test Patient",
    recallType: "dentist",
    dueAt: new Date().toISOString(), // due today: not past grace, so exhausted not graduated
    overdueDays: 0,
    lastVisitAt: null,
    priorAttempts: 0,
    status: "due",
    consent,
    updatedFromDentallyAt: new Date().toISOString(),
  };
}

const CADENCE = {
  id: "cad-1",
  targetId: "site-cc:p-1:dentist",
  siteId: "site-cc",
  currentStep: 0, // next step = 1 (sms)
  status: "active",
  nextDueAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  endedAt: null,
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "");
  listDueCadences.mockResolvedValue([CADENCE]);
  listTouches.mockResolvedValue([]);
  draftRecall.mockResolvedValue({ body: "Your check-up is due." });
  insertTouch.mockResolvedValue({ id: "touch-1" });
});

describe("recall sweep queue-time consent gate", () => {
  it("never drafts or queues for a patient without SMS consent, and settles the cadence", async () => {
    getTarget.mockResolvedValue(target({ sms: false, email: true, marketing: false }));
    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(draftRecall).not.toHaveBeenCalled();
    expect(insertTouch).not.toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
    // The right status: cadence exhausted (ended), target settled, not left in limbo.
    expect(updateCadence).toHaveBeenCalledWith("cad-1", expect.objectContaining({ status: "exhausted" }));
    expect(setTargetStatus).toHaveBeenCalledWith("site-cc:p-1:dentist", "exhausted");
    expect(json.queued).toBe(0);
    expect(json.paused).toBe(1);
  });

  it("control: a consented patient is drafted and queued to the outbox", async () => {
    getTarget.mockResolvedValue(target({ sms: true, email: true, marketing: false }));
    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(enqueueOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ toRef: "patient:p-1", channel: "sms", siteId: "site-cc" }),
    );
    expect(json.queued).toBe(1);
  });
});
