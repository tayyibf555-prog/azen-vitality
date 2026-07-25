// CLUSTER D, webhook half. What the inbound webhook does with the OUTCOME of an
// agent turn:
//  D4 a patient registered mid-thread keeps their thread (and their number is
//     remembered), instead of the next message opening an empty second one
//  D5 a conversation is marked booked only on a real booking, not an attempt
//  D6 a lead the agent books is marked booked in the speed-to-lead worklist
//  D7 the agent is told which channel it is actually on
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeTwilioSignature } from "@/lib/messaging/signature";

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));
vi.mock("@/lib/messaging/suppression", () => ({
  isStopKeyword: () => false,
  addSuppression: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  isSuppressed: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
}));
vi.mock("@/lib/reactivation/repository", () => ({
  findTargetByAddress: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  insertInboundTouch: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  getCadenceByTarget: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  updateCadence: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  getTargetContext: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));
vi.mock("@/lib/recall/repository", () => ({
  findTargetByAddress: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  getCadenceByTarget: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  updateCadence: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  insertInboundTouch: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));
vi.mock("@/lib/outreach/repository", () => ({
  findTargetByAddress: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  insertInboundTouch: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutreachReplied: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutreachBookedByAddress: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  getCampaignIdForTarget: vi.fn(async (..._a: unknown[]): Promise<string | null> => null),
  getCampaign: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  getTarget: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));
vi.mock("@/lib/noshow/inbound", () => ({
  handleNoshowInbound: vi.fn(async (..._a: unknown[]) => ({ handled: false })),
}));
vi.mock("@/lib/coordinator/repository", () => ({
  findTargetByAddress: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  insertInboundTouch: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: vi.fn(() => false),
  getSiteById: vi.fn(() => ({ id: "site-cc" })),
}));
vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: vi.fn(async (..._a: unknown[]) => ({ id: "cap-1" })),
  hasOpenCaptureFrom: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class DentallyClient {} }));
vi.mock("@/lib/dentally/write", () => ({ dentallyAgentClient: vi.fn(() => ({})) }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(async (..._a: unknown[]): Promise<void> => {}) }));
vi.mock("@/lib/agent/prompt", () => ({ buildSystemPrompt: vi.fn(() => "BASE PROMPT") }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: vi.fn(() => ({ id: "site-cc", clientId: "vitality" })),
  getSites: vi.fn(() => [{ id: "site-cc", name: "N15" }]),
  getClient: vi.fn(() => ({ id: "vitality", slug: "vitality" })),
}));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) }));
vi.mock("@/lib/agent/tools", () => ({ AGENT_TOOLS: [], makeDispatch: vi.fn(() => vi.fn()) }));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) }));
vi.mock("@/lib/agent/guardrail", () => ({
  checkAgentReply: vi.fn(() => ({ ok: true })),
  SAFE_HANDOVER: "A member of our team will be in touch.",
}));
vi.mock("@/lib/agent/alerts", () => ({ alertStaffHandover: vi.fn(async (..._a: unknown[]): Promise<void> => {}) }));
vi.mock("@/lib/agent/idempotency", () => ({ claimInboundMessage: vi.fn(async (..._a: unknown[]): Promise<boolean> => true) }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: vi.fn(async (..._a: unknown[]): Promise<boolean> => true) }));
vi.mock("@/lib/cron-lock", () => ({
  tryAcquireLease: vi.fn(async (..._a: unknown[]) => "acquired"),
  releaseCronLock: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));
vi.mock("@/lib/smile-assessment/repository", () => ({
  latestResponseByLead: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
}));
vi.mock("@/lib/smile-assessment/summary", () => ({ answerLines: vi.fn(() => []) }));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  findLeadByConversation: vi.fn(async (..._a: unknown[]) => ({ id: "lead-1", stage: "contacted" })),
  setLeadStage: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));
vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: vi.fn(async (..._a: unknown[]) => ({
    id: "conv-1",
    status: "active",
    patientName: "Unknown 0123",
    treatment: null,
    fundingType: null,
  })),
  listMessages: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  appendMessage: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  setConversationStatus: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  setConversationName: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  stampInbound: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  isAgentEnabled: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
  upsertPhoneIdentity: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));

// The conversation re-key is a direct table update, so the client is stubbed and
// the update payload captured.
const conversationUpdates: Array<{ patch: Record<string, unknown>; id: unknown }> = [];
vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: (_table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: unknown) => {
          conversationUpdates.push({ patch, id });
          return { error: null };
        },
      }),
    }),
  }),
}));

