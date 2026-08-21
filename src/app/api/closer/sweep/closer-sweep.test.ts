import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TreatmentOpportunity } from "@/lib/coordinator/types";

const DAY = 86_400_000;
const NOW = Date.now();

let opportunities: TreatmentOpportunity[] = [];
let excluded = new Set<string>();
let suppressedRefs = new Set<string>();
let enabled = true;
let lockAcquired = true;

const insertDraft = vi.fn(async (..._a: unknown[]) => ({ id: "t-1" }));
const stopOpportunity = vi.fn(async (..._a: unknown[]) => undefined);
const coolOff = vi.fn(async (..._a: unknown[]) => undefined);
const listStatesByOpportunity = vi.fn(async (..._a: unknown[]) => new Map());
const listInboundBodiesByOpportunity = vi.fn(async (..._a: unknown[]) => new Map());
const listOpportunities = vi.fn(async (..._a: unknown[]) => opportunities);
type DraftOutcome = { ok: true; body: string } | { ok: false; category: string; detail: string };
const draftCloserMessage = vi.fn(
  async (..._a: unknown[]): Promise<DraftOutcome> => ({ ok: true, body: "Hi Sarah." }),
);

// The closer repository mock deliberately exposes ONLY the functions a
// draft-and-stop sweep is allowed to use. approveDraft, claimOutbox and
// recordOutboxSent are omitted, so a sweep that ever grew a send path would fail
// this whole file with "is not a function" rather than quietly start messaging.
vi.mock("@/lib/closer/repository", () => ({
  insertDraft: (...a: unknown[]) => insertDraft(...a),
  stopOpportunity: (...a: unknown[]) => stopOpportunity(...a),
  coolOff: (...a: unknown[]) => coolOff(...a),
  listStatesByOpportunity: (...a: unknown[]) => listStatesByOpportunity(...a),
  listInboundBodiesByOpportunity: (...a: unknown[]) => listInboundBodiesByOpportunity(...a),
}));
vi.mock("@/lib/closer/draft", () => ({
  draftCloserMessage: (...a: unknown[]) => draftCloserMessage(...a),
}));
vi.mock("@/lib/coordinator/repository", () => ({
  listOpportunities: (...a: unknown[]) => listOpportunities(...a),
}));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: async () => excluded,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}:${patientId}`,
}));
const isSuppressed = vi.fn(async (_site: string, _channel: string, toRef: string) =>
  suppressedRefs.has(toRef),
);
vi.mock("@/lib/messaging/suppression", () => ({
  isSuppressed: (...a: unknown[]) => isSuppressed(...(a as [string, string, string])),
}));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: async () => [] }));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => enabled }));
vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
const releaseCronLock = vi.fn(async () => undefined);
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: async () => lockAcquired,
  releaseCronLock: () => releaseCronLock(),
}));

import { POST } from "./route";

function opp(over: Partial<TreatmentOpportunity> = {}): TreatmentOpportunity {
  return {
    id: "site-cc:p1:pl1",
    siteId: "site-cc",
    dentallyPatientId: "p1",
    dentallyPlanId: "pl1",
    patientName: "Sarah Lindqvist",
    treatment: "Invisalign full arch",
    plannedValue: 4200,
    amountOutstanding: 3400,
    acceptedAt: new Date(NOW - 60 * DAY).toISOString(),
    status: "accepted",
    financePresented: false,
    lastTouchAt: null,
    priorityScore: 1,
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function request(): Request {
  return new Request("http://localhost:3000/api/closer/sweep", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  opportunities = [opp()];
  excluded = new Set();
  suppressedRefs = new Set();
  enabled = true;
  lockAcquired = true;
  listStatesByOpportunity.mockResolvedValue(new Map());
  listInboundBodiesByOpportunity.mockResolvedValue(new Map());
  draftCloserMessage.mockResolvedValue({ ok: true, body: "Hi Sarah." });
  isSuppressed.mockImplementation(async (_site: string, _channel: string, toRef: string) =>
    suppressedRefs.has(toRef),
  );
  delete process.env.CLOSER_MAX_DRAFTS_PER_RUN;
  delete process.env.CLOSER_MAX_EXAMINED_PER_RUN;
});

describe("closer sweep: the switch", () => {
  it("does NOTHING at all when the system is off", async () => {
    enabled = false;
    const res = await POST(request());
    expect(await res.json()).toEqual({ ok: true, skipped: "system off" });
    // Not "drafted nothing": read nothing. A disabled system must not scan the
    // practice's opportunity list, spend a lock, or open a model client.
    expect(listOpportunities).not.toHaveBeenCalled();
    expect(listStatesByOpportunity).not.toHaveBeenCalled();
    expect(draftCloserMessage).not.toHaveBeenCalled();
    expect(insertDraft).not.toHaveBeenCalled();
    expect(releaseCronLock).not.toHaveBeenCalled();
  });

  it("checks the switch BEFORE taking the lock", async () => {
    enabled = false;
    await POST(request());
    // Releasing a lock it never took would be the tell that the order is wrong.
    expect(releaseCronLock).not.toHaveBeenCalled();
  });

  it("yields to a run already in progress", async () => {
    lockAcquired = false;
    const res = await POST(request());
    expect(await res.json()).toEqual({ ok: true, skipped: "another run in progress" });
    expect(draftCloserMessage).not.toHaveBeenCalled();
  });

  it("releases the lock after a normal run", async () => {
    await POST(request());
    expect(releaseCronLock).toHaveBeenCalledTimes(1);
  });
});

describe("closer sweep: it drafts and never queues", () => {
  it("stores a draft for a qualifying opportunity", async () => {
    const res = await POST(request());
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, drafted: 1, queued: 0 });
    expect(insertDraft).toHaveBeenCalledWith({
      opportunityId: "site-cc:p1:pl1",
      siteId: "site-cc",
      step: 1,
      channel: "sms",
      body: "Hi Sarah.",
    });
  });

  it("always reports queued: 0, because approval is the only route to the outbox", async () => {
    opportunities = [opp(), opp({ id: "site-cc:p2:pl2", dentallyPatientId: "p2" })];
    const json = await (await POST(request())).json();
    expect(json.drafted).toBe(2);
    expect(json.queued).toBe(0);
  });

  it("passes the site's own name to the drafter, not a hard-coded one", async () => {
    await POST(request());
    expect(draftCloserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "site-cc:p1:pl1" }),
      expect.objectContaining({ step: 1 }),
      expect.objectContaining({ practiceName: "N15 Vitality Dental" }),
    );
  });
});

describe("closer sweep: stops and skips", () => {
  it("records a stop with its reason and drafts nothing", async () => {
    opportunities = [opp({ status: "completed" })];
    const json = await (await POST(request())).json();
    expect(stopOpportunity).toHaveBeenCalledWith("site-cc:p1:pl1", "site-cc", "plan_completed");
    expect(insertDraft).not.toHaveBeenCalled();
    expect(json).toMatchObject({ stopped: 1, drafted: 0, stopReasons: { plan_completed: 1 } });
  });

  it("stops on a reply, from the coordinator's conversation as well as its own", async () => {
    listInboundBodiesByOpportunity.mockResolvedValue(
      new Map([["site-cc:p1:pl1", ["yes please, can I book next week"]]]),
    );
    const json = await (await POST(request())).json();
    expect(stopOpportunity).toHaveBeenCalledWith("site-cc:p1:pl1", "site-cc", "patient_replied");
    expect(json.stopReasons).toEqual({ patient_replied: 1 });
  });

  it("stops on an opt-out recorded against the patient ref", async () => {
    suppressedRefs.add("patient:p1");
    await POST(request());
    expect(stopOpportunity).toHaveBeenCalledWith("site-cc:p1:pl1", "site-cc", "opted_out");
    expect(draftCloserMessage).not.toHaveBeenCalled();
  });

  it("stops on a patient excluded by admin status, before spending a draft", async () => {
    excluded = new Set(["site-cc:p1"]);
    await POST(request());
    expect(stopOpportunity).toHaveBeenCalledWith("site-cc:p1:pl1", "site-cc", "excluded");
    expect(draftCloserMessage).not.toHaveBeenCalled();
  });

  it("skips rather than guesses when the suppression read fails", async () => {
    isSuppressed.mockRejectedValueOnce(new Error("db down"));
    const json = await (await POST(request())).json();
    // Treating an unreadable opt-out list as "not opted out" is the one direction
    // this must never fail in.
    expect(json).toMatchObject({ drafted: 0, skipped: 1 });
    expect(json.skipReasons).toEqual({ suppression_unavailable: 1 });
    expect(draftCloserMessage).not.toHaveBeenCalled();
  });

  it("skips a plan that is still inside the settling window", async () => {
    opportunities = [opp({ acceptedAt: new Date(NOW - 5 * DAY).toISOString() })];
    const json = await (await POST(request())).json();
    expect(json).toMatchObject({ drafted: 0, skipped: 1, skipReasons: { plan_too_new: 1 } });
  });
});

describe("closer sweep: refusals and bounds", () => {
  it("stores NOTHING when the drafter refuses, and cools the opportunity off", async () => {
    draftCloserMessage.mockResolvedValue({ ok: false, category: "debt", detail: "owe" });
    const json = await (await POST(request())).json();
    expect(insertDraft).not.toHaveBeenCalled();
    expect(coolOff).toHaveBeenCalledTimes(1);
    expect(json).toMatchObject({ refused: 1, drafted: 0, refusalReasons: { debt: 1 } });
  });

  it("caps drafts per run so one tick cannot flood the worklist", async () => {
    process.env.CLOSER_MAX_DRAFTS_PER_RUN = "2";
    opportunities = Array.from({ length: 10 }, (_, i) =>
      opp({ id: `site-cc:p${i}:pl${i}`, dentallyPatientId: `p${i}` }),
    );
    const json = await (await POST(request())).json();
    expect(json.drafted).toBe(2);
    expect(insertDraft).toHaveBeenCalledTimes(2);
    // And it stops EXAMINING once the cap is hit, rather than drafting two and
    // then walking the other eight for nothing.
    expect(json.examined).toBe(2);
  });

  it("caps the opportunities examined per run", async () => {
    process.env.CLOSER_MAX_EXAMINED_PER_RUN = "3";
    process.env.CLOSER_MAX_DRAFTS_PER_RUN = "100";
    opportunities = Array.from({ length: 10 }, (_, i) =>
      opp({ id: `site-cc:p${i}:pl${i}`, dentallyPatientId: `p${i}`, status: "completed" }),
    );
    const json = await (await POST(request())).json();
    expect(json.examined).toBe(3);
    expect(json.stopped).toBe(3);
  });

  it("asks the coordinator's store only for OPEN opportunities", async () => {
    await POST(request());
    expect(listOpportunities).toHaveBeenCalledWith({
      siteIds: ["site-cc", "site-rv", "site-ng"],
      statuses: ["accepted", "in_progress", "stalled"],
    });
  });
});
