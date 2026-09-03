// The daily automated-contact cap: the recall sweep must stop QUEUEING once
// today's budget is used, without drafting (a capped draft would freeze the
// cadence at the hasPending guard), without advancing the cadence (so tomorrow
// continues where today stopped). The limit comes from RECALL_DAILY_CONTACT_LIMIT
// (default 25); an invalid value reverts to the default LOUDLY, and 0 pauses all
// automated outreach. Mirrors the reactivation sweep's daily-cap test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RecallTarget } from "@/lib/recall/types";

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: vi.fn(async () => true) ,
  // Ruling W1-B/1: the sweep now reads isSystemEnabledForSend (fail-closed once
  // messaging is live), and liveSwitch re-reads it every ten rows. Same verdict as
  // isSystemEnabled above, so these cases keep meaning exactly what they meant.
  isSystemEnabledForSend: vi.fn(async () => true)}));
vi.mock("@/lib/recall/draft", () => ({
  draftRecall: vi.fn(async () => ({ body: "Time for your check-up", rationale: "r" })),
}));
vi.mock("@/lib/recall/repository", () => {
  let n = 0;
  return {
    listDueCadences: vi.fn(async () => []),
    getTarget: vi.fn(async () => null),
    listTouches: vi.fn(async () => []),
    incrementPriorAttempts: vi.fn(async () => {}),
    updateCadence: vi.fn(async () => {}),
    setTargetStatus: vi.fn(async () => {}),
    markGraduated: vi.fn(async () => {}),
    insertTouch: vi.fn(async (i: Record<string, unknown>) => ({ id: `touch-${n++}`, ...i })),
    approveTouch: vi.fn(async (id: string) => ({ id, status: "approved", body: "Time for your check-up" })),
    enqueueOutbox: vi.fn(async () => ({})),
    countContactedToday: vi.fn(async () => 0),
  };
});

import { POST } from "./route";
import {
  listDueCadences,
  getTarget,
  insertTouch,
  enqueueOutbox,
  updateCadence,
  countContactedToday,
} from "@/lib/recall/repository";

function cadence(i: number) {
  return {
    id: `c-${i}`,
    targetId: `site-rc:${i}`,
    siteId: "site-rc",
    status: "active" as const,
    currentStep: 0,
    nextDueAt: "2026-07-09T00:00:00.000Z",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

function target(i: number): RecallTarget {
  return {
    id: `site-rc:${i}`,
    siteId: "site-rc",
    dentallyPatientId: String(i),
    patientName: `Patient ${i}`,
    recallType: "dentist",
    // Due a few days ago: inside the recall window (step 1 is an SMS nudge).
    dueAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    overdueDays: 3,
    lastVisitAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    priorAttempts: 0,
    status: "in_cadence",
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: "2026-07-09T00:00:00.000Z",
  };
}

function arrange(dueCount: number, used: number) {
  const cadences = Array.from({ length: dueCount }, (_, i) => cadence(i + 1));
  const targets = new Map(cadences.map((c, i) => [c.targetId, target(i + 1)]));
  vi.mocked(listDueCadences).mockResolvedValue(cadences as never);
  vi.mocked(getTarget).mockImplementation(async (id: string) => (targets.get(id) ?? null) as never);
  vi.mocked(countContactedToday).mockResolvedValue(used);
}

async function sweep() {
  const res = await POST(new Request("http://test/api/recall/sweep", { method: "POST" }));
  return (await res.json()) as {
    ok: boolean;
    queued: number;
    drafted: number;
    capped: number;
    paused: number;
    dailyLimit: number;
    usedToday: number;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET; // authorized() passes outside production
  delete process.env.RECALL_DAILY_CONTACT_LIMIT; // default 25 unless a test sets it
});

describe("recall sweep daily contact limit", () => {
  it("queues freely under the limit", async () => {
    arrange(3, 0); // default limit 25, plenty of budget
    const out = await sweep();
    expect(out.queued).toBe(3);
    expect(out.capped).toBe(0);
    expect(out.dailyLimit).toBe(25);
    expect(vi.mocked(enqueueOutbox)).toHaveBeenCalledTimes(3);
  });

  it("stops queueing at the limit and leaves capped cadences untouched", async () => {
    process.env.RECALL_DAILY_CONTACT_LIMIT = "2";
    arrange(4, 0);
    const out = await sweep();
    expect(out.queued).toBe(2);
    expect(out.capped).toBe(2);
    // No draft was inserted for the capped two (a draft would freeze their cadence).
    expect(vi.mocked(insertTouch)).toHaveBeenCalledTimes(2);
    // Only the two queued cadences advanced; the capped two stay due for tomorrow.
    expect(vi.mocked(updateCadence)).toHaveBeenCalledTimes(2);
  });

  it("processes only the remaining budget when some was already spent today", async () => {
    process.env.RECALL_DAILY_CONTACT_LIMIT = "5";
    arrange(4, 3); // 3 already queued today -> only 2 of the 4 may go
    const out = await sweep();
    expect(out.queued).toBe(2);
    expect(out.capped).toBe(2);
    expect(vi.mocked(insertTouch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(enqueueOutbox)).toHaveBeenCalledTimes(2);
  });

  it("counts messages already queued earlier today", async () => {
    process.env.RECALL_DAILY_CONTACT_LIMIT = "5";
    arrange(3, 5); // budget already spent
    const out = await sweep();
    expect(out.queued).toBe(0);
    expect(out.capped).toBe(3);
    expect(vi.mocked(insertTouch)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueOutbox)).not.toHaveBeenCalled();
  });

  it("limit 0 pauses ALL automated outreach", async () => {
    process.env.RECALL_DAILY_CONTACT_LIMIT = "0";
    arrange(3, 0);
    const out = await sweep();
    expect(out.queued).toBe(0);
    expect(out.capped).toBe(3);
    expect(out.dailyLimit).toBe(0);
    expect(vi.mocked(enqueueOutbox)).not.toHaveBeenCalled();
  });

  it("an invalid env value reverts to the default 25 with a loud log", async () => {
    process.env.RECALL_DAILY_CONTACT_LIMIT = "not-a-number";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    arrange(3, 0);
    const out = await sweep();
    expect(out.dailyLimit).toBe(25);
    expect(out.queued).toBe(3); // three under the reverted default is fine
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("RECALL_DAILY_CONTACT_LIMIT"));
    spy.mockRestore();
  });
});
