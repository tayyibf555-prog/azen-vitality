import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CoordinatorTouch, TreatmentOpportunity } from "./types";

// ---------------------------------------------------------------------------
// AREA 11+12 deep test: treatment-coordinator sweep.
//
// Focus: the cadence sweep is idempotent (no duplicate queue across ticks),
// consent-aware (never queues an SMS/email the patient has not consented to),
// pause-on-reply (an inbound touch stops the cadence), and dry-run safe (the
// sweep NEVER stub-sends: it only ever leaves rows queued for the shared drain,
// which is the sole place a provider is touched and where MESSAGING_DRY_RUN
// applies). We assert markTouchSent is never imported/called by the sweep.
// ---------------------------------------------------------------------------

// In-memory touch store keyed by opportunity id, plus recorders for the
// mutating repository calls the sweep makes.
let touchesByOpp: Record<string, CoordinatorTouch[]> = {};
let opportunities: TreatmentOpportunity[] = [];

const insertTouch = vi.fn(async (...a: unknown[]) => {
  const input = a[0] as {
    opportunityId: string;
    siteId: string;
    channel: CoordinatorTouch["channel"];
    body: string;
    draftedBy: CoordinatorTouch["draftedBy"];
    status?: CoordinatorTouch["status"];
  };
  const touch: CoordinatorTouch = {
    id: `t-${Math.random().toString(36).slice(2)}`,
    opportunityId: input.opportunityId,
    siteId: input.siteId,
    channel: input.channel,
    direction: "outbound",
    body: input.body,
    draftedBy: input.draftedBy,
    status: input.status ?? "draft",
    approvedBy: null,
    createdAt: new Date().toISOString(),
    sentAt: null,
  };
  (touchesByOpp[input.opportunityId] ??= []).push(touch);
  return touch;
});

const approveTouch = vi.fn(async (...a: unknown[]) => {
  const touchId = a[0] as string;
  for (const list of Object.values(touchesByOpp)) {
    const t = list.find((x) => x.id === touchId);
    if (t) {
      t.status = "approved";
      t.approvedBy = a[1] as string;
      return t;
    }
  }
  throw new Error("touch not found");
});

const enqueueOutbox = vi.fn(async (..._a: unknown[]) => ({ id: "ob-1" }));
const setLastTouchAt = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock("./repository", () => ({
  listOpportunities: vi.fn(async () => opportunities),
  listTouches: vi.fn(async (...a: unknown[]) => touchesByOpp[a[0] as string] ?? []),
  insertTouch: (...a: unknown[]) => insertTouch(...a),
  approveTouch: (...a: unknown[]) => approveTouch(...a),
  enqueueOutbox: (...a: unknown[]) => enqueueOutbox(...a),
  setLastTouchAt: (...a: unknown[]) => setLastTouchAt(...a),
  // markTouchSent intentionally omitted: if the sweep ever called it, the mock
  // module would throw "not a function", failing the dry-run-safety test.
}));

// Deterministic draft so we assert on queued content without a model call.
const draftOutreach = vi.fn(async (..._a: unknown[]) => ({
  body: "Hi Sarah, your Invisalign plan has £3400 outstanding. Happy to discuss a payment plan, shall I book a quick call?",
  rationale: "test",
}));
vi.mock("./draft", () => ({ draftOutreach: (...a: unknown[]) => draftOutreach(...a) }));

// Cron plumbing: authorised and lock always acquired.
vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
const releaseCronLock = vi.fn(async () => undefined);
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: () => releaseCronLock(),
}));

import { POST } from "@/app/api/coordinator/sweep/route";

function opp(over: Partial<TreatmentOpportunity> = {}): TreatmentOpportunity {
  return {
    id: "site-cc:p1:pl1",
    siteId: "site-cc",
    dentallyPatientId: "p1",
    dentallyPlanId: "pl1",
    patientName: "Sarah Lindqvist",
    treatment: "Invisalign full arch",
    plannedValue: 200,
    amountOutstanding: 200, // below default auto-send threshold (250) -> auto path
    acceptedAt: "2026-06-01T00:00:00Z",
    status: "accepted",
    financePresented: false,
    lastTouchAt: null,
    priorityScore: 1,
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: "2026-06-25T00:00:00Z",
    ...over,
  };
}

function sentTouch(opportunityId: string, channel: CoordinatorTouch["channel"]): CoordinatorTouch {
  return {
    id: `t-sent-${Math.random().toString(36).slice(2)}`,
    opportunityId,
    siteId: "site-cc",
    channel,
    direction: "outbound",
    body: "prior",
    draftedBy: "claude",
    status: "sent",
    approvedBy: "auto",
    createdAt: "2026-06-20T00:00:00Z",
    sentAt: "2026-06-20T00:00:00Z",
  };
}

async function runSweep(): Promise<Record<string, unknown>> {
  const res = await POST(new Request("https://x/api/coordinator/sweep", { method: "POST" }));
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  touchesByOpp = {};
  opportunities = [];
  vi.clearAllMocks();
});

