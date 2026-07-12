// FIXES 1, 3, 4 at the inbound webhook boundary:
//   1. OUTPUT GUARDRAIL: a violating model reply is replaced by the safe handover
//      and never reaches sendMessage verbatim.
//   3. PER-SENDER COST GUARD: after the cap, further inbound gets a throttle reply
//      and does NOT call the model.
//   4. MESSAGESID IDEMPOTENCY: the same MessageSid twice runs the agent once.
//
// Every I/O seam is mocked; the real route handler runs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeTwilioSignature } from "@/lib/messaging/signature";

// The routes under test consult the kill switch on every send path (fail-closed
// once messaging is live); these tests exercise behaviour with everything ON.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));

vi.mock("@/lib/messaging/suppression", () => {
  const STOP = new Set(["stop", "stopall", "unsubscribe", "end", "quit"]);
  return {
    isStopKeyword: (b: string) => STOP.has(b.trim().toLowerCase()),
    addSuppression: vi.fn(async () => {}),
    isSuppressed: vi.fn(async () => false),
  };
});
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
vi.mock("@/lib/noshow/inbound", () => ({ handleNoshowInbound: vi.fn(async () => ({ handled: false })) }));
vi.mock("@/lib/coordinator/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  insertInboundTouch: vi.fn(async () => {}),
}));
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: vi.fn(() => false),
  getSiteById: vi.fn(() => ({ id: "site-cc" })),
}));
vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: vi.fn(async () => ({ id: "cap-1" })),
  hasOpenCaptureFrom: vi.fn(async () => false),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class DentallyClient {} }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/agent/prompt", () => ({ buildSystemPrompt: vi.fn(() => "sys") }));
vi.mock("@/lib/mock/clients", () => ({ getSite: vi.fn(() => ({ clientId: "client-1" })) }));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async () => []) }));
vi.mock("@/lib/agent/tools", () => ({ AGENT_TOOLS: [], makeDispatch: vi.fn(() => vi.fn()) }));
vi.mock("@/lib/agent/run", () => ({
  // Default: a guardrail-violating reply, to prove the OUTPUT FILTER blocks it.
  runAgentTurn: vi.fn(async () => ({
    replyText: "On the NHS this is free, and clinically you definitely need a filling.",
    toolCalls: [],
    escalated: false,
  })),
}));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: vi.fn(async () => null) }));
vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: vi.fn(async () => ({
    id: "conv-1",
    status: "active",
    patientName: "Unknown 0123",
    dentallyPatientId: "lead:+447700900123",
    treatment: null,
    fundingType: null,
  })),
  listMessages: vi.fn(async () => []),
  appendMessage: vi.fn(async () => {}),
  setConversationStatus: vi.fn(async () => {}),
  setConversationName: vi.fn(async () => {}),
  stampInbound: vi.fn(async () => {}),
  isAgentEnabled: vi.fn(async () => true),
}));
// Idempotency + per-sender budget seams. Default: fresh message, within budget.
const claimInboundMessage = vi.fn(async (..._a: unknown[]) => true);
const consumeBudget = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/agent/idempotency", () => ({ claimInboundMessage: (...a: unknown[]) => claimInboundMessage(...a) }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: (...a: unknown[]) => consumeBudget(...a) }));

import { POST as inboundPOST } from "./inbound/route";
import { sendMessage } from "@/lib/messaging/send";
import { runAgentTurn } from "@/lib/agent/run";
import { setConversationStatus } from "@/lib/agent/repository";

const TOKEN = "test-auth-token";
const INBOUND_URL = "http://localhost:3000/api/webhooks/twilio/inbound";
const sendMock = sendMessage as unknown as ReturnType<typeof vi.fn>;
const runMock = runAgentTurn as unknown as ReturnType<typeof vi.fn>;
const statusMock = setConversationStatus as unknown as ReturnType<typeof vi.fn>;

function signed(params: Record<string, string>): Request {
  const sig = computeTwilioSignature(INBOUND_URL, params, TOKEN);
  return new Request(INBOUND_URL, {
    method: "POST",
    body: new URLSearchParams(params),
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  claimInboundMessage.mockResolvedValue(true);
  consumeBudget.mockResolvedValue(true);
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
});
afterEach(() => vi.unstubAllEnvs());

describe("FIX 1 — output guardrail filter", () => {
  it("a violating model reply is REPLACED by the safe handover, never sent verbatim", async () => {
    const res = await inboundPOST(signed({ From: "+447700900123", Body: "am I covered?", MessageSid: "SM1" }));
    expect(res.status).toBe(200);
    expect(runMock).toHaveBeenCalledTimes(1);
    const sent = sendMock.mock.calls[0][0];
    // The model's NHS + clinical text is gone; the safe handover took its place.
    expect(sent.body).not.toContain("NHS");
    expect(sent.body).not.toContain("clinically you definitely need");
    expect(sent.body.toLowerCase()).toContain("member of the team");
    // And the conversation was handed to a human.
    expect(statusMock).toHaveBeenCalledWith("conv-1", "needs_human");
  });

  it("a clean reply is sent as-is (filter does not over-block)", async () => {
    runMock.mockResolvedValueOnce({
      replyText: "I can offer you Tuesday at 10am, does that work?",
      toolCalls: [],
      escalated: false,
    });
    await inboundPOST(signed({ From: "+447700900123", Body: "when can I come in?", MessageSid: "SM2" }));
    expect(sendMock.mock.calls[0][0].body).toBe("I can offer you Tuesday at 10am, does that work?");
  });
});

describe("FIX 3 — per-sender cost guard", () => {
  it("over the cap: a throttle reply is sent and the model is NOT called", async () => {
    consumeBudget.mockResolvedValueOnce(false);
    const res = await inboundPOST(signed({ From: "+447700900999", Body: "spam", MessageSid: "SM3" }));
    expect(res.status).toBe(200);
    // Budget was consulted, denied, so the agent never ran.
    expect(consumeBudget).toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    const sent = sendMock.mock.calls[0][0];
    expect(sent.body.toLowerCase()).toContain("team will be in touch");
  });

  it("within the cap: the agent runs normally", async () => {
    await inboundPOST(signed({ From: "+447700900123", Body: "hi", MessageSid: "SM4" }));
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

describe("FIX 4 — MessageSid idempotency", () => {
  it("a retried MessageSid is a no-op: the agent runs once", async () => {
    // First delivery: claimed.
    claimInboundMessage.mockResolvedValueOnce(true);
    await inboundPOST(signed({ From: "+447700900123", Body: "book me", MessageSid: "SM-DUP" }));
    // Retry of the SAME SID: claim returns false -> no-op.
    claimInboundMessage.mockResolvedValueOnce(false);
    await inboundPOST(signed({ From: "+447700900123", Body: "book me", MessageSid: "SM-DUP" }));

    expect(claimInboundMessage).toHaveBeenCalledTimes(2);
    expect(claimInboundMessage.mock.calls[0][0]).toBe("SM-DUP");
    // The agent turn ran exactly once across the two deliveries.
    expect(runMock).toHaveBeenCalledTimes(1);
    // The retry sent nothing.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
