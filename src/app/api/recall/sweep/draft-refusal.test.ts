// ===========================================================================
// A MESSAGE THAT WILL NOT FIT IS ONE PATIENT'S DELAY, NOT THE MODULE'S OUTAGE.
//
// draftRecall makes one repair turn and then throws RecallDraftTooLongError
// rather than truncating (src/lib/recall/sms-budget.ts: a half-sentence about a
// dental appointment is worse than no message). Refusing is the right direction.
// Letting the refusal ESCAPE was not: the call sat bare inside the sweep's loop,
// the only enclosing try is the `finally { releaseCronLock }` and
// runWithDentallyPriority merely forwards — so one un-shortenable body 500'd the
// whole handler, dropped every remaining due cadence in the batch and returned
// none of the counters. Recall is this platform's highest-volume send surface
// against a 51,000-patient base, and a systematic over-run (long USPs are the
// ordinary cause — they are injected into the prompt) would have stopped it dead
// tick after tick with the switch still showing ON.
//
// So: counted, logged, stepped over — and VISIBLE, because `refused` on the
// response is the only thing that tells an owner the difference between "nobody
// was due" and "nothing we drafted would fit".
//
// The three properties, one test each:
//   1. the rest of the batch still goes out;
//   2. the refusal is reported rather than swallowed;
//   3. the refused patient is not written to at all, so the next tick retries.
// And the fourth, which is the fail direction: any OTHER error still aborts.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecallDraftTooLongError } from "@/lib/recall/sms-budget";

const h = vi.hoisted(() => ({
  /** Target ids whose draft must refuse, by throwing the real refusal error. */
  tooLong: new Set<string>(),
  /** Target ids whose draft must fail for some UNRELATED reason. */
  broken: new Set<string>(),
  inserted: [] as string[],
  enqueued: [] as string[],
  advanced: [] as string[],
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: vi.fn(async () => true),
  isSystemEnabledForSend: vi.fn(async () => true),
}));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: vi.fn(async () => new Set<string>()),
  isExclusionsUnavailable: () => false,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}::${patientId}`,
}));

// The REAL RecallDraftTooLongError is thrown here — the route recognises the
// refusal by its class, so a stand-in shape would prove nothing about the branch
// that actually runs in production.
vi.mock("@/lib/recall/draft", () => ({
  draftRecall: vi.fn(async (t: { id: string }) => {
    if (h.broken.has(t.id)) throw new Error("the database went away mid-draft");
    if (h.tooLong.has(t.id)) {
      throw new RecallDraftTooLongError("sms", {
        ok: false,
        units: 174,
        limit: 160,
        segments: 2,
        encoding: "gsm7",
        forcedUcs2By: null,
      });
    }
    return { body: "Hello from Vitality" };
  }),
}));
vi.mock("@/lib/recall/cadence", () => ({
  RECALL_CADENCE: [{ step: 1, channel: "sms" }],
  stepDef: (n: number) => (n === 1 ? { step: 1, channel: "sms" } : null),
  advanceAfter: () => ({ currentStep: 1, status: "active", nextDueAt: null, endedAt: null }),
}));
vi.mock("@/lib/recall/normalise", () => ({ shouldGraduate: () => false }));
vi.mock("@/lib/time/london", () => ({ londonOverdueDays: () => 0 }));
vi.mock("@/lib/recall/repository", () => ({
  listDueCadences: vi.fn(async () => [
    { id: "cad-long", targetId: "t-long", currentStep: 0 },
    { id: "cad-ok", targetId: "t-ok", currentStep: 0 },
  ]),
  getTarget: vi.fn(async (id: string) => ({
    id,
    dentallyPatientId: id.replace("t-", "pat-"),
    siteId: "site-cc",
    consent: { sms: true, email: true, marketing: false },
    dueAt: "2026-01-01T00:00:00Z",
  })),
  listTouches: vi.fn(async () => []),
  countContactedToday: vi.fn(async () => 0),
  insertTouch: vi.fn(async (t: { targetId: string }) => {
    h.inserted.push(t.targetId);
    return { id: `touch-${t.targetId}` };
  }),
  approveTouch: vi.fn(async () => {}),
  enqueueOutbox: vi.fn(async (o: { toRef: string }) => {
    h.enqueued.push(o.toRef);
    return {};
  }),
  incrementPriorAttempts: vi.fn(async (id: string) => {
    h.advanced.push(id);
  }),
  updateCadence: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
  markGraduated: vi.fn(async () => {}),
}));

import { POST } from "./route";

async function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/recall/sweep", { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tooLong = new Set<string>();
  h.broken = new Set<string>();
  h.inserted = [];
  h.enqueued = [];
  h.advanced = [];
});

describe("an un-shortenable recall body (ruling W1-B/1-5, charter 0/12)", () => {
  it("recall-sweep-over-long-draft-does-not-abort-the-tick", async () => {
    // THE HEADLINE. The refusing cadence is FIRST in the batch, which is the
    // arrangement that used to end the run: everything behind it was dropped.
    h.tooLong = new Set(["t-long"]);
    const res = await run();
    expect(res.status, "the tick 500'd on a refusal it was meant to survive").toBe(200);
    expect(h.enqueued).toEqual(["patient:pat-ok"]);
    expect(await res.json()).toMatchObject({ ok: true, queued: 1, drafted: 1 });
  });

  it("recall-sweep-reports-a-refused-draft-rather-than-swallowing-it", async () => {
    // A count nobody can see is the same outage, quieter. `refused` is what makes
    // "nothing we drafted would fit" distinguishable from "nobody was due".
    h.tooLong = new Set(["t-long"]);
    const body = (await (await run()).json()) as Record<string, number>;
    expect(body.refused).toBe(1);
    expect(body.swept).toBe(2);
  });

  it("recall-sweep-leaves-a-refused-cadence-untouched-so-the-next-tick-retries", async () => {
    // The throw precedes insertTouch, so there is nothing to undo: no touch, no
    // outbox row, no advance. The patient is drafted again next tick — which is
    // the whole reason a refusal may be a delay rather than a loss.
    h.tooLong = new Set(["t-long"]);
    await run();
    expect(h.inserted).toEqual(["t-ok"]);
    expect(h.advanced, "a refused cadence was advanced past its step").toEqual(["t-ok"]);
  });

  it("recall-sweep-reports-zero-refused-when-every-body-fits", async () => {
    const body = (await (await run()).json()) as Record<string, number>;
    expect(body.refused).toBe(0);
    expect(body.queued).toBe(2);
  });

  it("recall-sweep-still-aborts-on-an-error-that-is-NOT-the-length-refusal", async () => {
    // The catch is narrowed to RecallDraftTooLongError on purpose. A database
    // failure mid-draft is not a message that will not fit, and reporting it as a
    // tidy per-row skip would hide a real outage behind a counter.
    h.broken = new Set(["t-long"]);
    await expect(run()).rejects.toThrow("the database went away mid-draft");
    expect(h.enqueued).toEqual([]);
  });
});
