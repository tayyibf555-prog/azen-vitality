// ===========================================================================
// HANDOFF H57 — THE OUTREACH AUDIENCE IS A SNAPSHOT, AND NOTHING RE-CONSULTED
// THE EXCLUSION LIST.
//
// WHAT WAS WRONG. src/lib/outreach/build.ts checks loadExcludedPatientIds once,
// as it enrols a patient into outreach_target, and sweepCampaign never looked
// again: it re-read target status, pending touches, consent, the daily cap and
// the A/B variant, and nothing else. So a patient a receptionist marked
// `inactive` AFTER the audience was built kept receiving the rest of the
// cadence — and `inactive` has no second net downstream, because
// applyStatusChange writes message_suppression rows for `do_not_contact` only,
// so the drain had nothing to stop on.
//
// WHAT THIS FILE PINS, driving the REAL route with only its boundaries faked:
//   1. an overridden target is skipped BEFORE any draft, touch, enqueue or
//      cadence advance, while a normal target in the same campaign is sent to;
//   2. it is left DUE, not settled — clearing the override lets the cadence
//      resume (advanceTarget is never called for it);
//   3. the exclusion set is read ONCE per tick, not once per campaign;
//   4. ruling W1-B/2's fail direction: LIVE + an unreadable override table
//      skips the whole send pass (`skipped: "exclusions unavailable"`) and
//      drafts nobody, while the ungated build pass still reports.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OutreachCampaign, OutreachTarget } from "@/lib/outreach/types";

const h = vi.hoisted(() => ({
  excludedKeys: new Set<string>(),
  refuse: false,
  drafts: 0,
  inserted: [] as string[],
  enqueued: [] as string[],
  advanced: [] as string[],
}));

class FakeExclusionsUnavailable extends Error {}

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: vi.fn(async () => true),
  isSystemEnabledForSend: vi.fn(async () => true),
}));
// The exclusion read is the boundary under test: `refuse` stands in for "the
// override table could not be read while messaging is live", which is what
// loadExcludedTargetKeys really throws (ruling W1-B/2).
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: vi.fn(async () => {
    if (h.refuse) throw new FakeExclusionsUnavailable("unreadable");
    return h.excludedKeys;
  }),
  isExclusionsUnavailable: (err: unknown) => err instanceof FakeExclusionsUnavailable,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}::${patientId}`,
}));
vi.mock("@/lib/outreach/draft", () => ({
  draftOutreach: vi.fn(async () => {
    h.drafts += 1;
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
    insertTouch: vi.fn(async (i: { targetId: string }) => {
      h.inserted.push(i.targetId);
      return { id: `touch-${n++}`, ...i };
    }),
    approveTouch: vi.fn(async (id: string) => ({ id, status: "approved" })),
    enqueueOutbox: vi.fn(async (o: { toRef: string }) => {
      h.enqueued.push(o.toRef);
      return {};
    }),
    advanceTarget: vi.fn(async (id: string) => {
      h.advanced.push(id);
    }),
    setTargetStatus: vi.fn(async () => {}),
    countContactedToday: vi.fn(async () => 0),
  };
});

import { POST } from "./route";
import {
  listRunningCampaigns,
  listDueTargets,
  getTarget,
  countContactedToday,
} from "@/lib/outreach/repository";
import { loadExcludedTargetKeys } from "@/lib/patient-status/repository";

const SITE = "site-cc";

function campaign(id: string): OutreachCampaign {
  return {
    id,
    clientId: "vitality",
    siteId: SITE,
    name: "Saturday hygiene",
    status: "running",
    filters: {},
    practitionerId: null,
    practitionerName: "Dr Patel",
    messageAngle: "hygiene clean",
    messageAngleB: null,
    dailyCap: 500,
    buildCursor: null,
    counts: null,
    createdBy: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function target(campaignId: string, patientId: string): OutreachTarget {
  return {
    id: `${campaignId}-t-${patientId}`,
    campaignId,
    patientId,
    name: `Patient ${patientId}`,
    phone: "07700900000",
    siteId: SITE,
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

/** One running campaign per id, each holding the given patient ids as due targets. */
function seed(campaignIds: string[], patientIds: string[]): void {
  const list = campaignIds.map(campaign);
  const byCampaign = new Map(list.map((c) => [c.id, patientIds.map((p) => target(c.id, p))]));
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
  h.excludedKeys = new Set([`${SITE}::pat-excl`]);
  h.refuse = false;
  h.drafts = 0;
  h.inserted = [];
  h.enqueued = [];
  h.advanced = [];
});

describe("the outreach sweep re-checks the exclusion list on every step", () => {
  it("skips a patient marked inactive AFTER the audience was built, and sends to the rest", async () => {
    seed(["camp-1"], ["pat-excl", "pat-ok"]);

    const body = await sweep();

    // Nothing is drafted, queued or advanced for the overridden patient.
    expect(h.drafts, "a draft was spent on an excluded patient").toBe(1);
    expect(h.inserted).not.toContain("camp-1-t-pat-excl");
    expect(h.enqueued, "a marketing SMS was queued for an excluded patient").not.toContain("patient:pat-excl");
    // The normal patient is untouched by the guard.
    expect(h.inserted).toContain("camp-1-t-pat-ok");
    expect(h.enqueued).toContain("patient:pat-ok");
    expect(body.suppressed).toBe(1);
    expect(body.queued).toBe(1);
  });

  it("leaves the excluded target DUE, so lifting the override resumes the cadence", async () => {
    seed(["camp-1"], ["pat-excl", "pat-ok"]);

    await sweep();

    // Only the sent patient's cadence moved: nothing settled the excluded row
    // 'excluded'/'exhausted' or consumed its step.
    expect(h.advanced, "the excluded target was settled instead of left due").toEqual(["camp-1-t-pat-ok"]);

    // Clearing the override: the same target is now drafted and queued.
    h.excludedKeys = new Set();
    h.inserted = [];
    h.enqueued = [];
    seed(["camp-1"], ["pat-excl"]);
    const body = await sweep();
    expect(h.enqueued).toContain("patient:pat-excl");
    expect(body.suppressed).toBe(0);
  });

  it("with no overrides at all, every target is processed", async () => {
    h.excludedKeys = new Set();
    seed(["camp-1"], ["pat-excl", "pat-ok"]);

    const body = await sweep();

    expect(h.enqueued).toEqual(["patient:pat-excl", "patient:pat-ok"]);
    expect(body.suppressed).toBe(0);
  });

  it("reads the exclusion set ONCE per tick, not once per campaign", async () => {
    seed(["camp-1", "camp-2", "camp-3"], ["pat-excl", "pat-ok"]);

    const body = await sweep();

    expect(vi.mocked(loadExcludedTargetKeys)).toHaveBeenCalledTimes(1);
    // The same override holds across all three campaigns.
    expect(body.suppressed).toBe(3);
    expect(body.queued).toBe(3);
  });

  it("LIVE + an unreadable override table: the send pass refuses, and says so", async () => {
    // Ruling W1-B/2's fail direction. A skipped tick is a delay; a batch drafted
    // against an unknown exclusion list is an incident.
    seed(["camp-1"], ["pat-excl", "pat-ok"]);
    h.refuse = true;

    const body = await sweep();

    expect(body.skipped, JSON.stringify(body)).toBe("exclusions unavailable");
    expect(h.drafts, "a patient marked inactive could have been drafted").toBe(0);
    expect(h.enqueued).toEqual([]);
    expect(h.advanced).toEqual([]);
    // The build pass is ungated and still ran, so the refusal is a send-side one.
    expect(body.build).toBeDefined();
  });
});
