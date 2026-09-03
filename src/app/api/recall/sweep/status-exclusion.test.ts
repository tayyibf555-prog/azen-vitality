// Lifecycle exclusion: the recall sweep must skip a target whose patient carries a
// platform admin override (inactive / do_not_contact) BEFORE drafting or queueing, while
// a normal target is processed as usual. Proves the sweep consults the override set.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  excludedKeys: new Set<string>(),
  inserted: [] as string[],
  enqueued: [] as string[],
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: vi.fn(async () => true) ,
  // Ruling W1-B/1: the sweep now reads isSystemEnabledForSend (fail-closed once
  // messaging is live), and liveSwitch re-reads it every ten rows. Same verdict as
  // isSystemEnabled above, so these cases keep meaning exactly what they meant.
  isSystemEnabledForSend: vi.fn(async () => true)}));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: vi.fn(async () => h.excludedKeys),
  // Ruling W1-B/2: loadExcludedTargetKeys REFUSES when the override table is
  // unreadable and messaging is live. This fake never refuses, so the guard reads
  // false; the refusal itself is proved in src/lib/agent-wiring/scenarios.test.ts.
  isExclusionsUnavailable: () => false,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}::${patientId}`,
}));
vi.mock("@/lib/recall/draft", () => ({ draftRecall: vi.fn(async () => ({ body: "Hello from Vitality" })) }));
vi.mock("@/lib/recall/cadence", () => ({
  RECALL_CADENCE: [{ step: 1, channel: "sms" }],
  stepDef: (n: number) => (n === 1 ? { step: 1, channel: "sms" } : null),
  advanceAfter: () => ({ currentStep: 1, status: "active", nextDueAt: null, endedAt: null }),
}));
vi.mock("@/lib/recall/normalise", () => ({ shouldGraduate: () => false }));
vi.mock("@/lib/time/london", () => ({ londonOverdueDays: () => 0 }));
vi.mock("@/lib/recall/repository", () => ({
  listDueCadences: vi.fn(async () => [
    { id: "cad-excl", targetId: "t-excl", currentStep: 0 },
    { id: "cad-ok", targetId: "t-ok", currentStep: 0 },
  ]),
  getTarget: vi.fn(async (id: string) =>
    id === "t-excl"
      ? { id: "t-excl", dentallyPatientId: "pat-excl", siteId: "site-cc", consent: { sms: true, email: true, marketing: false }, dueAt: "2026-01-01T00:00:00Z" }
      : { id: "t-ok", dentallyPatientId: "pat-ok", siteId: "site-cc", consent: { sms: true, email: true, marketing: false }, dueAt: "2026-01-01T00:00:00Z" },
  ),
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
  incrementPriorAttempts: vi.fn(async () => {}),
  updateCadence: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
  markGraduated: vi.fn(async () => {}),
}));

import { POST } from "./route";
import { insertTouch, enqueueOutbox } from "@/lib/recall/repository";

beforeEach(() => {
  vi.clearAllMocks();
  h.excludedKeys = new Set(["site-cc::pat-excl"]);
  h.inserted = [];
  h.enqueued = [];
});

describe("recall sweep override exclusion", () => {
  it("skips the overridden target (no draft, no queue) but processes the normal one", async () => {
    const res = await POST(new Request("http://localhost/api/recall/sweep", { method: "POST" }));
    const body = await res.json();

    // The excluded patient is never drafted or queued.
    expect(h.inserted).not.toContain("t-excl");
    expect(h.enqueued).not.toContain("patient:pat-excl");
    // The normal patient is drafted and queued.
    expect(h.inserted).toContain("t-ok");
    expect(h.enqueued).toContain("patient:pat-ok");
    // And it is counted as suppressed by admin status.
    expect(body.suppressed).toBe(1);
    expect(body.queued).toBe(1);
  });

  it("with no overrides, BOTH targets are processed", async () => {
    h.excludedKeys = new Set();
    const res = await POST(new Request("http://localhost/api/recall/sweep", { method: "POST" }));
    const body = await res.json();
    expect(insertTouch).toHaveBeenCalledTimes(2);
    expect(enqueueOutbox).toHaveBeenCalledTimes(2);
    expect(body.suppressed).toBe(0);
  });
});
