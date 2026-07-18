// FIX 3 (outreach reply-linkage status/recency guard): findTargetByAddress returns
// the LATEST outbox address-match with no guard on the target's state or age, so an
// unrelated later inbound could drag an already-'booked'/'exhausted' target back to
// 'replied' and mis-prime the booking agent with a stale campaign's clinician/angle.
//
// The linkage must now only regress the target + prime the agent when the matched
// target is BOTH in an active cadence state (pending/queued/contacted) AND its last
// activity is recent (<= 30 days). The inbound reply is still RECORDED (audit) either
// way, and any lookup failure must never break the webhook (best-effort try/catch).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeTwilioSignature } from "@/lib/messaging/signature";

const outreach = vi.hoisted(() => ({
  findTargetByAddress: vi.fn(),
  getCampaignIdForTarget: vi.fn(),
  insertInboundTouch: vi.fn(),
  markOutreachReplied: vi.fn(),
  getTarget: vi.fn(),
  getCampaign: vi.fn(),
}));

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));
vi.mock("@/lib/messaging/suppression", () => ({
  isStopKeyword: () => false,
  addSuppression: vi.fn(async () => {}),
  isSuppressed: vi.fn(async () => false),
}));
vi.mock("@/lib/reactivation/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  insertInboundTouch: vi.fn(async () => {}),
  getCadenceByTarget: vi.fn(async () => null),
  updateCadence: vi.fn(async () => {}),
  getTargetContext: vi.fn(async () => null),
}));
vi.mock("@/lib/recall/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  getCadenceByTarget: vi.fn(async () => null),
  updateCadence: vi.fn(async () => {}),
  insertInboundTouch: vi.fn(async () => {}),
}));
vi.mock("@/lib/outreach/repository", () => ({
  findTargetByAddress: (...a: unknown[]) => outreach.findTargetByAddress(...a),
  getCampaignIdForTarget: (...a: unknown[]) => outreach.getCampaignIdForTarget(...a),
  insertInboundTouch: (...a: unknown[]) => outreach.insertInboundTouch(...a),
  markOutreachReplied: (...a: unknown[]) => outreach.markOutreachReplied(...a),
  getTarget: (...a: unknown[]) => outreach.getTarget(...a),
  getCampaign: (...a: unknown[]) => outreach.getCampaign(...a),
}));
vi.mock("@/lib/noshow/inbound", () => ({ handleNoshowInbound: vi.fn(async () => ({ handled: false })) }));
vi.mock("@/lib/coordinator/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  insertInboundTouch: vi.fn(async () => {}),
}));
vi.mock("@/lib/after-hours/hours", () => ({ isOutsideHours: () => false, getSiteById: () => ({ id: "site-cc" }) }));
vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: vi.fn(async () => ({ id: "cap-1" })),
  hasOpenCaptureFrom: vi.fn(async () => false),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class DentallyClient {} }));
vi.mock("@/lib/dentally/write", () => ({ dentallyAgentClient: () => ({}) }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/agent/prompt", () => ({ buildSystemPrompt: vi.fn(() => "sys") }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: () => ({ clientId: "vitality" }),
  getSites: () => [{ id: "site-cc", name: "Vitality", clientId: "vitality" }],
  getClient: () => ({ id: "vitality", slug: "vitality" }),
}));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async () => []) }));
vi.mock("@/lib/agent/tools", () => ({ AGENT_TOOLS: [], makeDispatch: vi.fn(() => vi.fn()) }));
vi.mock("@/lib/agent/run", () => ({
  runAgentTurn: vi.fn(async () => ({ replyText: "Agent reply", toolCalls: [], escalated: false })),
}));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: vi.fn(async () => null) }));
vi.mock("@/lib/agent/guardrail", () => ({ checkAgentReply: () => ({ ok: true }), SAFE_HANDOVER: "handover" }));
vi.mock("@/lib/agent/idempotency", () => ({ claimInboundMessage: vi.fn(async () => true) }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: vi.fn(async () => true) }));
vi.mock("@/lib/cron-lock", () => ({ tryAcquireLease: async () => "acquired", releaseCronLock: async () => {} }));
vi.mock("@/lib/speed-to-lead/repository", () => ({ findLeadByConversation: vi.fn(async () => null) }));
vi.mock("@/lib/smile-assessment/repository", () => ({ latestResponseByLead: vi.fn(async () => null) }));
vi.mock("@/lib/smile-assessment/summary", () => ({ answerLines: () => [] }));
vi.mock("@/lib/agent/alerts", () => ({ alertStaffHandover: vi.fn(async () => {}) }));
vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: vi.fn(async () => ({
    id: "conv-1", status: "active", patientName: "Unknown 0001", treatment: null, fundingType: null,
  })),
  listMessages: vi.fn(async () => []),
  appendMessage: vi.fn(async () => {}),
  setConversationStatus: vi.fn(async () => {}),
  setConversationName: vi.fn(async () => {}),
  stampInbound: vi.fn(async () => {}),
  isAgentEnabled: vi.fn(async () => true),
}));

