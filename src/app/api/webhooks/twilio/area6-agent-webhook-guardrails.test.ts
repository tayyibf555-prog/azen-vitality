// AREA 6: inbound-webhook-level guardrail checks for the conversational agent.
//
// These assert the wiring around the agent at src/app/api/webhooks/twilio/inbound/route.ts:
//   - a deterministic OUTPUT filter blocks a clinical-advice / unverified-price /
//     NHS-private reply before send and replaces it with a safe handover.
//   - a per-sender consumeBudget() ceiling gates the agent turn, so a spammer
//     texting the number cannot run unbounded Claude tool-loops.
//   - malformed / empty inbound is handled without a 500 or a leaked stack.
//
// The webhook's every I/O seam is mocked; we exercise the real route handler.

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
vi.mock("@/lib/noshow/inbound", () => ({
  handleNoshowInbound: vi.fn(async () => ({ handled: false })),
}));
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
  // Default reply is a *guardrail-violating* string on purpose, to prove there
  // is no output filter downstream. Individual tests override per case.
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
// The route now imports the budget + idempotency helpers; mock both.
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: vi.fn(async () => true) }));
vi.mock("@/lib/agent/idempotency", () => ({ claimInboundMessage: vi.fn(async () => true) }));

import { POST as inboundPOST } from "./inbound/route";
import { sendMessage } from "@/lib/messaging/send";
import { runAgentTurn } from "@/lib/agent/run";
import { consumeBudget } from "@/lib/rate-budget";

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
});
afterEach(() => vi.unstubAllEnvs());

describe("output filter: violating agent reply is blocked before send (FIXED)", () => {
  it("a reply containing NHS/private + clinical advice is REPLACED by a safe handover", async () => {
    const res = await inboundPOST(signed({ From: "+447700900123", Body: "am I covered?" }));
    expect(res.status).toBe(200);
    expect(runAgentTurn).toHaveBeenCalled();
    // The deterministic output filter caught the model text; the patient gets a
    // safe handover instead of the NHS + clinical-advice reply.
    const sent = (sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.body).not.toContain("NHS");
    expect(sent.body).not.toContain("clinically you definitely need");
    expect(sent.body.toLowerCase()).toContain("member of the team");
  });
});

describe("cost guard: per-sender budget ceiling across inbound messages (FIXED)", () => {
  it("consumeBudget IS consulted per inbound; over the cap the model is not called", async () => {
    const budget = consumeBudget as unknown as ReturnType<typeof vi.fn>;
    // First few within budget, then the cap trips.
    budget.mockResolvedValue(true);
    for (let i = 0; i < 3; i++) {
      const res = await inboundPOST(signed({ From: "+447700900123", Body: `msg ${i}`, MessageSid: `SM${i}` }));
      expect(res.status).toBe(200);
    }
    expect(budget.mock.calls.length).toBe(3); // one consult per inbound
    expect((runAgentTurn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);

    // Now over the cap: the budget denies and the model must NOT run.
    budget.mockResolvedValueOnce(false);
    const res = await inboundPOST(signed({ From: "+447700900123", Body: "spam", MessageSid: "SM-CAP" }));
    expect(res.status).toBe(200);
    expect((runAgentTurn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3); // unchanged
  });
});

describe("failure handling at the webhook boundary", () => {
  it("malformed (non-form) POST returns 400, never a 500 or leaked stack", async () => {
    const res = await inboundPOST(
      new Request(INBOUND_URL, { method: "POST", body: '{"x":1}', headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(400);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("empty Body with a valid signature returns 200 and still runs the agent (no crash)", async () => {
    const res = await inboundPOST(signed({ From: "+447700900123", Body: "" }));
    expect(res.status).toBe(200);
  });

  it("an oversized inbound body is accepted and passed through without throwing", async () => {
    const big = "a".repeat(20000);
    const res = await inboundPOST(signed({ From: "+447700900123", Body: big }));
    expect(res.status).toBe(200);
    expect(runAgentTurn).toHaveBeenCalled();
  });

  it("a thrown agent error is caught: conversation goes to a human, 200 returned", async () => {
    (runAgentTurn as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("529 overloaded"));
    const res = await inboundPOST(signed({ From: "+447700900123", Body: "hello" }));
    expect(res.status).toBe(200);
    // Fallback message is sent, not a stack trace.
    const sent = (sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.body).toContain("team will be in touch");
  });
});
