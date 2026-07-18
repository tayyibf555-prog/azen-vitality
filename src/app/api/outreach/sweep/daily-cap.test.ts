// The per-campaign daily contact cap and the kill switch. The outreach sweep must
// stop QUEUEING once the campaign's daily_cap is used, without drafting (a capped
// draft would freeze the target at the hasPending guard) and without advancing the
// target (so tomorrow continues where today stopped). With the outreach system
// switched OFF the sweep does nothing at all. Mirrors the recall sweep daily-cap test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OutreachCampaign, OutreachTarget } from "@/lib/outreach/types";

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabledForSend: vi.fn(async () => true) }));
vi.mock("@/lib/outreach/draft", () => ({
  draftOutreach: vi.fn(async () => ({ body: "Come back and see us", usedFallback: false })),
}));
vi.mock("@/lib/outreach/repository", () => {
  let n = 0;
  return {
    listRunningCampaigns: vi.fn(async () => []),
    // The sweep's build-continuation pass lists building campaigns; none here, so it is a
    // no-op and the send-path behaviour under test is unchanged.
    listBuildingCampaigns: vi.fn(async () => []),
    listDueTargets: vi.fn(async () => []),
    getTarget: vi.fn(async () => null),
    listTouches: vi.fn(async () => []),
    insertTouch: vi.fn(async (i: Record<string, unknown>) => ({ id: `touch-${n++}`, ...i })),
    approveTouch: vi.fn(async (id: string) => ({ id, status: "approved" })),
    enqueueOutbox: vi.fn(async () => ({})),
    advanceTarget: vi.fn(async () => {}),
    setTargetStatus: vi.fn(async () => {}),
    countContactedToday: vi.fn(async () => 0),
  };
});

import { POST } from "./route";
import {
  listRunningCampaigns,
  listDueTargets,
  getTarget,
  insertTouch,
  enqueueOutbox,
  advanceTarget,
  countContactedToday,
} from "@/lib/outreach/repository";
import { isSystemEnabledForSend } from "@/lib/systems/repository";

const CAMPAIGN_ID = "camp-1";

function campaign(dailyCap: number): OutreachCampaign {
  return {
    id: CAMPAIGN_ID,
    clientId: "vitality",
    siteId: "site-cc",
    name: "Saturday hygiene",
    status: "running",
    filters: {},
    practitionerId: null,
    practitionerName: "Dr Patel",
    messageAngle: "hygiene clean",
    dailyCap,
    buildCursor: null,
    counts: null,
    createdBy: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function target(i: number): OutreachTarget {
  return {
    id: `t-${i}`,
    campaignId: CAMPAIGN_ID,
    patientId: String(i),
    name: `Patient ${i}`,
    phone: "07700900000",
    siteId: "site-cc",
    matchedReason: "Scale & Polish 14 Mar 2025",
    status: "pending",
    consent: { sms: true, email: true, marketing: false },
    currentStep: 0,
    nextDueAt: new Date(Date.now() - 86_400_000).toISOString(), // due yesterday
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function arrange(dueCount: number, dailyCap: number, used: number) {
  const targets = Array.from({ length: dueCount }, (_, i) => target(i + 1));
  const byId = new Map(targets.map((t) => [t.id, t]));
  vi.mocked(listRunningCampaigns).mockResolvedValue([campaign(dailyCap)]);
  vi.mocked(listDueTargets).mockResolvedValue(targets);
  vi.mocked(getTarget).mockImplementation(async (id: string) => byId.get(id) ?? null);
  vi.mocked(countContactedToday).mockResolvedValue(used);
}

async function sweep() {
  const res = await POST(new Request("http://test/api/outreach/sweep", { method: "POST" }));
  return (await res.json()) as {
    ok: boolean;
    skipped?: string;
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
  vi.mocked(isSystemEnabledForSend).mockResolvedValue(true);
});

describe("outreach sweep daily contact cap", () => {
  it("queues freely under the cap", async () => {
    arrange(3, 25, 0);
    const out = await sweep();
    expect(out.queued).toBe(3);
    expect(out.capped).toBe(0);
    expect(out.dailyLimit).toBe(25);
    expect(vi.mocked(enqueueOutbox)).toHaveBeenCalledTimes(3);
  });

  it("stops queueing at the cap and leaves capped targets untouched", async () => {
    arrange(4, 2, 0);
    const out = await sweep();
    expect(out.queued).toBe(2);
    expect(out.capped).toBe(2);
    // No draft/touch for the capped two (a draft would freeze their cadence).
    expect(vi.mocked(insertTouch)).toHaveBeenCalledTimes(2);
    // Only the two queued targets advanced; the capped two stay due for tomorrow.
    expect(vi.mocked(advanceTarget)).toHaveBeenCalledTimes(2);
  });

  it("processes only the remaining budget when some was already spent today", async () => {
    arrange(4, 5, 3); // 3 already queued today -> only 2 of the 4 may go
    const out = await sweep();
    expect(out.queued).toBe(2);
    expect(out.capped).toBe(2);
    expect(vi.mocked(insertTouch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(enqueueOutbox)).toHaveBeenCalledTimes(2);
  });

  it("counts messages already queued earlier today", async () => {
    arrange(3, 5, 5); // budget already spent
    const out = await sweep();
    expect(out.queued).toBe(0);
    expect(out.capped).toBe(3);
    expect(vi.mocked(insertTouch)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueOutbox)).not.toHaveBeenCalled();
  });

  it("daily_cap 0 pauses ALL sending for the campaign", async () => {
    arrange(3, 0, 0);
    const out = await sweep();
    expect(out.queued).toBe(0);
    expect(out.capped).toBe(3);
    expect(out.dailyLimit).toBe(0);
    expect(vi.mocked(enqueueOutbox)).not.toHaveBeenCalled();
  });
});

describe("outreach sweep send-safety ordering (finding #3: keep advance-before-enqueue)", () => {
  it("advances the cadence BEFORE enqueuing the outbox row, mirroring recall/reactivation", async () => {
    // Deliberate ordering, NOT a bug: the target is advanced past this step BEFORE the
    // outbox row is enqueued, so a crash between the two SKIPS a message rather than
    // re-sending it (a skipped message beats a double-send). Both sibling sweeps order it
    // the same way for the same reason (recall route.ts ~L185-207, reactivation route.ts
    // ~L162-183, each with an explicit comment). Reversing it to enqueue-then-advance
    // would make outreach the ONLY module that can double-send a patient-facing marketing
    // SMS. This test locks the ordering so it is not silently inverted.
    arrange(1, 25, 0);
    await sweep();
    expect(vi.mocked(advanceTarget)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueOutbox)).toHaveBeenCalledTimes(1);
    const advanceOrder = vi.mocked(advanceTarget).mock.invocationCallOrder[0];
    const enqueueOrder = vi.mocked(enqueueOutbox).mock.invocationCallOrder[0];
    expect(advanceOrder).toBeLessThan(enqueueOrder);
  });
});

describe("outreach sweep kill switch", () => {
  it("does nothing when the outreach system is switched OFF", async () => {
    vi.mocked(isSystemEnabledForSend).mockResolvedValue(false);
    arrange(3, 25, 0);
    const out = await sweep();
    expect(out.skipped).toBe("system off");
    // Never even looked at campaigns or queued anything.
    expect(vi.mocked(listRunningCampaigns)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueOutbox)).not.toHaveBeenCalled();
  });

  it("checks the kill switch against the outreach slug", async () => {
    arrange(1, 25, 0);
    await sweep();
    expect(vi.mocked(isSystemEnabledForSend)).toHaveBeenCalledWith("vitality", "outreach");
  });
});