import { POST as inboundPOST } from "./route";
import { buildSystemPrompt } from "@/lib/agent/prompt";

const TOKEN = "test-auth-token";
const INBOUND_URL = "http://localhost:3000/api/webhooks/twilio/inbound";

function signed(params: Record<string, string>): Request {
  const sig = computeTwilioSignature(INBOUND_URL, params, TOKEN);
  return new Request(INBOUND_URL, {
    method: "POST",
    body: new URLSearchParams(params),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
  });
}

function target(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "tgt-1", campaignId: "camp-1", patientId: "p-1", name: "Pat", phone: "+447700900001",
    siteId: "site-cc", matchedReason: null, status: "contacted",
    consent: { sms: true, email: false, marketing: false },
    currentStep: 1, nextDueAt: now, startedAt: now, endedAt: null, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("NODE_ENV", "test");
  outreach.findTargetByAddress.mockResolvedValue({ targetId: "tgt-1", siteId: "site-cc" });
  outreach.getCampaignIdForTarget.mockResolvedValue("camp-1");
  outreach.insertInboundTouch.mockResolvedValue(undefined);
  outreach.markOutreachReplied.mockResolvedValue(undefined);
  outreach.getCampaign.mockResolvedValue({
    id: "camp-1", messageAngle: "a hygiene review", practitionerName: "Dr Green", practitionerId: "prac-9",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function contextOf() {
  // The context object handed to the agent carries outreachInvite (or not).
  const call = vi.mocked(buildSystemPrompt).mock.calls[0];
  return (call?.[0] ?? {}) as { outreachInvite?: unknown };
}

describe("inbound outreach reply-linkage guard", () => {
  it("an ACTIVE, RECENT target IS linked: regressed to 'replied' and primes the agent", async () => {
    outreach.getTarget.mockResolvedValue(target({ status: "contacted" }));

    const res = await inboundPOST(signed({ From: "+447700900001", Body: "yes please", MessageSid: "SM1" }));

    expect(res.status).toBe(200);
    expect(outreach.insertInboundTouch).toHaveBeenCalledTimes(1); // reply recorded
    // Pause + stamp replied_at (once), via the dedicated idempotent marker.
    expect(outreach.markOutreachReplied).toHaveBeenCalledWith("tgt-1");
    // Agent primed with the campaign clinician/angle.
    expect(contextOf().outreachInvite).toMatchObject({
      treatmentAngle: "a hygiene review", practitionerName: "Dr Green", practitionerId: "prac-9",
    });
  });

  it("a 'booked' target is NOT regressed and does NOT prime the agent (only recorded)", async () => {
    outreach.getTarget.mockResolvedValue(target({ status: "booked" }));

    const res = await inboundPOST(signed({ From: "+447700900001", Body: "thanks", MessageSid: "SM2" }));

    expect(res.status).toBe(200);
    expect(outreach.insertInboundTouch).toHaveBeenCalledTimes(1); // still recorded (audit)
    expect(outreach.markOutreachReplied).not.toHaveBeenCalled(); // no regression of a booked target
    expect(outreach.getCampaign).not.toHaveBeenCalled();
    expect(contextOf().outreachInvite).toBeUndefined(); // agent NOT primed with a stale campaign
  });

  it("an 'exhausted' target is NOT regressed", async () => {
    outreach.getTarget.mockResolvedValue(target({ status: "exhausted" }));

    await inboundPOST(signed({ From: "+447700900001", Body: "ok", MessageSid: "SM3" }));

    expect(outreach.markOutreachReplied).not.toHaveBeenCalled();
    expect(contextOf().outreachInvite).toBeUndefined();
  });

  it("an active but STALE match (last activity > 30 days ago) is NOT regressed or primed", async () => {
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    outreach.getTarget.mockResolvedValue(target({ status: "contacted", updatedAt: old, startedAt: old, createdAt: old, nextDueAt: old }));

    await inboundPOST(signed({ From: "+447700900001", Body: "hello again", MessageSid: "SM4" }));

    expect(outreach.insertInboundTouch).toHaveBeenCalledTimes(1); // recorded
    expect(outreach.markOutreachReplied).not.toHaveBeenCalled(); // stale: not regressed
    expect(contextOf().outreachInvite).toBeUndefined();
  });

  it("a lookup failure never breaks the webhook (best-effort)", async () => {
    outreach.getTarget.mockRejectedValue(new Error("db down"));

    const res = await inboundPOST(signed({ From: "+447700900001", Body: "hi", MessageSid: "SM5" }));

    expect(res.status).toBe(200); // still a clean TwiML response
  });
});
