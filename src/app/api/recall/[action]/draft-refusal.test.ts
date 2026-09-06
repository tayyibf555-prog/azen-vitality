// ===========================================================================
// WHAT THE COORDINATOR SEES WHEN A RECALL DRAFT WILL NOT FIT.
//
// draftRecall makes one repair turn and then throws RecallDraftTooLongError
// rather than truncating a message to a patient (src/lib/recall/sms-budget.ts).
// That refusal is by design; reaching the desk as an unexplained 500 was not.
// This route is the Draft button: a person clicked it, and the only thing they
// can act on is being told the message came out too long and nothing was queued.
//
// The three things a refusal must be: a 422 (the request was fine, the OUTPUT
// was not), a plain sentence, and NOTHING WRITTEN — no touch, no outbox row, no
// cadence created. The fourth test is the fail direction: an unrelated failure
// is still an unrelated failure and must not be dressed up as a tidy skip.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecallDraftTooLongError } from "@/lib/recall/sms-budget";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  /** How the draft fails: nothing, the length refusal, or something else. */
  failWith: null as null | "too-long" | "other",
  inserted: [] as unknown[],
  enqueued: [] as unknown[],
  createdCadences: [] as unknown[],
}));

// Auth is not enforced in this environment (no service-role key), so requireUser
// answers null and the real guards pass it through — the same posture the other
// route suites in this tree run under. Who may call this is pinned elsewhere;
// what this file is about is what happens after they have.
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireUser: async () => null };
});

vi.mock("@/lib/recall/draft", () => ({
  draftRecall: vi.fn(async () => {
    if (h.failWith === "other") throw new Error("the database went away mid-draft");
    if (h.failWith === "too-long") {
      throw new RecallDraftTooLongError("sms", {
        ok: false,
        units: 174,
        limit: 160,
        segments: 2,
        encoding: "gsm7",
        forcedUcs2By: null,
      });
    }
    return { body: "Hello from Vitality", rationale: "due for a check-up" };
  }),
}));

vi.mock("@/lib/recall/repository", () => ({
  getTarget: vi.fn(async (id: string) => ({
    id,
    siteId: "site-cc",
    dentallyPatientId: "pat-1",
    consent: { sms: true, email: true, marketing: false },
    dueAt: "2026-01-01T00:00:00Z",
  })),
  getCadenceByTarget: vi.fn(async () => null),
  createCadence: vi.fn(async (c: unknown) => {
    h.createdCadences.push(c);
    return { id: "cad-1", currentStep: 0 };
  }),
  updateCadence: vi.fn(async () => {}),
  incrementPriorAttempts: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
  markGraduated: vi.fn(async () => {}),
  insertTouch: vi.fn(async (t: unknown) => {
    h.inserted.push(t);
    return { id: "touch-1" };
  }),
  approveTouch: vi.fn(async () => ({ id: "touch-1" })),
  enqueueOutbox: vi.fn(async (o: unknown) => {
    h.enqueued.push(o);
    return {};
  }),
  listTouches: vi.fn(async () => []),
  hasPendingOutboxForTouch: vi.fn(async () => false),
}));

import { POST } from "./route";

async function draft(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/recall/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId: "site-cc:t-1", channel: "sms" }),
    }),
    { params: Promise.resolve({ action: "draft" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.failWith = null;
  h.inserted = [];
  h.enqueued = [];
  h.createdCadences = [];
});

describe("a manual recall draft that comes back too long", () => {
  it("recall-draft-too-long-is-a-422-and-a-sentence-not-a-500", async () => {
    h.failWith = "too-long";
    const res = await draft();
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe("draft_too_long");
    expect(body.autoQueued).toBe(false);
    expect(String(body.error)).toContain("too long");
    expect(String(body.error)).toContain("Nothing was queued");
  });

  it("recall-draft-too-long-writes-nothing-at-all", async () => {
    // The refusal happens before insertTouch, so there must be no half-record to
    // clean up: no touch, no outbox row, and no cadence started for a message
    // that is not going anywhere.
    h.failWith = "too-long";
    await draft();
    expect(h.inserted).toEqual([]);
    expect(h.enqueued).toEqual([]);
    expect(h.createdCadences).toEqual([]);
  });

  it("an ordinary draft is unchanged", async () => {
    const res = await draft();
    expect(res.status).toBe(200);
    expect(h.inserted).toHaveLength(1);
    expect(h.enqueued).toHaveLength(1);
  });

  it("recall-draft-still-surfaces-an-error-that-is-NOT-the-length-refusal", async () => {
    // Narrow on purpose: a database failure is not a message that will not fit,
    // and answering it with "that message came out too long" would send the desk
    // looking for a problem in the wording.
    h.failWith = "other";
    await expect(draft()).rejects.toThrow("the database went away mid-draft");
  });
});
