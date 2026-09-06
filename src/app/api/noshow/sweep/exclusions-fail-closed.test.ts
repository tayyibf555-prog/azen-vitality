// ===========================================================================
// THE NO-SHOW SWEEP, WITH THE EXCLUSION LIST UNREADABLE (ruling W1-B/2).
//
// "Exclusions unknown means nobody may be drafted." This route's refusal was
// written in wave 1 and NOTHING observed it: first-tick-ramp.test.ts and
// resilience.test.ts hand it `isExclusionsUnavailable: () => false` next to an
// empty `loadExcludedTargetKeys`, which makes the branch structurally
// unreachable. Replacing the refusal with `excludedKeys = new Set<string>()` —
// the exact fail-OPEN regression the ruling forbids — left the FULL suite green.
//
// The harm is specific here: src/lib/noshow/ramp.ts's `disposeCadence` answers
// "suppress" only when `excluded` is true, so an empty set routes every otherwise
// eligible patient — including one a human marked `inactive`, which has no
// message_suppression second net at the drain — straight to "send", on a sweep
// that runs every ten minutes in production.
//
// THE REAL PREDICATE AND THE REAL ERROR CLASS run here (a partial mock keeps
// them; only the read itself is replaced), because a test that mocks the
// predicate proves the route's `if`, not the ruling.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  unavailable: false,
  otherFailure: false,
  drafted: [] as string[],
  outbox: [] as string[],
  updates: [] as string[],
}));

vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: vi.fn(async () => true),
  isSystemEnabledForSend: vi.fn(async () => true),
}));

// PARTIAL: the real ExclusionsUnavailableError and the real isExclusionsUnavailable.
vi.mock("@/lib/patient-status/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/patient-status/repository")>();
  return {
    ...actual,
    loadExcludedTargetKeys: vi.fn(async () => {
      if (h.otherFailure) throw new Error("something else entirely");
      if (h.unavailable) throw new actual.ExclusionsUnavailableError(new Error("PGRST301"));
      return new Set<string>();
    }),
  };
});

vi.mock("@/lib/noshow/draft", () => ({
  draftNoshow: vi.fn(async (t: { id: string }) => {
    h.drafted.push(t.id);
    return { body: "Hello from Vitality" };
  }),
}));
vi.mock("@/lib/noshow/fill", () => ({ offerSlotToNextCandidate: vi.fn(async () => null) }));
vi.mock("@/lib/noshow/repository", () => ({
  listDueCadences: vi.fn(async () => [
    { id: "cad-1", targetId: "t-1", siteId: "site-cc", currentStep: 0, status: "active", nextDueAt: null },
  ]),
  getTarget: vi.fn(async (id: string) => ({
    id,
    siteId: "site-cc",
    dentallyPatientId: "pat-1",
    appointmentId: "appt-1",
    patientName: "Alex Berry",
    // Far enough ahead that the cadence is genuinely sendable rather than stale.
    appointmentStartAt: new Date(Date.now() + 36 * 3_600_000).toISOString(),
    appointmentState: "active",
    durationMin: 30,
    practitioner: null,
    riskScore: 40,
    riskBand: "medium",
    status: "pending",
    priorAttempts: 0,
    consent: { sms: true, email: true, marketing: false },
    updatedFromDentallyAt: new Date().toISOString(),
  })),
  incrementPriorAttempts: vi.fn(async () => {}),
  updateCadence: vi.fn(async (id: string) => {
    h.updates.push(id);
  }),
  insertTouch: vi.fn(async () => ({ id: "touch-1" })),
  approveTouch: vi.fn(async () => {}),
  enqueueOutbox: vi.fn(async (row: { toRef: string }) => {
    h.outbox.push(row.toRef);
  }),
  listExpiredOffers: vi.fn(async () => []),
  expireOffer: vi.fn(async () => false),
  setWaitlistStatus: vi.fn(async () => {}),
}));

import { POST } from "./route";

async function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/noshow/sweep", { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.unavailable = false;
  h.otherFailure = false;
  h.drafted = [];
  h.outbox = [];
  h.updates = [];
});

describe("no-show sweep: an unreadable exclusion list stops the tick", () => {
  it("noshow-sweep-skips-the-tick-when-the-exclusion-list-refuses", async () => {
    h.unavailable = true;
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: "exclusions unavailable" });
    expect(h.drafted, "a confirmation was drafted against an unknown exclusion list").toEqual([]);
    expect(h.outbox).toEqual([]);
    // ...and nothing is SETTLED either: a skipped tick is a delay, and these
    // cadences must still be sendable on the next one.
    expect(h.updates).toEqual([]);
  });

  it("and runs normally again as soon as the list can be read", async () => {
    // The refusal is a skip, not a latch. The normal answer carries the sweep's
    // counters; the refusal carries no `swept` at all.
    h.unavailable = false;
    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.swept, "the tick refused with a readable exclusion list").toBeDefined();
    expect(body.skipped).toBeUndefined();
  });

  it("does NOT report an unrelated failure as a tidy skip", async () => {
    h.otherFailure = true;
    await expect(run()).rejects.toThrow("something else entirely");
    expect(h.drafted).toEqual([]);
  });
});
