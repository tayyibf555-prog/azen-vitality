// G3: inbound WhatsApp must not be silenced by the OUTBOUND WhatsApp switch.
//
// The inbound agent used to read the same 'whatsapp' system slug that the messaging
// drain reads as its outbound channel gate, and that migration 0047 seeds OFF. So
// the moment the owner switched WhatsApp SENDING off, every inbound WhatsApp
// enquiry got total silence and no staff alert: a patient messaged the practice and
// nobody ever knew.
//
// The inbound agent now has its OWN slug ('whatsapp-agent'), and when that slug is
// switched off the handover raises a staff alert, so silence can never be invisible.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeTwilioSignature } from "@/lib/messaging/signature";

const h = vi.hoisted(() => ({
  disabled: new Set<string>(),
  askedFor: [] as string[],
}));

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async (_clientId: string, slug: string) => {
    h.askedFor.push(slug);
    return !h.disabled.has(slug);
  },
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
  findTargetByAddress: vi.fn(async () => null),
  getCampaignIdForTarget: vi.fn(async () => null),
  insertInboundTouch: vi.fn(async () => {}),
  markOutreachReplied: vi.fn(async () => {}),
  getTarget: vi.fn(async () => null),
  getCampaign: vi.fn(async () => null),
  markOutreachBookedByAddress: vi.fn(async () => {}),
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
import { sendMessage } from "@/lib/messaging/send";
import { alertStaffHandover } from "@/lib/agent/alerts";
import { runAgentTurn } from "@/lib/agent/run";

const TOKEN = "test-auth-token";
const INBOUND_URL = "http://localhost:3000/api/webhooks/twilio/inbound";

function whatsappInbound(body = "Hello, can I book an appointment?"): Request {
  const params = {
    From: "whatsapp:+447700900099",
    To: "whatsapp:+441134960000",
    Body: body,
    MessageSid: `SM${Math.random().toString(36).slice(2, 12)}`,
  };
  const sig = computeTwilioSignature(INBOUND_URL, params, TOKEN);
  return new Request(INBOUND_URL, {
    method: "POST",
    body: new URLSearchParams(params),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.disabled.clear();
  h.askedFor.length = 0;
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inbound WhatsApp agent kill switch", () => {
  it("reads its own slug, not the outbound WhatsApp sending slug", async () => {
    await inboundPOST(whatsappInbound());

    expect(h.askedFor).toContain("whatsapp-agent");
    expect(h.askedFor).not.toContain("whatsapp");
  });

  it("still answers a patient when outbound WhatsApp sending is switched off", async () => {
    h.disabled.add("whatsapp"); // exactly what migration 0047 seeds

    await inboundPOST(whatsappInbound());

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("alerts the practice when the inbound agent itself is switched off", async () => {
    h.disabled.add("whatsapp-agent");

    await inboundPOST(whatsappInbound());

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(alertStaffHandover).toHaveBeenCalledTimes(1);
  });

  it("leaves the SMS agent on its own slug", async () => {
    const params = {
      From: "+447700900099",
      To: "+441134960000",
      Body: "Hello",
      MessageSid: "SMsmsslug01",
    };
    const sig = computeTwilioSignature(INBOUND_URL, params, TOKEN);
    await inboundPOST(
      new Request(INBOUND_URL, {
        method: "POST",
        body: new URLSearchParams(params),
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      }),
    );

    expect(h.askedFor).toContain("booking-agent");
    expect(h.askedFor).not.toContain("whatsapp-agent");
  });
});
