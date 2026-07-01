// RESILIENCE: the Twilio inbound webhook must never 500 / never leave an
// unhandled rejection under injected failures. Twilio retries any non-2xx, so a
// 500 causes the whole agent turn to re-run (double book / double reply). This
// suite injects:
//  - an oversized / garbage body (already 400 elsewhere; re-asserted for the
//    unhandled-rejection guarantee)
//  - a validly-signed message from an UNKNOWN number (no target/identity) - the
//    agent still answers, no crash
//  - a DB throw while RECORDING A STOP SUPPRESSION - the opt-out path must not
//    surface a 500 that makes Twilio retry the STOP
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeTwilioSignature } from "@/lib/messaging/signature";

vi.mock("@/lib/messaging/suppression", () => {
  const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
  return {
    isStopKeyword: (b: string) => STOP.has(b.trim().toLowerCase()),
    addSuppression: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
    isSuppressed: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
  };
});
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
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(async (..._a: unknown[]): Promise<void> => {}) }));
vi.mock("@/lib/agent/prompt", () => ({ buildSystemPrompt: vi.fn(() => "sys") }));
vi.mock("@/lib/mock/clients", () => ({ getSite: vi.fn(() => ({ clientId: "client-1" })) }));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) }));
vi.mock("@/lib/agent/tools", () => ({ AGENT_TOOLS: [], makeDispatch: vi.fn(() => vi.fn()) }));
vi.mock("@/lib/agent/run", () => ({
  runAgentTurn: vi.fn(async (..._a: unknown[]) => ({ replyText: "Agent reply", toolCalls: [], escalated: false })),
}));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) }));
vi.mock("@/lib/agent/guardrail", () => ({
  checkAgentReply: vi.fn(() => ({ ok: true })),
  SAFE_HANDOVER: "A member of our team will be in touch.",
}));
vi.mock("@/lib/agent/idempotency", () => ({
  claimInboundMessage: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
}));
vi.mock("@/lib/rate-budget", () => ({
  consumeBudget: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
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
}));

import { POST as inboundPOST } from "./route";
import { addSuppression } from "@/lib/messaging/suppression";
import { sendMessage } from "@/lib/messaging/send";
import { runAgentTurn } from "@/lib/agent/run";

const TOKEN = "test-auth-token";
const BASE = "http://localhost:3000";
const INBOUND_URL = `${BASE}/api/webhooks/twilio/inbound`;

function formRequest(url: string, params: Record<string, string>, sig?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (sig !== undefined) headers["x-twilio-signature"] = sig;
  return new Request(url, { method: "POST", body: new URLSearchParams(params), headers });
}
function signed(url: string, params: Record<string, string>): Request {
  return formRequest(url, params, computeTwilioSignature(url, params, TOKEN));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inbound: oversized / garbage body", () => {
  it("a very large valid-form body does not crash and answers with TwiML", async () => {
    // 200k-char body: bounded work, no unhandled throw.
    const big = "a".repeat(200_000);
    const res = await inboundPOST(signed(INBOUND_URL, { From: "+447700900123", Body: big }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
  });

  it("a non-form (JSON) body returns a 4xx, never an unhandled 500", async () => {
    const res = await inboundPOST(
      new Request(INBOUND_URL, {
        method: "POST",
        body: '{"garbage":true}',
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("inbound: validly-signed message from an unknown number", () => {
  it("reaches the agent and answers, with no target/identity on file", async () => {
    const res = await inboundPOST(signed(INBOUND_URL, { From: "+447700999999", Body: "hello, can I book?" }));
    expect(res.status).toBe(200);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+447700999999", body: "Agent reply" }),
    );
  });
});

describe("inbound: DB throw while recording a STOP suppression", () => {
  it("does not surface a 500 (which would make Twilio retry the STOP)", async () => {
    // addSuppression throws (suppression table write fails). The webhook must
    // still return a 2xx TwiML so Twilio does not retry - a retried STOP is
    // harmless to the patient but a 500 loops the whole webhook.
    vi.mocked(addSuppression).mockRejectedValueOnce(new Error("suppression write failed"));
    const res = await inboundPOST(signed(INBOUND_URL, { From: "+447700900123", Body: "STOP" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    // Never auto-reply to a STOP.
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