describe("coordinator sweep — auto-send path", () => {
  it("queues step 1 exactly once and never stub-sends (leaves the row for the drain)", async () => {
    opportunities = [opp()];
    const out = await runSweep();

    expect(out.ok).toBe(true);
    expect(out.autoSent).toBe(1);
    // The sweep drafts, approves, enqueues, and stamps lastTouchAt — no send.
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(setLastTouchAt).toHaveBeenCalledTimes(1);
    // Dry-run safety: the sweep must not call any *send* primitive. enqueue only.
    const enqueuedBody = (enqueueOutbox.mock.calls[0][0] as { body: string }).body;
    expect(enqueuedBody).toContain("£3400");
  });

  it("does NOT re-queue on a second sweep while the first touch is still queued (idempotent)", async () => {
    opportunities = [opp()];
    await runSweep();
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);

    // The first sweep left an approved (queued) touch. Simulate the drain not yet
    // having sent it: the touch is still 'approved' in the store. Re-sweep.
    enqueueOutbox.mockClear();
    // lastTouchAt would have been stamped in prod; reflect that on the opp so the
    // due-check can't accidentally re-fire, but the pending-guard is the real gate.
    opportunities = [opp({ lastTouchAt: new Date().toISOString() })];
    const out2 = await runSweep();

    // Pending outbound touch (status 'approved', not sent/failed) blocks re-draft.
    expect(enqueueOutbox).not.toHaveBeenCalled();
    expect(out2.skipped).toBe(1);
    expect(out2.drafted).toBe(0);
  });

  it("advances to step 2 only after step 1 is sent and the wait has elapsed", async () => {
    // Step 1 sent 4 days ago; step 2 waitDays is 3, so it is due. Email channel.
    touchesByOpp["site-cc:p1:pl1"] = [sentTouch("site-cc:p1:pl1", "sms")];
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString();
    opportunities = [opp({ lastTouchAt: fourDaysAgo })];

    const out = await runSweep();
    expect(out.autoSent).toBe(1);
    // Step 2 is email — assert the channel queued matches the cadence.
    expect((enqueueOutbox.mock.calls[0][0] as { channel: string }).channel).toBe("email");
  });

  it("does not advance to step 2 before the wait window elapses", async () => {
    // Step 1 sent 1 day ago; step 2 needs 3 days. Not due.
    touchesByOpp["site-cc:p1:pl1"] = [sentTouch("site-cc:p1:pl1", "sms")];
    const oneDayAgo = new Date(Date.now() - 1 * 86_400_000).toISOString();
    opportunities = [opp({ lastTouchAt: oneDayAgo })];

    const out = await runSweep();
    expect(out.autoSent).toBe(0);
    expect(out.skipped).toBe(1);
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });
});

describe("coordinator sweep — consent awareness", () => {
  it("skips an SMS step when SMS consent is absent (never queues)", async () => {
    // Step 1 is SMS. No SMS consent -> skipped, nothing queued or drafted.
    opportunities = [opp({ consent: { sms: false, email: true, marketing: false } })];
    const out = await runSweep();

    expect(out.autoSent).toBe(0);
    expect(out.skipped).toBe(1);
    expect(draftOutreach).not.toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it("skips an EMAIL step when email consent is absent", async () => {
    // Force step 2 (email) to be due, but revoke email consent.
    touchesByOpp["site-cc:p1:pl1"] = [sentTouch("site-cc:p1:pl1", "sms")];
    const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString();
    opportunities = [
      opp({ lastTouchAt: fourDaysAgo, consent: { sms: true, email: false, marketing: false } }),
    ];
    const out = await runSweep();

    expect(out.autoSent).toBe(0);
    expect(out.skipped).toBe(1);
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });
});

describe("coordinator sweep — pause on reply", () => {
  it("stops the cadence once an inbound touch exists", async () => {
    touchesByOpp["site-cc:p1:pl1"] = [
      sentTouch("site-cc:p1:pl1", "sms"),
      {
        id: "t-in",
        opportunityId: "site-cc:p1:pl1",
        siteId: "site-cc",
        channel: "sms",
        direction: "inbound",
        body: "yes please call me",
        draftedBy: "human",
        status: "sent",
        approvedBy: null,
        createdAt: "2026-06-21T00:00:00Z",
        sentAt: "2026-06-21T00:00:00Z",
      },
    ];
    opportunities = [opp({ lastTouchAt: new Date(Date.now() - 10 * 86_400_000).toISOString() })];
    const out = await runSweep();

    expect(out.autoSent).toBe(0);
    expect(out.skipped).toBe(1);
    expect(draftOutreach).not.toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });
});

describe("coordinator sweep — human-in-the-loop for high value", () => {
  it("drafts for approval (no queue) when outstanding >= auto-send threshold", async () => {
    // Outstanding 5000 >> 250 threshold: must draft for a human, never auto-queue.
    opportunities = [opp({ amountOutstanding: 5000 })];
    const out = await runSweep();

    expect(out.awaitingApproval).toBe(1);
    expect(out.autoSent).toBe(0);
    expect(enqueueOutbox).not.toHaveBeenCalled();
    expect(setLastTouchAt).not.toHaveBeenCalled(); // not stamped until actually sent
    // The drafted touch sits at 'draft' for review.
    const drafted = touchesByOpp["site-cc:p1:pl1"][0];
    expect(drafted.status).toBe("draft");
  });

  it("a high-value draft awaiting approval is not re-drafted on the next sweep", async () => {
    opportunities = [opp({ amountOutstanding: 5000 })];
    await runSweep();
    expect(insertTouch).toHaveBeenCalledTimes(1);

    insertTouch.mockClear();
    // Same opportunity, touch still at 'draft' (pending): re-sweep must skip.
    const out2 = await runSweep();
    expect(insertTouch).not.toHaveBeenCalled();
    expect(out2.skipped).toBe(1);
  });
});