vi.mock("@/lib/agent/run", () => ({
  runAgentTurn: vi.fn(async (..._a: unknown[]) => ({
    replyText: "Agent reply",
    toolCalls: [],
    escalated: false,
    booked: false,
    registeredPatientId: null,
    registeredPatientName: null,
  })),
}));

import { POST as inboundPOST } from "./route";
import { runAgentTurn } from "@/lib/agent/run";
import { setConversationStatus, upsertPhoneIdentity } from "@/lib/agent/repository";
import { setLeadStage } from "@/lib/speed-to-lead/repository";

const TOKEN = "test-auth-token";
const INBOUND_URL = "http://localhost:3000/api/webhooks/twilio/inbound";

function signed(params: Record<string, string>): Request {
  return new Request(INBOUND_URL, {
    method: "POST",
    body: new URLSearchParams(params),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": computeTwilioSignature(INBOUND_URL, params, TOKEN),
    },
  });
}

/** The turn result the mocked agent returns for the next inbound. */
function turnReturns(over: Record<string, unknown>): void {
  vi.mocked(runAgentTurn).mockResolvedValueOnce({
    replyText: "Agent reply",
    toolCalls: [],
    escalated: false,
    booked: false,
    registeredPatientId: null,
    registeredPatientName: null,
    ...over,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  conversationUpdates.length = 0;
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("D5/D6: a conversation and its lead are only marked booked on a REAL booking", () => {
  it("marks both booked when the turn reports a booking", async () => {
    turnReturns({ booked: true, toolCalls: [{ name: "book", input: {} }] });
    await inboundPOST(signed({ From: "+447700900123", Body: "yes please", MessageSid: "SM1" }));
    expect(setConversationStatus).toHaveBeenCalledWith("conv-1", "booked");
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "booked");
  });

  it("marks NEITHER when the model merely attempted a booking that did not happen", async () => {
    // The old code keyed off the attempt, so this over-reported the Booked figure
    // and left staff skipping a patient with no appointment.
    turnReturns({ booked: false, toolCalls: [{ name: "book", input: {} }] });
    await inboundPOST(signed({ From: "+447700900123", Body: "yes please", MessageSid: "SM2" }));
    expect(setConversationStatus).not.toHaveBeenCalledWith("conv-1", "booked");
    expect(setLeadStage).not.toHaveBeenCalled();
  });
});

describe("D4: a patient registered mid-thread keeps their thread", () => {
  it("re-keys the conversation onto the new Dentally id and remembers the number", async () => {
    turnReturns({ registeredPatientId: "pat-new", registeredPatientName: "Jane Doe" });
    await inboundPOST(signed({ From: "+447700900123", Body: "I am Jane Doe", MessageSid: "SM3" }));
    expect(conversationUpdates).toHaveLength(1);
    expect(conversationUpdates[0].id).toBe("conv-1");
    expect(conversationUpdates[0].patch).toMatchObject({
      dentally_patient_id: "pat-new",
      patient_name: "Jane Doe",
    });
    expect(upsertPhoneIdentity).toHaveBeenCalledWith(
      "+447700900123",
      expect.objectContaining({ patientId: "pat-new", patientName: "Jane Doe", siteId: "site-cc" }),
    );
  });

  it("leaves the thread alone when nobody was registered", async () => {
    turnReturns({});
    await inboundPOST(signed({ From: "+447700900123", Body: "hello", MessageSid: "SM4" }));
    expect(conversationUpdates).toHaveLength(0);
    expect(upsertPhoneIdentity).not.toHaveBeenCalled();
  });
});

describe("D7: the agent is told which channel it is on", () => {
  it("says WhatsApp on a WhatsApp thread", async () => {
    turnReturns({});
    await inboundPOST(signed({ From: "whatsapp:+447700900123", Body: "hello", MessageSid: "SM5" }));
    const prompt = String(vi.mocked(runAgentTurn).mock.calls[0][1].systemPrompt);
    expect(prompt).toContain("BASE PROMPT");
    expect(prompt).toContain("WhatsApp");
    expect(prompt).toContain("Never tell them you will text or SMS them");
  });

  it("says text message on an SMS thread", async () => {
    turnReturns({});
    await inboundPOST(signed({ From: "+447700900123", Body: "hello", MessageSid: "SM6" }));
    const prompt = String(vi.mocked(runAgentTurn).mock.calls[0][1].systemPrompt);
    expect(prompt).toContain("text message (SMS)");
    expect(prompt).not.toContain("WhatsApp");
  });
});
