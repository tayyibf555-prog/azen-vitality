import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 7 (recall concierge): sweep cadence/scheduling correctness + idempotency.
//
// Proves:
//  1. A due cadence is drafted + queued exactly once per sweep run, and the
//     cadence advances so the SAME step is never re-queued on the next run
//     (idempotent across ticks).
//  2. The `hasPending` guard: a cadence with an already-queued (unsent) touch is
//     skipped, never double-drafted, even if it is still `due` (approve-without-
//     send path). This is the anti-duplicate seam.
//  3. Scheduling: after step 1 (SMS) the next due is anchored to `now` + step-2
//     waitDays (5 days); the touch carries the right step + channel.
//  4. A final-step send exhausts the cadence and settles the target.

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

// A tiny in-memory cadence store so a second sweep sees the state the first left.
type Cad = {
  id: string;
  targetId: string;
  siteId: string;
  currentStep: number;
  status: string;
  nextDueAt: string | null;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
};
const cadences = new Map<string, Cad>();

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

function target(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "site-cc:p-1:dentist",
    siteId: "site-cc",
    dentallyPatientId: "p-1",
    patientName: "Test Patient",
    recallType: "dentist",
    dueAt: new Date().toISOString(),
    overdueDays: 0,
    lastVisitAt: null,
    priorAttempts: 0,
    status: "due",
    consent: { sms: true, email: true, marketing: false },
    updatedFromDentallyAt: new Date().toISOString(),
    ...over,
  };
}

function seedCadence(over: Partial<Cad> = {}): Cad {
  const c: Cad = {
    id: "cad-1",
    targetId: "site-cc:p-1:dentist",
    siteId: "site-cc",
    currentStep: 0,
    status: "active",
    nextDueAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    updatedAt: new Date().toISOString(),
    ...over,
  };
  cadences.set(c.id, c);
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  cadences.clear();
  vi.stubEnv("CRON_SECRET", "");
  draftRecall.mockResolvedValue({ body: "Your check-up is due." });
  insertTouch.mockImplementation(async () => ({ id: "touch-1" }));
  approveTouch.mockResolvedValue({ id: "touch-1", status: "approved" });
  // updateCadence mutates the in-memory store so a re-sweep sees the new state.
  updateCadence.mockImplementation(async (id: string, fields: Partial<Cad>) => {
    const c = cadences.get(id);
    if (c) cadences.set(id, { ...c, ...fields });
  });
  // listDueCadences returns only active cadences whose next_due_at <= now.
  listDueCadences.mockImplementation(async (nowIso: string) =>
    [...cadences.values()].filter(
      (c) => c.status === "active" && c.nextDueAt !== null && c.nextDueAt <= nowIso,
    ),
  );
  getTarget.mockResolvedValue(target());
  listTouches.mockResolvedValue([]);
});

describe("recall sweep — single-run queueing", () => {
  it("drafts and queues exactly once, advancing the cadence off 'due'", async () => {
    seedCadence({ currentStep: 0 });
    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(draftRecall).toHaveBeenCalledTimes(1);
    expect(insertTouch).toHaveBeenCalledTimes(1);
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(json.queued).toBe(1);

    // Step 1 is SMS; the queued touch carries the right step + channel.
    expect(insertTouch).toHaveBeenCalledWith(
      expect.objectContaining({ step: 1, channel: "sms" }),
    );
    // Cadence advanced to currentStep 1, still active with a future next_due_at.
    const c = cadences.get("cad-1")!;
    expect(c.currentStep).toBe(1);
    expect(c.status).toBe("active");
    expect(c.nextDueAt).not.toBeNull();
  });

  it("anchors step 2 five days after the step-1 send (scheduling correctness)", async () => {
    const now = Date.now();
    seedCadence({ currentStep: 0 });
    await POST(sweepRequest());
    const c = cadences.get("cad-1")!;
    const gapDays = (new Date(c.nextDueAt!).getTime() - now) / 86_400_000;
    // RECALL_CADENCE step 2 waitDays === 5.
    expect(gapDays).toBeGreaterThan(4.9);
    expect(gapDays).toBeLessThan(5.1);
  });
});

describe("recall sweep — idempotency across ticks", () => {
  it("does NOT re-queue the same step when run twice back-to-back", async () => {
    seedCadence({ currentStep: 0 });

    // First tick: queues step 1, advances next_due_at 5 days out.
    await POST(sweepRequest());
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);

    // Second tick immediately after: next_due_at is now 5 days in the future, so
    // listDueCadences returns nothing -> no second draft/queue for the same step.
    const res2 = await POST(sweepRequest());
    const json2 = await res2.json();
    expect(json2.swept).toBe(0);
    expect(enqueueOutbox).toHaveBeenCalledTimes(1); // unchanged: no duplicate touch
  });

  it("skips (pauses) a cadence that still has a queued, unsent touch — no double draft", async () => {
    // Cadence is due but a prior touch is queued and not yet sent (drain lagging,
    // or coordinator approved without sending). hasPending must block a new draft.
    seedCadence({ currentStep: 0, nextDueAt: new Date().toISOString() });
    listTouches.mockResolvedValue([
      { direction: "outbound", status: "queued" },
    ]);

    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(draftRecall).not.toHaveBeenCalled();
    expect(insertTouch).not.toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
    expect(json.paused).toBe(1);
    expect(json.queued).toBe(0);
  });

  it("a SENT prior touch does NOT block the next step (hasPending is sent-aware)", async () => {
    // currentStep 1 already sent; next step (2, email) is due. A sent step-1 touch
    // must not be treated as pending.
    seedCadence({ currentStep: 1, nextDueAt: new Date().toISOString() });
    listTouches.mockResolvedValue([
      { direction: "outbound", status: "sent" },
    ]);

    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(insertTouch).toHaveBeenCalledWith(
      expect.objectContaining({ step: 2, channel: "email" }),
    );
    expect(json.queued).toBe(1);
  });
});

describe("recall sweep — exhaustion + settle", () => {
  it("exhausts and settles (exhausted, not graduated) after the final step when within grace", async () => {
    // currentStep 3 already sent; no step 4 exists -> exhausts. dueAt today => within grace.
    seedCadence({ currentStep: 3, nextDueAt: new Date().toISOString() });
    getTarget.mockResolvedValue(target({ dueAt: new Date().toISOString() }));

    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(updateCadence).toHaveBeenCalledWith(
      "cad-1",
      expect.objectContaining({ status: "exhausted" }),
    );
    expect(setTargetStatus).toHaveBeenCalledWith("site-cc:p-1:dentist", "exhausted");
    expect(markGraduated).not.toHaveBeenCalled();
    expect(json.exhausted).toBe(1);
    expect(json.graduated).toBe(0);
    expect(draftRecall).not.toHaveBeenCalled();
  });

  it("graduates to reactivation (not plain exhausted) when the final step lands past grace", async () => {
    // Past the 60-day grace boundary: exhaustion hands off to reactivation.
    const pastGrace = new Date(Date.now() - 90 * 86_400_000).toISOString();
    seedCadence({ currentStep: 3, nextDueAt: new Date().toISOString() });
    getTarget.mockResolvedValue(target({ dueAt: pastGrace }));

    const res = await POST(sweepRequest());
    const json = await res.json();

    expect(markGraduated).toHaveBeenCalledWith("site-cc:p-1:dentist");
    expect(setTargetStatus).not.toHaveBeenCalledWith("site-cc:p-1:dentist", "exhausted");
    expect(json.graduated).toBe(1);
    expect(json.exhausted).toBe(0);
  });
});
