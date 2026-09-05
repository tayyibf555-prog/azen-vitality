import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OutreachCampaign, OutreachTarget } from "@/lib/outreach/types";

// ===========================================================================
// RULING W1-B/5 ON THE SEGMENT-OUTREACH SWEEP (the eighth sweep).
//
// WHAT WAS WRONG. This route asked `isSystemEnabledForSend("vitality",
// "outreach")` ONCE, at the top, and then looped for up to 300 seconds (a
// 310-second lease) over every running campaign and every due target inside
// each: an Anthropic draft, an auto-approved touch, an ADVANCED CADENCE and a
// queued patient-facing marketing SMS per row. An owner who switched Segment
// outreach off in System controls at 10:03, mid-tick, did not stop any of that.
// Nothing was delivered while it stayed off — the drain re-reads the switch and
// skips the source — but the rows persisted for MAX_ROW_AGE_MS (48 hours) and
// would land as a burst the moment outreach came back on, on top of the model
// spend for every draft made after the owner pressed off. And because
// `advanceTarget` runs BEFORE `enqueueOutbox`, any row retired at 48 hours
// leaves that patient silently skipping the step they never received.
//
// WHY IT WAS MISSED. `src/lib/agent-wiring/rulings.test.ts` enumerates the
// sweeps that use the shared gate by PATH, and outreach was not on the list —
// so nothing in the tree asserted anything about this file's switch handling.
// Its own daily-cap.test.ts pins only the top-of-run skip.
//
// This file drives the REAL route. Only the boundary is faked: the switch is a
// mutable toggle the "owner" flips from inside the thirteenth draft, exactly as
// flipping it in System controls mid-run would. The two halves of the ruling's
// bound are asserted — more than twelve rows (so the gate is not being read on
// every row, which is the cost side of W1-B/5) and no more than twenty (so a
// halted system stops halting within ten rows).
// ===========================================================================

