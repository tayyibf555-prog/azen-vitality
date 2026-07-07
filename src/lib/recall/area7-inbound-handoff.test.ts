import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 7: inbound handoff. A patient reply that correlates to a RECALL outbound
// (and not to a reactivation outbound) must:
//   - be logged as an inbound recall touch against the right target, and
//   - PAUSE the active recall cadence so automation stops chasing.
// Precedence: if a reactivation target matches first, recall must NOT also fire
// (no double handling of one reply).
//
// The Twilio inbound webhook has a large dependency surface; we mock every import
// and assert only the recall-vs-reactivation routing + pause side effects.

// --- reactivation repo (checked first in the webhook) ---
const reFind = vi.fn();
const reGetCadence = vi.fn();
const reUpdateCadence = vi.fn();
const reInsertInbound = vi.fn();
const reGetContext = vi.fn();

// --- recall repo (checked only when reactivation misses) ---
const rcFind = vi.fn();
const rcGetCadence = vi.fn();
const rcUpdateCadence = vi.fn();
const rcInsertInbound = vi.fn();

vi.mock("@/lib/reactivation/repository", () => ({
  findTargetByAddress: (...a: unknown[]) => reFind(...a),
  getCadenceByTarget: (...a: unknown[]) => reGetCadence(...a),
  updateCadence: (...a: unknown[]) => reUpdateCadence(...a),
  insertInboundTouch: (...a: unknown[]) => reInsertInbound(...a),
  getTargetContext: (...a: unknown[]) => reGetContext(...a),
}));
vi.mock("@/lib/recall/repository", () => ({
  findTargetByAddress: (...a: unknown[]) => rcFind(...a),
  getCadenceByTarget: (...a: unknown[]) => rcGetCadence(...a),
  updateCadence: (...a: unknown[]) => rcUpdateCadence(...a),
  insertInboundTouch: (...a: unknown[]) => rcInsertInbound(...a),
}));

// No-show inbound: not handled, so we fall through to correlation.
vi.mock("@/lib/noshow/inbound", () => ({ handleNoshowInbound: vi.fn(async () => ({ handled: false })) }));

// Coordinator: no match.
vi.mock("@/lib/coordinator/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  insertInboundTouch: vi.fn(),
}));

// After-hours: closed=false so we skip capture entirely.
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: vi.fn(() => false),
  getSiteById: vi.fn(() => ({ id: "site-cc" })),
}));
vi.mock("@/lib/after-hours/repository", () => ({ insertCapture: vi.fn(), hasOpenCaptureFrom: vi.fn(async () => false) }));

// Suppression: not a STOP keyword, not suppressed.
vi.mock("@/lib/messaging/suppression", () => ({
  isStopKeyword: vi.fn(() => false),
  addSuppression: vi.fn(),
  isSuppressed: vi.fn(async () => false),
}));
vi.mock("@/lib/messaging/signature", () => ({ verifyTwilioSignature: vi.fn(() => true) }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(async () => undefined) }));

// Identity: unknown number so identity is null (isolates the cadence-correlation path).
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: vi.fn(async () => null) }));

// Agent: enabled, conversation plumbing stubbed, turn returns a benign reply.
vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: vi.fn(async () => ({ id: "conv-1", status: "active", patientName: "x", treatment: null, fundingType: null })),
  listMessages: vi.fn(async () => []),
  appendMessage: vi.fn(),
  setConversationStatus: vi.fn(),
  setConversationName: vi.fn(),
  stampInbound: vi.fn(),
  isAgentEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/agent/run", () => ({ runAgentTurn: vi.fn(async () => ({ replyText: "ok", toolCalls: [], escalated: false })) }));
vi.mock("@/lib/agent/prompt", () => ({ buildSystemPrompt: vi.fn(() => "sys") }));
vi.mock("@/lib/agent/tools", () => ({ AGENT_TOOLS: [], makeDispatch: vi.fn(() => vi.fn()) }));
vi.mock("@/lib/mock/clients", () => ({ getSite: vi.fn(() => ({ clientId: "vitality" })) }));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async () => []) }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {} }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

import { POST } from "@/app/api/webhooks/twilio/inbound/route";

function inbound(from: string, body: string): Request {
  const fd = new FormData();
  fd.set("From", from);
  fd.set("Body", body);
  return new Request("http://localhost/api/webhooks/twilio/inbound", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "");
  reFind.mockResolvedValue(null);
  reGetContext.mockResolvedValue(null);
  rcFind.mockResolvedValue(null);
});

describe("inbound handoff — reply correlated to a recall outbound", () => {
  it("logs an inbound recall touch and pauses the ACTIVE recall cadence", async () => {
    rcFind.mockResolvedValue({ targetId: "site-cc:p-9:dentist", siteId: "site-cc" });
    rcGetCadence.mockResolvedValue({ id: "cad-9", status: "active" });

    const res = await POST(inbound("+447700900123", "Yes please book me in"));
    expect(res.status).toBe(200);

    // Inbound touch logged against the recall target with the resolved cadence id.
    expect(rcInsertInbound).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "site-cc:p-9:dentist", cadenceId: "cad-9", body: "Yes please book me in" }),
    );
    // Automation paused so we stop chasing once the patient engages.
    expect(rcUpdateCadence).toHaveBeenCalledWith("cad-9", { status: "paused" });
    // Reactivation must NOT be touched for a recall-correlated reply.
    expect(reInsertInbound).not.toHaveBeenCalled();
    expect(reUpdateCadence).not.toHaveBeenCalled();
  });

  it("does not attempt to pause a cadence that is not active (already paused/converted)", async () => {
    rcFind.mockResolvedValue({ targetId: "site-cc:p-9:dentist", siteId: "site-cc" });
    rcGetCadence.mockResolvedValue({ id: "cad-9", status: "converted" });

    await POST(inbound("+447700900123", "thanks"));

    expect(rcInsertInbound).toHaveBeenCalled(); // still logged
    expect(rcUpdateCadence).not.toHaveBeenCalled(); // but no pause on a non-active cadence
  });

  it("a reactivation reply ALSO consults recall, so a dual-enrolled patient has both paused", async () => {
    reFind.mockResolvedValue({ targetId: "site-cc:p-9", siteId: "site-cc" });
    reGetCadence.mockResolvedValue({ id: "re-cad", status: "active" });
    // recall finds no target for this number in this scenario.

    await POST(inbound("+447700900123", "hello"));

    // Reactivation handles it; recall is now consulted on EVERY inbound (no longer
    // short-circuited by a reactivation match) so both cadences can pause. Here recall
    // finds nothing, so it logs no recall inbound touch.
    expect(reInsertInbound).toHaveBeenCalled();
    expect(rcFind).toHaveBeenCalled();
    expect(rcInsertInbound).not.toHaveBeenCalled();
  });
});
