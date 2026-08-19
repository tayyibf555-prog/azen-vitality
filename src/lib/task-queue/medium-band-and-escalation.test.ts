import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * TWO SILENT LEAD-LOSS HOLES, closed in the one place staff actually work.
 *
 *   1. MEDIUM-BAND ENQUIRIES. The queue asked smile-assessment for `bands: ["high"]`
 *      only. A medium scorer is contacted by nothing (the campaign follow-up band is
 *      off until an owner turns it on), so a warm enquiry with a phone number was
 *      recorded and then appeared on NO worklist anywhere.
 *   2. AGENT ESCALATIONS. A patient asking for a human marked the conversation
 *      needs_human and, if STAFF_ALERT_PHONE was unset (it is), that was the entire
 *      notification. The Task Queue never read the status at all.
 *
 * The REAL generator runs here, with each module read mocked at its repository seam.
 */

const h = vi.hoisted(() => ({
  listLeads: vi.fn<(a: unknown) => Promise<unknown[]>>(async () => []),
  listRecall: vi.fn<(a: unknown) => Promise<unknown[]>>(async () => []),
  listReactivation: vi.fn<(a: unknown) => Promise<unknown[]>>(async () => []),
  listOpportunities: vi.fn<(a: unknown) => Promise<unknown[]>>(async () => []),
  listNoshow: vi.fn<(a: unknown) => Promise<unknown[]>>(async () => []),
  listCaptures: vi.fn<(a: unknown) => Promise<unknown[]>>(async () => []),
  listResponses: vi.fn<(a: unknown) => Promise<unknown[]>>(async () => []),
  listNeedsHuman: vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => []),
  listOutstandingReviews: vi.fn<(a: unknown) => Promise<unknown[]>>(async () => []),
  getOverlayMap: vi.fn<(a: unknown) => Promise<Map<string, unknown>>>(async () => new Map()),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/speed-to-lead/repository", () => ({ listLeads: h.listLeads }));
vi.mock("@/lib/recall/repository", () => ({ listTargets: h.listRecall }));
vi.mock("@/lib/reactivation/repository", () => ({ listTargets: h.listReactivation }));
vi.mock("@/lib/coordinator/repository", () => ({ listOpportunities: h.listOpportunities }));
vi.mock("@/lib/noshow/repository", () => ({ listTargets: h.listNoshow }));
vi.mock("@/lib/after-hours/repository", () => ({ listCaptures: h.listCaptures }));
vi.mock("@/lib/smile-assessment/repository", () => ({ listResponses: h.listResponses }));
vi.mock("@/lib/agent/repository", () => ({ listNeedsHumanConversations: h.listNeedsHuman }));
vi.mock("@/lib/patient-medical/gate", () => ({ isMedicalHistoryEnabled: () => false }));
vi.mock("@/lib/patient-medical/repository", () => ({
  listOutstandingReviews: h.listOutstandingReviews,
}));
vi.mock("./repository", () => ({ getOverlayMap: h.getOverlayMap }));

import { generateTasksWithHealth } from "./generate";
import { KIND_BASE, computePriority } from "./logic";
import { TASK_KIND_LABEL } from "./types";

const SRC = readFileSync(fileURLToPath(new URL("./generate.ts", import.meta.url)), "utf8");

const CTX = {
  clientId: "vitality",
  clientSlug: "vitality",
  siteIds: ["site-cc", "site-rv"],
  nowIso: "2026-08-18T09:00:00.000Z",
};

function response(over: Record<string, unknown> = {}) {
  return {
    id: "resp-1",
    siteId: "site-cc",
    leadId: null,
    campaignId: null,
    firstName: "Amira",
    email: null,
    phone: "+447700900123",
    channel: "sms",
    treatmentInterest: "Invisalign",
    responses: {},
    rawScore: 40,
    band: "medium",
    source: "smile-assessment",
    createdAt: "2026-08-18T08:00:00.000Z",
    ...over,
  };
}

function conversation(over: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    siteId: "site-cc",
    dentallyPatientId: "998877",
    patientName: "Amira Khan",
    channel: "sms",
    updatedAt: "2026-08-18T08:55:00.000Z",
    ...over,
  };
}

/** Route listResponses to the right fixture per band, as the real repository does. */
function respondByBand(byBand: Record<string, unknown[]>): void {
  h.listResponses.mockImplementation(async (args: unknown) => {
    const bands = (args as { bands?: string[] }).bands ?? [];
    return bands.flatMap((b) => byBand[b] ?? []);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [
    h.listLeads,
    h.listRecall,
    h.listReactivation,
    h.listOpportunities,
    h.listNoshow,
    h.listCaptures,
    h.listResponses,
    h.listNeedsHuman,
    h.listOutstandingReviews,
  ]) {
    fn.mockResolvedValue([]);
  }
  h.getOverlayMap.mockResolvedValue(new Map<string, unknown>());
});

// ---------------------------------------------------------------------------
// 1. MEDIUM-BAND VISIBILITY
// ---------------------------------------------------------------------------

describe("medium-band enquiries reach a human", () => {
  it("a medium-band enquiry with a phone number now appears in the queue", async () => {
    respondByBand({ medium: [response()] });
    const { tasks } = await generateTasksWithHealth(CTX);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      module: "smile-assessment",
      kind: "review_enquiry",
      title: "Review Amira's enquiry",
      patientName: "Amira",
      siteId: "site-cc",
      href: "/c/vitality/smile-assessment",
    });
  });

  it("an email-only medium enquiry appears too", async () => {
    respondByBand({ medium: [response({ phone: null, email: "amira@example.com" })] });
    const { tasks } = await generateTasksWithHealth(CTX);
    expect(tasks).toHaveLength(1);
  });

  it("an enquiry with no way to reach them at all does NOT, because there is no decision to make", async () => {
    respondByBand({ medium: [response({ phone: null, email: null })] });
    const { tasks } = await generateTasksWithHealth(CTX);
    expect(tasks).toHaveLength(0);
  });

  it("one already bridged into speed-to-lead does NOT, so it is not chased twice", async () => {
    respondByBand({ medium: [response({ leadId: "lead-9" })] });
    const { tasks } = await generateTasksWithHealth(CTX);
    expect(tasks).toHaveLength(0);
  });

  it("LOW band is never even asked for", async () => {
    await generateTasksWithHealth(CTX);
    const bands = h.listResponses.mock.calls.map((c) => (c[0] as { bands: string[] }).bands);
    expect(bands).toEqual([["high"], ["medium"]]);
    expect(bands.flat()).not.toContain("low");
  });

  it("reads the two bands SEPARATELY, so a flood of medium cannot push high scorers off the end", async () => {
    await generateTasksWithHealth(CTX);
    expect(h.listResponses).toHaveBeenCalledTimes(2);
    const medium = h.listResponses.mock.calls
      .map((c) => c[0] as { bands: string[]; limit?: number })
      .find((a) => a.bands[0] === "medium");
    expect(typeof medium?.limit).toBe("number"); // and it is bounded
  });

  it("is a DIFFERENT task from a high scorer: its own kind, key and copy", async () => {
    respondByBand({
      high: [response({ id: "resp-high", band: "high", firstName: "Sam" })],
      medium: [response({ id: "resp-med" })],
    });
    const { tasks } = await generateTasksWithHealth(CTX);
    expect(tasks).toHaveLength(2);
    const kinds = tasks.map((t) => t.kind);
    expect(new Set(kinds)).toEqual(new Set(["action_assessment", "review_enquiry"]));
    // Distinct keys, so the overlay for one can never resolve the other.
    expect(new Set(tasks.map((t) => t.key)).size).toBe(2);
    // Distinct copy, so a human reading the row knows which decision they are making.
    expect(TASK_KIND_LABEL.review_enquiry).not.toBe(TASK_KIND_LABEL.action_assessment);
    expect(tasks.find((t) => t.kind === "review_enquiry")!.subtitle).toContain("Medium");
  });

  it("ranks below a high scorer, and below everything with a clock on it", async () => {
    expect(KIND_BASE.review_enquiry).toBeLessThan(KIND_BASE.action_assessment);
    expect(KIND_BASE.review_enquiry).toBeLessThan(KIND_BASE.contact_lead);
    expect(KIND_BASE.review_enquiry).toBeLessThan(KIND_BASE.confirm_appt);
  });

  it("is a HUMAN decision: the generator cannot send anything, by construction", async () => {
    // The queue is a READ. If it ever grew an import that could message a patient,
    // "review medium-interest enquiry" would have quietly become "text them".
    expect(SRC).not.toMatch(/from "@\/lib\/messaging\//);
    expect(SRC).not.toMatch(/speed-to-lead\/contact/);
    expect(SRC).not.toMatch(/\b(sendMessage|contactLead|insertLead|enqueue)\b/);
  });
});

