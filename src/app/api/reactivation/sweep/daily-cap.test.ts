// The owner-set daily contact limit: the sweep must stop QUEUEING automated
// reactivation messages once today's budget is used, without drafting (a capped
// draft would freeze the cadence at the hasPending guard), without advancing the
// cadence (so tomorrow continues where today stopped), and without touching the
// human-approval path (high-value drafts send nothing by themselves).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactivationTarget } from "@/lib/reactivation/types";

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: vi.fn(async () => true) }));
vi.mock("@/lib/reactivation/draft", () => ({
  draftReactivation: vi.fn(async () => ({ body: "Hello from Vitality", rationale: "r" })),
}));
vi.mock("@/lib/reactivation/settings", () => ({
  getDailyContactLimit: vi.fn(async () => 25),
  countContactedToday: vi.fn(async () => 0),
}));
vi.mock("@/lib/reactivation/repository", () => {
  let n = 0;
  return {
    listDueCadences: vi.fn(async () => []),
    getTarget: vi.fn(async () => null),
    listTouches: vi.fn(async () => []),
    insertTouch: vi.fn(async (i: Record<string, unknown>) => ({ id: `touch-${n++}`, ...i })),
    approveTouch: vi.fn(async (id: string) => ({ id, status: "approved", body: "Hello from Vitality" })),
    enqueueOutbox: vi.fn(async () => ({})),
    incrementPriorAttempts: vi.fn(async () => {}),
    updateCadence: vi.fn(async () => {}),
    setTargetStatus: vi.fn(async () => {}),
  };
});

import { POST } from "./route";
import {
  listDueCadences,
  getTarget,
  insertTouch,
  enqueueOutbox,
  updateCadence,
} from "@/lib/reactivation/repository";
import { getDailyContactLimit, countContactedToday } from "@/lib/reactivation/settings";

function cadence(i: number) {
  return {
    id: `c-${i}`,
    targetId: `site-cc:${i}`,
    siteId: "site-cc",
    status: "active" as const,
    currentStep: 0,
    nextDueAt: "2026-07-09T00:00:00.000Z",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: null,
  };
}

function target(i: number, recoverableValue: number): ReactivationTarget {
  return {
    id: `site-cc:${i}`,
    siteId: "site-cc",
    dentallyPatientId: String(i),
    patientName: `Patient ${i}`,
    reason: "lapsed",
    dentallyPlanId: null,
    treatment: null,
    recoverableValue,
    lastVisitAt: "2024-06-01T00:00:00.000Z",
    recallDueAt: null,
    priorAttempts: 0,
    status: "in_cadence",
    reactivationScore: 50,
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: "2026-07-09T00:00:00.000Z",
  } as ReactivationTarget;
}

function arrange(dueCount: number, value: number, limit: number, used: number) {
  const cadences = Array.from({ length: dueCount }, (_, i) => cadence(i + 1));
  const targets = new Map(cadences.map((c, i) => [c.targetId, target(i + 1, value)]));
  vi.mocked(listDueCadences).mockResolvedValue(cadences as never);
  vi.mocked(getTarget).mockImplementation(async (id: string) => (targets.get(id) ?? null) as never);
  vi.mocked(getDailyContactLimit).mockResolvedValue(limit);
  vi.mocked(countContactedToday).mockResolvedValue(used);
}

async function sweep() {
  const res = await POST(new Request("http://test/api/reactivation/sweep", { method: "POST" }));
  return (await res.json()) as {
    ok: boolean;
    queued: number;
    drafted: number;
    capped: number;
    awaitingApproval: number;
    dailyLimit: number;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET; // authorized() passes outside production
});

describe("reactivation sweep daily contact limit", () => {
  it("queues freely under the limit", async () => {
    arrange(3, 100, 25, 0); // low value (auto path), plenty of budget
    const out = await sweep();
    expect(out.queued).toBe(3);
    expect(out.capped).toBe(0);
    expect(vi.mocked(enqueueOutbox)).toHaveBeenCalledTimes(3);
  });

  it("stops queueing at the limit and leaves capped cadences untouched", async () => {
    arrange(4, 100, 2, 0);
    const out = await sweep();
    expect(out.queued).toBe(2);
    expect(out.capped).toBe(2);
    // No draft was inserted for the capped two (a draft would freeze their cadence).
    expect(vi.mocked(insertTouch)).toHaveBeenCalledTimes(2);
    // Only the two queued cadences advanced; the capped two stay due for tomorrow.
    expect(vi.mocked(updateCadence)).toHaveBeenCalledTimes(2);
  });

  it("counts messages already queued earlier today", async () => {
    arrange(3, 100, 5, 5); // budget already spent (e.g. by manual approvals)
    const out = await sweep();
    expect(out.queued).toBe(0);
    expect(out.capped).toBe(3);
    expect(vi.mocked(insertTouch)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueOutbox)).not.toHaveBeenCalled();
  });

  it("limit 0 pauses ALL automated outreach", async () => {
    arrange(3, 100, 0, 0);
    const out = await sweep();
    expect(out.queued).toBe(0);
    expect(out.capped).toBe(3);
    expect(vi.mocked(enqueueOutbox)).not.toHaveBeenCalled();
  });

  it("high-value drafts still go to human approval when the cap is reached (they send nothing)", async () => {
    arrange(1, 900, 0, 0); // above the £250 auto-send threshold
    const out = await sweep();
    expect(out.capped).toBe(0);
    expect(out.drafted).toBe(1);
    expect(out.awaitingApproval).toBe(1);
    expect(out.queued).toBe(0);
    expect(vi.mocked(enqueueOutbox)).not.toHaveBeenCalled();
  });
});
