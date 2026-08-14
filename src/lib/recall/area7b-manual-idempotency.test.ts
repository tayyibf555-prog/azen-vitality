import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 7b (recall concierge): the MANUAL coordinator route must be idempotent.
//
// Bug being fixed: handleDraft inserts a fresh outbox row for the same step on
// every call, and handleApprove unconditionally enqueues (no state check), and
// recall_outbox has no unique constraint on touch_id. So a double-click / retry /
// concurrent coordinator action = DUPLICATE patient messages.
//
// Proves (each would fail without the guard):
//  1. Two draft calls for the same consented target+step enqueue the patient
//     message exactly ONCE (the second sees the pending touch and skips).
//  2. Two approve calls for the same touch enqueue exactly ONCE (the second sees
//     the already-queued outbox row and skips).

const getTarget = vi.fn();
const getCadenceByTarget = vi.fn();
const insertTouch = vi.fn();
const approveTouch = vi.fn();
const enqueueOutbox = vi.fn();
const listTouches = vi.fn();
const hasPendingOutboxForTouch = vi.fn();
const draftRecall = vi.fn();

// In-memory touch + outbox stores so a second manual call sees the state the
// first left behind (exactly what the real DB would do).
type Touch = { id: string; direction: string; status: string; body: string };
type Outbox = { id: string; touchId: string; status: string };
const touches: Touch[] = [];
const outbox: Outbox[] = [];

vi.mock("@/lib/recall/repository", () => ({
  getTarget: (...a: unknown[]) => getTarget(...a),
  getCadenceByTarget: (...a: unknown[]) => getCadenceByTarget(...a),
  createCadence: vi.fn(),
  updateCadence: vi.fn(),
  incrementPriorAttempts: vi.fn(),
  setTargetStatus: vi.fn(),
  markGraduated: vi.fn(),
  insertTouch: (...a: unknown[]) => insertTouch(...a),
  approveTouch: (...a: unknown[]) => approveTouch(...a),
  enqueueOutbox: (...a: unknown[]) => enqueueOutbox(...a),
  listTouches: (...a: unknown[]) => listTouches(...a),
  hasPendingOutboxForTouch: (...a: unknown[]) => hasPendingOutboxForTouch(...a),
}));
vi.mock("@/lib/recall/draft", () => ({ draftRecall: (...a: unknown[]) => draftRecall(...a) }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {}, DentallyError: class extends Error {} }));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: "u-1", role: "owner", siteIds: ["site-cc"] })),
  requireSiteAccess: vi.fn(() => null),
  // The route's module lock. Stubbed open here because these cases are about the
  // route's own behaviour, not the clinician deny-list — that lives in
  // src/lib/auth/module-api-guard.test.ts, and its presence on every route is
  // proven by src/app/api/client-api-module-guard-coverage.test.ts.
  requireModuleApiAccess: () => null,
}));

// The PER-PERSON capability gate, faked at the seam. Its own behaviour is proven
// in src/lib/auth/capability-guard.test.ts; that this route calls it is proven by
// the fs sweep in src/app/api/destructive-route-capability-coverage.test.ts.
vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => null,
  hasCapability: async () => true,
}));


import { POST } from "@/app/api/recall/[action]/route";

function req(action: string, body: Record<string, unknown>): [Request, { params: Promise<{ action: string }> }] {
  const request = new Request(`http://localhost/api/recall/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return [request, { params: Promise.resolve({ action }) }];
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
    status: "in_cadence",
    consent: { sms: true, email: true, marketing: false },
    updatedFromDentallyAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  touches.length = 0;
  outbox.length = 0;

  getTarget.mockResolvedValue(target());
  getCadenceByTarget.mockResolvedValue({ id: "cad-1", currentStep: 0 });
  draftRecall.mockResolvedValue({ body: "Your check-up is due.", rationale: "due now" });

  // insertTouch appends a draft touch to the store and returns it.
  insertTouch.mockImplementation(async () => {
    const t: Touch = { id: `touch-${touches.length + 1}`, direction: "outbound", status: "draft", body: "Your check-up is due." };
    touches.push(t);
    return t;
  });
  // approveTouch flips the touch to approved in place.
  approveTouch.mockImplementation(async (id: string) => {
    const t = touches.find((x) => x.id === id) ?? { id, direction: "outbound", status: "approved", body: "Your check-up is due." };
    t.status = "approved";
    return t;
  });
  // enqueueOutbox appends a queued outbox row for the touch.
  enqueueOutbox.mockImplementation(async (input: { touchId: string }) => {
    const o: Outbox = { id: `ob-${outbox.length + 1}`, touchId: input.touchId, status: "queued" };
    outbox.push(o);
    return o;
  });
  // listTouches / hasPendingOutboxForTouch reflect the live in-memory stores.
  listTouches.mockImplementation(async () => touches);
  hasPendingOutboxForTouch.mockImplementation(async (touchId: string) =>
    outbox.some((o) => o.touchId === touchId && o.status !== "failed"),
  );
});

describe("recall manual route — draft idempotency", () => {
  it("two draft calls for the same target+step enqueue the patient message only once", async () => {
    const first = await POST(...req("draft", { targetId: "site-cc:p-1:dentist", channel: "sms" }));
    expect(first.status).toBe(200);

    // Consent is present, so the first draft auto-approves + enqueues exactly once.
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(insertTouch).toHaveBeenCalledTimes(1);

    // Second draft (double-click / retry): a pending outbound touch already exists.
    const second = await POST(...req("draft", { targetId: "site-cc:p-1:dentist", channel: "sms" }));
    const json = await second.json();

    expect(json.skipped).toBe(true);
    // No second patient message: still exactly one insert + one enqueue.
    expect(insertTouch).toHaveBeenCalledTimes(1);
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(outbox).toHaveLength(1);
  });
});

describe("recall manual route — approve idempotency", () => {
  it("two approve calls for the same touch enqueue the patient message only once", async () => {
    // A drafted, unconsented-path touch awaiting manual approval.
    touches.push({ id: "touch-1", direction: "outbound", status: "draft", body: "Your check-up is due." });

    const first = await POST(...req("approve", { touchId: "touch-1", targetId: "site-cc:p-1:dentist", channel: "sms" }));
    expect(first.status).toBe(200);
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);

    // Second approve (double-click / concurrent coordinator): outbox row already exists.
    const second = await POST(...req("approve", { touchId: "touch-1", targetId: "site-cc:p-1:dentist", channel: "sms" }));
    const json = await second.json();

    expect(json.skipped).toBe(true);
    // No duplicate: still exactly one enqueue / one outbox row for this touch.
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(outbox.filter((o) => o.touchId === "touch-1")).toHaveLength(1);
  });
});