const store = {
  systemEnabled: true,
  drafts: 0,
  flipOffAtDraft: 0,
  enqueued: 0,
  advanced: 0,
};

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
// The gate reads the switch through this same module, so one fake serves both
// the top-of-run check and every re-read inside the loop.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: vi.fn(async () => store.systemEnabled),
  isSystemEnabledForSend: vi.fn(async () => store.systemEnabled),
}));
// Boundary fake for the once-per-tick exclusion read (ruling W1-B/2). No overrides
// here, so every seeded target is a normal one and the ten-row bound under test is
// measured on rows the sweep would really have worked on. The exclusion behaviour
// itself is pinned in ./status-exclusion.test.ts.
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: vi.fn(async () => new Set<string>()),
  isExclusionsUnavailable: () => false,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}::${patientId}`,
}));
// The drafter stands in for the whole model call: counting it is how this file
// measures "how many rows did this run actually work on", and it is where the
// owner's switch is flipped.
vi.mock("@/lib/outreach/draft", () => ({
  draftOutreach: vi.fn(async () => {
    store.drafts += 1;
    if (store.drafts === store.flipOffAtDraft) store.systemEnabled = false;
    return { body: "Come back and see us", usedFallback: false };
  }),
}));
vi.mock("@/lib/outreach/repository", () => {
  let n = 0;
  return {
    listRunningCampaigns: vi.fn(async () => []),
    listBuildingCampaigns: vi.fn(async () => []),
    listDueTargets: vi.fn(async () => []),
    getTarget: vi.fn(async () => null),
    listTouches: vi.fn(async () => []),
    insertTouch: vi.fn(async (i: Record<string, unknown>) => ({ id: `touch-${n++}`, ...i })),
    approveTouch: vi.fn(async (id: string) => ({ id, status: "approved" })),
    enqueueOutbox: vi.fn(async () => {
      store.enqueued += 1;
      return {};
    }),
    advanceTarget: vi.fn(async () => {
      store.advanced += 1;
    }),
    setTargetStatus: vi.fn(async () => {}),
    countContactedToday: vi.fn(async () => 0),
  };
});

import { POST } from "./route";
import { SWITCH_RECHECK_EVERY_ROWS } from "@/lib/systems/live-switch";
import { listRunningCampaigns, listDueTargets, getTarget, countContactedToday } from "@/lib/outreach/repository";

const CAMPAIGN_ID = "camp-1";

function campaign(id: string, dailyCap: number): OutreachCampaign {
  return {
    id,
    clientId: "vitality",
    siteId: "site-cc",
    name: "Saturday hygiene",
    status: "running",
    filters: {},
    practitionerId: null,
    practitionerName: "Dr Patel",
    messageAngle: "hygiene clean",
    messageAngleB: null,
    dailyCap,
    buildCursor: null,
    counts: null,
    createdBy: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function target(campaignId: string, i: number): OutreachTarget {
  return {
    id: `${campaignId}-t-${i}`,
    campaignId,
    patientId: String(i),
    name: `Patient ${i}`,
    phone: "07700900000",
    siteId: "site-cc",
    matchedReason: "Scale & Polish 14 Mar 2025",
    status: "pending",
    consent: { sms: true, email: true, marketing: false },
    variant: null,
    currentStep: 0,
    nextDueAt: new Date(Date.now() - 86_400_000).toISOString(),
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: null,
    repliedAt: null,
    bookedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

/** `campaigns` running campaigns, each with `per` due targets and an ample cap. */
function seed(campaigns: number, per: number): void {
  const list = Array.from({ length: campaigns }, (_, c) => campaign(`${CAMPAIGN_ID}-${c}`, 500));
  const byCampaign = new Map(list.map((c) => [c.id, Array.from({ length: per }, (_, i) => target(c.id, i + 1))]));
  const byId = new Map([...byCampaign.values()].flat().map((t) => [t.id, t]));
  vi.mocked(listRunningCampaigns).mockResolvedValue(list);
  vi.mocked(listDueTargets).mockImplementation(async (id: string) => byCampaign.get(id) ?? []);
  vi.mocked(getTarget).mockImplementation(async (id: string) => byId.get(id) ?? null);
  vi.mocked(countContactedToday).mockResolvedValue(0);
}

async function sweep(): Promise<Record<string, unknown>> {
  const res = await POST(new Request("http://localhost/api/outreach/sweep", { method: "POST" }));
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET; // authorized() passes outside production
  store.systemEnabled = true;
  store.drafts = 0;
  store.flipOffAtDraft = 0;
  store.enqueued = 0;
  store.advanced = 0;
});

describe("the outreach sweep stops drafting when the owner flips the switch mid-run", () => {
  it("drafts past twelve rows and stops within ten of the switch-off", async () => {
    seed(1, 40);
    store.flipOffAtDraft = 13;

    const body = await sweep();

    expect(body.skipped, JSON.stringify(body)).toBeUndefined();
    expect(store.drafts, "the sweep stopped instantly, so it is re-reading on every row").toBeGreaterThan(12);
    expect(
      store.drafts,
      "the outreach sweep kept drafting past the ten-row bound after a mid-run switch-off",
    ).toBeLessThanOrEqual(12 + SWITCH_RECHECK_EVERY_ROWS);
    // What a run-past costs, asserted as well as the count: every drafted row is
    // auto-approved and queued for the shared drain, and its cadence step is
    // consumed whether or not the message is ever delivered.
    expect(store.enqueued, "patient-facing SMS were queued after the owner switched outreach off").toBeLessThanOrEqual(
      12 + SWITCH_RECHECK_EVERY_ROWS,
    );
    expect(store.advanced).toBeLessThanOrEqual(12 + SWITCH_RECHECK_EVERY_ROWS);
    expect(body.switchedOffMidRun, "the run did not say it had been halted").toBe(true);
  });

  it("the targets it never reached are left DUE, not retired on a stale verdict", async () => {
    // The gate is consulted before `getTarget`, so nothing past the stop is
    // settled 'exhausted'/'excluded' or advanced: tomorrow's tick continues from
    // exactly where this one stopped.
    seed(1, 40);
    store.flipOffAtDraft = 13;

    await sweep();

    expect(store.advanced).toBe(store.drafts);
    expect(vi.mocked(getTarget).mock.calls.length, "a target was read after the run had stopped").toBeLessThanOrEqual(
      12 + SWITCH_RECHECK_EVERY_ROWS,
    );
  });

  it("the bound is the RUN's, not each campaign's: a second campaign does not restart it", async () => {
    // Four running campaigns of fifteen targets each. A per-campaign gate would
    // let every campaign draft its own ten rows past the switch-off; the run's
    // gate stops the whole tick.
    seed(4, 15);
    store.flipOffAtDraft = 13;

    const body = await sweep();

    expect(store.drafts).toBeGreaterThan(12);
    expect(store.drafts, "each campaign got its own ten-row allowance").toBeLessThanOrEqual(
      12 + SWITCH_RECHECK_EVERY_ROWS,
    );
    expect(body.switchedOffMidRun).toBe(true);
  });

  it("an untouched switch sweeps the whole batch, so the gate is a limit and not a wall", async () => {
    seed(1, 40);
    const body = await sweep();
    expect(store.drafts).toBe(40);
    expect(store.enqueued).toBe(40);
    expect(body.switchedOffMidRun).toBe(false);
  });
});
