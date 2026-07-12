import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 2 (consent + suppression gates): the Twilio inbound webhook.
// Proves the STOP path actually WRITES suppression (patient ref for a known
// patient, raw address for an unknown number) and replies with nothing; and
// that an already-suppressed patient's free-text inbound is handed to a human
// instead of being auto-replied by the conversion agent.

const addSuppression = vi.fn();
const isSuppressed = vi.fn();
const sendMessage = vi.fn();
const identifyByPhone = vi.fn();
const findOrCreateConversation = vi.fn();
const setConversationStatus = vi.fn();
const runAgentTurn = vi.fn();

// The routes under test consult the kill switch on every send path (fail-closed
// once messaging is live); these tests exercise behaviour with everything ON.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));

vi.mock("@/lib/messaging/signature", () => ({ verifyTwilioSignature: () => true }));
vi.mock("@/lib/messaging/suppression", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/messaging/suppression")>();
  return {
    isStopKeyword: actual.isStopKeyword, // real keyword matching
    addSuppression: (...a: unknown[]) => addSuppression(...a),
    isSuppressed: (...a: unknown[]) => isSuppressed(...a),
  };
});
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {} }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));
vi.mock("@/lib/noshow/inbound", () => ({ handleNoshowInbound: vi.fn(async () => ({ handled: false })) }));
vi.mock("@/lib/reactivation/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  insertInboundTouch: vi.fn(),
  getCadenceByTarget: vi.fn(async () => null),
  updateCadence: vi.fn(),
  getTargetContext: vi.fn(async () => null),
}));
vi.mock("@/lib/recall/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  getCadenceByTarget: vi.fn(async () => null),
  updateCadence: vi.fn(),
  insertInboundTouch: vi.fn(),
}));
vi.mock("@/lib/coordinator/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  insertInboundTouch: vi.fn(),
}));
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: () => false,
  getSiteById: () => null,
}));
vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: vi.fn(),
  hasOpenCaptureFrom: vi.fn(async () => false),
}));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: (...a: unknown[]) => identifyByPhone(...a) }));
vi.mock("@/lib/agent/prompt", () => ({ buildSystemPrompt: () => "system" }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: () => ({ id: "site-cc", clientId: "vitality" }),
  getSites: () => [{ id: "site-cc" }],
}));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async () => []) }));
vi.mock("@/lib/agent/tools", () => ({ AGENT_TOOLS: [], makeDispatch: () => vi.fn() }));
vi.mock("@/lib/agent/run", () => ({ runAgentTurn: (...a: unknown[]) => runAgentTurn(...a) }));
vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: (...a: unknown[]) => findOrCreateConversation(...a),
  listMessages: vi.fn(async () => []),
  appendMessage: vi.fn(),
  setConversationStatus: (...a: unknown[]) => setConversationStatus(...a),
  setConversationName: vi.fn(),
  stampInbound: vi.fn(),
  isAgentEnabled: vi.fn(async () => true),
}));

import { POST } from "@/app/api/webhooks/twilio/inbound/route";

const FROM = "+447700900123";

function inbound(body: string): Request {
  const form = new FormData();
  form.set("From", FROM);
  form.set("Body", body);
  return new Request("http://localhost/api/webhooks/twilio/inbound", { method: "POST", body: form });
}

const IDENTITY = {
  patientId: "p-9",
  siteId: "site-cc",
  patientName: "Amelia Test",
  treatment: null,
  fundingType: null,
  lastVisitAt: null,
  recallDueAt: null,
  source: "directory",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  isSuppressed.mockResolvedValue(false);
  identifyByPhone.mockResolvedValue(null);
  findOrCreateConversation.mockResolvedValue({
    id: "conv-1",
    status: "active",
    patientName: "Amelia Test",
    treatment: null,
    fundingType: null,
  });
  runAgentTurn.mockResolvedValue({ replyText: "Of course, when suits?", toolCalls: [], escalated: false });
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
});

describe("inbound STOP updates suppression", () => {
  it("suppresses a KNOWN patient by patient ref and sends no reply", async () => {
    identifyByPhone.mockResolvedValue(IDENTITY);
    const res = await POST(inbound("STOP"));
    expect(res.status).toBe(200);
    expect(addSuppression).toHaveBeenCalledWith("site-cc", "sms", "patient:p-9", "stop");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("suppresses an UNKNOWN number by address and sends no reply", async () => {
    const res = await POST(inbound("stop"));
    expect(res.status).toBe(200);
    expect(addSuppression).toHaveBeenCalledWith(expect.any(String), "sms", FROM, "stop");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("treats UNSUBSCRIBE the same as STOP", async () => {
    await POST(inbound("UNSUBSCRIBE"));
    // One opt-out writes BOTH phone channels (sms + whatsapp) for the site.
    expect(addSuppression).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("suppressed patient never gets an automated agent reply", () => {
  it("hands a suppressed patient's free text to a human, no send, no agent turn", async () => {
    identifyByPhone.mockResolvedValue(IDENTITY);
    isSuppressed.mockImplementation(async (_s: string, _c: string, ref: string) => ref === "patient:p-9");
    const res = await POST(inbound("actually can I book a whitening appointment?"));
    expect(res.status).toBe(200);
    expect(setConversationStatus).toHaveBeenCalledWith("conv-1", "needs_human");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("also honours a suppression recorded by ADDRESS", async () => {
    isSuppressed.mockImplementation(async (_s: string, _c: string, ref: string) => ref === FROM);
    await POST(inbound("hi, can I book?"));
    expect(setConversationStatus).toHaveBeenCalledWith("conv-1", "needs_human");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("control: an unsuppressed patient does get the agent reply", async () => {
    identifyByPhone.mockResolvedValue(IDENTITY);
    const res = await POST(inbound("hi, can I book?"));
    expect(res.status).toBe(200);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ to: FROM }));
  });
});