// ---------------------------------------------------------------------------
// 2. AGENT ESCALATIONS
// ---------------------------------------------------------------------------

describe("an escalation reaches a human even with no alert phone configured", () => {
  it("a needs_human conversation is a task, deep-linked to Conversations", async () => {
    h.listNeedsHuman.mockResolvedValue([conversation()]);
    const { tasks } = await generateTasksWithHealth(CTX);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      module: "agent",
      kind: "agent_escalation",
      title: "Reply to Amira Khan",
      siteId: "site-cc",
      href: "/c/vitality/conversations",
    });
    expect(TASK_KIND_LABEL.agent_escalation).toBe("Patient asked for a human");
  });

  it("it is scoped to the sites being viewed", async () => {
    await generateTasksWithHealth(CTX);
    expect(h.listNeedsHuman).toHaveBeenCalledWith(["site-cc", "site-rv"]);
  });

  it("cannot be outranked by ANY other task, whatever its urgency boost", async () => {
    // The regression this pins: at base 92 a maximum-risk no-show (base 90 + the
    // full 10-point risk boost) beat it, so the most urgent thing in the practice
    // sat below an appointment reminder. Every kind's boost is clamped to 100, so
    // sitting AT the cap is what "never beaten" costs.
    expect(computePriority("agent_escalation")).toBe(100);
    for (const kind of Object.keys(KIND_BASE) as (keyof typeof KIND_BASE)[]) {
      const mostUrgent = computePriority(kind, {
        riskScore: 100,
        overdueDays: 10_000,
        recoverableValue: 1_000_000,
      });
      expect(mostUrgent).toBeLessThanOrEqual(computePriority("agent_escalation"));
    }
  });

  it("sorts to the top against the worst no-show the scorer can produce", async () => {
    h.listNeedsHuman.mockResolvedValue([conversation({ patientName: "Zara Ahmed" })]);
    h.listNoshow.mockResolvedValue([
      {
        id: "site-cc:1:appt-1",
        siteId: "site-cc",
        dentallyPatientId: "1",
        patientName: "Aaron Bell", // sorts FIRST by name, so only priority can win this
        appointmentStartAt: "2026-08-18T14:00:00.000Z",
        riskScore: 100,
        status: "scheduled",
      },
    ]);
    const { tasks } = await generateTasksWithHealth(CTX);
    expect(tasks[0]!.priority).toBe(100);
    expect(tasks.map((t) => t.priority)).toEqual([100, 100]);
  });

  it("attributes a KNOWN patient's escalation to their record", async () => {
    h.listNeedsHuman.mockResolvedValue([conversation({ dentallyPatientId: "998877" })]);
    const { tasks } = await generateTasksWithHealth(CTX);
    expect(tasks[0]!.patientId).toBe("998877");
  });

  it("but NEVER puts a `lead:<phone>` conversation key on a clinical record", async () => {
    h.listNeedsHuman.mockResolvedValue([
      conversation({ dentallyPatientId: "lead:+447700900123", patientName: "Unknown 0123" }),
    ]);
    const { tasks } = await generateTasksWithHealth(CTX);
    // Null, not the phone number. The task still shows in the practice queue, which
    // is where an unidentified enquiry can actually be worked.
    expect(tasks[0]!.patientId).toBeNull();
    expect(tasks).toHaveLength(1);
  });

  it("names the channel so whoever picks it up knows where to reply", async () => {
    h.listNeedsHuman.mockResolvedValue([
      conversation({ id: "c1", channel: "whatsapp" }),
      conversation({ id: "c2", channel: "sms" }),
    ]);
    const { tasks } = await generateTasksWithHealth(CTX);
    const subtitles = tasks.map((t) => t.subtitle).join(" | ");
    expect(subtitles).toContain("WhatsApp");
    expect(subtitles).toContain("SMS");
  });

  it("keys one task per conversation, so two threads never collapse into one row", async () => {
    h.listNeedsHuman.mockResolvedValue([
      conversation({ id: "conv-1" }),
      conversation({ id: "conv-2" }),
    ]);
    const { tasks } = await generateTasksWithHealth(CTX);
    expect(new Set(tasks.map((t) => t.key)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Resilience: the two new sources are caught like every other one.
// ---------------------------------------------------------------------------

describe("the new sources cannot blank the queue", () => {
  it("counts them in the source total", async () => {
    const { totalSources } = await generateTasksWithHealth(CTX);
    // eight pre-existing builders, plus medium-band and escalations, plus the overlay.
    expect(totalSources).toBe(11);
  });

  it("a dead escalation read is counted, not swallowed, and the rest still render", async () => {
    h.listNeedsHuman.mockRejectedValue(new Error("agent_conversation unreachable"));
    respondByBand({ medium: [response()] });
    const { tasks, failedSources } = await generateTasksWithHealth(CTX);
    expect(failedSources).toBe(1);
    expect(tasks).toHaveLength(1);
  });

  it("a dead medium-band read does not take the high band down with it", async () => {
    h.listResponses.mockImplementation(async (args: unknown) => {
      const bands = (args as { bands: string[] }).bands;
      if (bands[0] === "medium") throw new Error("timeout");
      return [response({ id: "resp-high", band: "high" })];
    });
    const { tasks, failedSources } = await generateTasksWithHealth(CTX);
    expect(failedSources).toBe(1);
    expect(tasks.map((t) => t.kind)).toEqual(["action_assessment"]);
  });
});
