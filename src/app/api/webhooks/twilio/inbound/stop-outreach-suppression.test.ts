// STOP suppression for an OUTREACH-ONLY recipient. A STOP from a number known only
// via a segment-outreach campaign - no reactivation/recall target on file and no
// resolved Dentally identity - previously suppressed by ADDRESS only, never by
// patient:<id>. The same person arriving later on a different address (e.g. a public
// form lead keyed to their patient id) would then not be recognised as opted out.
//
// The STOP handler now derives the opt-out patient-ref from the matched outreach
// target too (reusing the reply-linkage lookup, kept in its best-effort try/catch),
// so a STOP suppresses BOTH the address and patient:<id>. Address suppression must
// ALWAYS still happen, even if the outreach patient lookup fails.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeTwilioSignature } from "@/lib/messaging/signature";

const outreach = vi.hoisted(() => ({
  findTargetByAddress: vi.fn(),
  getCampaignIdForTarget: vi.fn(),
  insertInboundTouch: vi.fn(),
  setTargetStatus: vi.fn(),
  getTarget: vi.fn(),
  getCampaign: vi.fn(),
}));

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));
// A real STOP keyword; addSuppression + isSuppressed are spies.
vi.mock("@/lib/messaging/suppression", () => {
  const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
  return {
    isStopKeyword: (b: string) => STOP.has(b.trim().toLowerCase()),
    addSuppression: vi.fn(async () => {}),
    isSuppressed: vi.fn(async () => false),
  };
});
// No reactivation / recall / coordinator target: this recipient is outreach-only.
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
  setTargetStatus: (...a: unknown[]) => outreach.setTargetStatus(...a),
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
    id: "conv-1", status: "active", patientName: "Unknown 0099", treatment: null, fundingType: null,
  })),
  listMessages: vi.fn(async () => []),
  appendMessage: vi.fn(async () => {}),
  setConversationStatus: vi.fn(async () => {}),
  setConversationName: vi.fn(async () => {}),
  stampInbound: vi.fn(async () => {}),
  isAgentEnabled: vi.fn(async () => true),
}));

import { POST as inboundPOST } from "./route";
import { addSuppression } from "@/lib/messaging/suppression";
import { sendMessage } from "@/lib/messaging/send";

const TOKEN = "test-auth-token";
const INBOUND_URL = "http://localhost:3000/api/webhooks/twilio/inbound";
const FROM = "+447700900099";

function signed(params: Record<string, string>): Request {
  const sig = computeTwilioSignature(INBOUND_URL, params, TOKEN);
  return new Request(INBOUND_URL, {
    method: "POST",
    body: new URLSearchParams(params),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
  });
}

// A full outreach target as getTarget returns it. patientId is the Dentally id the
// opt-out patient-ref is built from.
function outreachTarget(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: "tgt-1", campaignId: "camp-1", patientId: "p-99", name: "Pat", phone: FROM,
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
  outreach.setTargetStatus.mockResolvedValue(undefined);
  outreach.getTarget.mockResolvedValue(outreachTarget());
  outreach.getCampaign.mockResolvedValue({
    id: "camp-1", messageAngle: "a hygiene review", practitionerName: "Dr Green", practitionerId: "prac-9",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inbound STOP from an outreach-only recipient", () => {
  it("suppresses BOTH the address and the patient-ref derived from the outreach match", async () => {
    const res = await inboundPOST(signed({ From: FROM, Body: "STOP", MessageSid: "SM-STOP-1" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    // Never auto-reply to a STOP.
    expect(sendMessage).not.toHaveBeenCalled();
    // Suppressed by ADDRESS...
    expect(addSuppression).toHaveBeenCalledWith(expect.any(String), "sms", FROM, "stop");
    // ...AND by the outreach match's patient-ref (the bug: this was previously missing).
    expect(addSuppression).toHaveBeenCalledWith(expect.any(String), "sms", "patient:p-99", "stop");
    // Opt-out spans both phone channels for the same number.
    expect(addSuppression).toHaveBeenCalledWith(expect.any(String), "whatsapp", "patient:p-99", "stop");
  });

  it("still suppresses by address when there is NO outreach match (patient-ref stays null, no crash)", async () => {
    outreach.findTargetByAddress.mockResolvedValue(null);

    const res = await inboundPOST(signed({ From: FROM, Body: "STOP", MessageSid: "SM-STOP-2" }));

    expect(res.status).toBe(200);
    expect(addSuppression).toHaveBeenCalledWith(expect.any(String), "sms", FROM, "stop");
    // With nothing to resolve the patient, no patient:<id> ref is written.
    expect(addSuppression).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.stringContaining("patient:"),
      expect.anything(),
    );
  });

  it("address suppression ALWAYS happens even if the outreach patient lookup throws (best-effort)", async () => {
    // findTargetByAddress matched, but resolving the full target (for the patient-ref)
    // throws. The best-effort try/catch must swallow it and the STOP must still
    // suppress by address - the opt-out is never broken by a lookup failure.
    outreach.getTarget.mockRejectedValue(new Error("outreach store briefly down"));

    const res = await inboundPOST(signed({ From: FROM, Body: "STOP", MessageSid: "SM-STOP-3" }));

    expect(res.status).toBe(200);
    expect(addSuppression).toHaveBeenCalledWith(expect.any(String), "sms", FROM, "stop");
    expect(addSuppression).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.stringContaining("patient:"),
      expect.anything(),
    );
  });
});
