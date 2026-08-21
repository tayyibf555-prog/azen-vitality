// AREA 3: Twilio webhooks must fail closed.
// Route-level tests for the inbound, status, and voice Twilio webhooks:
// - missing/invalid X-Twilio-Signature is rejected
// - missing TWILIO_AUTH_TOKEN in production fails CLOSED (403, no side-effects)
// - malformed payloads return 400, never an unhandled 500
// - STOP routes to suppression (by patient ref where known, by address otherwise)
// - inbound routing chain: noshow -> reactivation -> recall -> coordinator -> agent
// - webhook params cannot spoof another tenant/site
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeTwilioSignature } from "@/lib/messaging/signature";

// ---- module mocks (every DB/network seam the routes touch) ----
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));
vi.mock("@/lib/messaging/suppression", () => {
  const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
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
  updateOutboxStatusByMessageId: vi.fn(async () => {}),
}));
vi.mock("@/lib/recall/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  getCadenceByTarget: vi.fn(async () => null),
  updateCadence: vi.fn(async () => {}),
  insertInboundTouch: vi.fn(async () => {}),
  updateOutboxStatusByMessageId: vi.fn(async () => {}),
}));
vi.mock("@/lib/noshow/inbound", () => ({
  handleNoshowInbound: vi.fn(async () => ({ handled: false })),
}));
vi.mock("@/lib/noshow/repository", () => ({
  updateOutboxStatusByMessageId: vi.fn(async () => {}),
}));
vi.mock("@/lib/coordinator/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  insertInboundTouch: vi.fn(async () => {}),
  updateOutboxStatusByMessageId: vi.fn(async () => {}),
}));
vi.mock("@/lib/closer/repository", () => ({
  findTargetByAddress: vi.fn(async () => null),
  insertInboundTouch: vi.fn(async () => {}),
  stopOpportunity: vi.fn(async () => {}),
  updateOutboxStatusByMessageId: vi.fn(async () => {}),
}));
vi.mock("@/lib/reviews/repository", () => ({
  updateOutboxStatusByMessageId: vi.fn(async () => {}),
}));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  updateAttemptStatusByMessageId: vi.fn(async () => {}),
  // The voice route now bridges an after-hours missed call into speed-to-lead.
  // These are unused here (isOutsideHours is mocked false) but must exist so the
  // route's imports resolve.
  findOpenLeadByAddress: vi.fn(async () => null),
  insertLead: vi.fn(async () => ({ id: "lead-1", channel: "sms" })),
  claimLeadForContact: vi.fn(async () => true),
  releaseLeadClaim: vi.fn(async () => {}),
}));
// Mock the speed-to-lead contact module so the voice route's transitive import of
// it (which does `import "server-only"`) does not pull server-only into the test.
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: vi.fn(async () => {}) }));
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: vi.fn(() => false),
  getSiteById: vi.fn(() => ({ id: "site-cc" })),
}));
vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: vi.fn(async () => ({ id: "cap-1" })),
  hasOpenCaptureFrom: vi.fn(async () => false),
  markFollowUpSent: vi.fn(async () => {}),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class DentallyClient {} }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn(async () => {}) }));
vi.mock("@/lib/agent/prompt", () => ({ buildSystemPrompt: vi.fn(() => "sys") }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: vi.fn(() => ({ clientId: "client-1" })),
  getSites: vi.fn(() => [{ id: "site-cc" }]),
}));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: vi.fn(async () => []) }));
vi.mock("@/lib/agent/tools", () => ({ AGENT_TOOLS: [], makeDispatch: vi.fn(() => vi.fn()) }));
vi.mock("@/lib/agent/run", () => ({
  runAgentTurn: vi.fn(async () => ({ replyText: "Agent reply", toolCalls: [], escalated: false })),
}));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: vi.fn(async () => null) }));
vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: vi.fn(async () => ({
    id: "conv-1",
    status: "active",
    patientName: "Unknown 0123",
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

import { POST as inboundPOST } from "./inbound/route";
import { POST as statusPOST } from "./status/route";
import { POST as voicePOST } from "./voice/route";
import { addSuppression, isSuppressed } from "@/lib/messaging/suppression";
import * as reactivationRepo from "@/lib/reactivation/repository";
import * as recallRepo from "@/lib/recall/repository";
import * as coordinatorRepo from "@/lib/coordinator/repository";
import * as noshowRepo from "@/lib/noshow/repository";
import * as closerRepo from "@/lib/closer/repository";
import * as reviewsRepo from "@/lib/reviews/repository";
import * as stlRepo from "@/lib/speed-to-lead/repository";
import { handleNoshowInbound } from "@/lib/noshow/inbound";
import { sendMessage } from "@/lib/messaging/send";
import { runAgentTurn } from "@/lib/agent/run";
import { setConversationStatus, appendMessage } from "@/lib/agent/repository";

const TOKEN = "test-auth-token";
const BASE = "http://localhost:3000";
const INBOUND_URL = `${BASE}/api/webhooks/twilio/inbound`;
const STATUS_URL = `${BASE}/api/webhooks/twilio/status`;
const VOICE_URL = `${BASE}/api/webhooks/twilio/voice`;

function formRequest(url: string, params: Record<string, string>, sig?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (sig !== undefined) headers["x-twilio-signature"] = sig;
  return new Request(url, { method: "POST", body: new URLSearchParams(params), headers });
}

function signed(url: string, params: Record<string, string>): Request {
  return formRequest(url, params, computeTwilioSignature(url, params, TOKEN));
}

function malformed(url: string): Request {
  // A scanner / attacker POSTing JSON: formData() cannot parse this body.
  return new Request(url, {
    method: "POST",
    body: '{"not":"a form"}',
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Signature enforcement + fail-closed env
// ---------------------------------------------------------------------------
describe("inbound webhook: signature enforcement", () => {
  it("rejects a missing signature with 403 and no side-effects", async () => {
    const res = await inboundPOST(formRequest(INBOUND_URL, { From: "+447700900123", Body: "hi" }));
    expect(res.status).toBe(403);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature with 403", async () => {
    const res = await inboundPOST(
      formRequest(INBOUND_URL, { From: "+447700900123", Body: "hi" }, "AAAAAAAAAAAAAAAAAAAAAAAAAAA="),
    );
    expect(res.status).toBe(403);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("rejects a signature valid for a DIFFERENT route URL (replay across endpoints)", async () => {
    const params = { From: "+447700900123", Body: "hi" };
    const sigForVoice = computeTwilioSignature(VOICE_URL, params, TOKEN);
    const res = await inboundPOST(formRequest(INBOUND_URL, params, sigForVoice));
    expect(res.status).toBe(403);
  });

  it("rejects a signature computed with a tampered param set", async () => {
    const params = { From: "+447700900123", Body: "hi" };
    const sig = computeTwilioSignature(INBOUND_URL, params, TOKEN);
    const res = await inboundPOST(
      formRequest(INBOUND_URL, { ...params, Body: "hi ATTACKER" }, sig),
    );
    expect(res.status).toBe(403);
  });

  it("fails CLOSED in production when TWILIO_AUTH_TOKEN is missing", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await inboundPOST(formRequest(INBOUND_URL, { From: "+447700900123", Body: "STOP" }));
    expect(res.status).toBe(403);
    // Crucially: the STOP was NOT processed and nothing was sent.
    expect(addSuppression).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed request", async () => {
    const res = await inboundPOST(signed(INBOUND_URL, { From: "+447700900123", Body: "hi" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
  });
});

describe("status webhook: signature enforcement", () => {
  it("rejects a missing signature with 403 and updates nothing", async () => {
    const res = await statusPOST(
      formRequest(STATUS_URL, { MessageSid: "SM123", MessageStatus: "delivered" }),
    );
    expect(res.status).toBe(403);
    expect(reactivationRepo.updateOutboxStatusByMessageId).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature with 403", async () => {
    const res = await statusPOST(
      formRequest(STATUS_URL, { MessageSid: "SM123", MessageStatus: "delivered" }, "bad-sig"),
    );
    expect(res.status).toBe(403);
    expect(noshowRepo.updateOutboxStatusByMessageId).not.toHaveBeenCalled();
  });

  it("fails CLOSED in production when TWILIO_AUTH_TOKEN is missing", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await statusPOST(
      formRequest(STATUS_URL, { MessageSid: "SM123", MessageStatus: "delivered" }),
    );
    expect(res.status).toBe(403);
    expect(reactivationRepo.updateOutboxStatusByMessageId).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed callback and fans the status out to every outbox", async () => {
    const res = await statusPOST(signed(STATUS_URL, { MessageSid: "SM123", MessageStatus: "delivered" }));
    expect(res.status).toBe(204);
    for (const fn of [
      reactivationRepo.updateOutboxStatusByMessageId,
      recallRepo.updateOutboxStatusByMessageId,
      noshowRepo.updateOutboxStatusByMessageId,
      coordinatorRepo.updateOutboxStatusByMessageId,
      closerRepo.updateOutboxStatusByMessageId,
      reviewsRepo.updateOutboxStatusByMessageId,
    ]) {
      expect(fn).toHaveBeenCalledWith("SM123", "delivered");
    }
    expect(stlRepo.updateAttemptStatusByMessageId).toHaveBeenCalledWith("SM123", "delivered");
  });

  it("maps failed/undelivered to failed and other statuses to sent", async () => {
    await statusPOST(signed(STATUS_URL, { MessageSid: "SM1", MessageStatus: "undelivered" }));
    expect(recallRepo.updateOutboxStatusByMessageId).toHaveBeenCalledWith("SM1", "failed");
    await statusPOST(signed(STATUS_URL, { MessageSid: "SM2", MessageStatus: "queued" }));
    expect(recallRepo.updateOutboxStatusByMessageId).toHaveBeenCalledWith("SM2", "sent");
  });

  it("maps the WhatsApp 'read' status to delivered, never downgrading to sent", async () => {
    // WhatsApp delivers a 'read' callback AFTER 'delivered'. It must map to
    // 'delivered' (or higher), never regress the row back to 'sent'.
    const res = await statusPOST(signed(STATUS_URL, { MessageSid: "SM3", MessageStatus: "read" }));
    expect(res.status).toBe(204);
    for (const fn of [
      reactivationRepo.updateOutboxStatusByMessageId,
      recallRepo.updateOutboxStatusByMessageId,
      noshowRepo.updateOutboxStatusByMessageId,
      coordinatorRepo.updateOutboxStatusByMessageId,
      closerRepo.updateOutboxStatusByMessageId,
      reviewsRepo.updateOutboxStatusByMessageId,
    ]) {
      expect(fn).toHaveBeenCalledWith("SM3", "delivered");
      expect(fn).not.toHaveBeenCalledWith("SM3", "sent");
    }
    expect(stlRepo.updateAttemptStatusByMessageId).toHaveBeenCalledWith("SM3", "delivered");
  });

  it("ignores an unrecognised status entirely so it can never regress a delivered row", async () => {
    const res = await statusPOST(
      signed(STATUS_URL, { MessageSid: "SM4", MessageStatus: "some_future_status" }),
    );
    expect(res.status).toBe(204);
    expect(reactivationRepo.updateOutboxStatusByMessageId).not.toHaveBeenCalled();
    expect(recallRepo.updateOutboxStatusByMessageId).not.toHaveBeenCalled();
    expect(stlRepo.updateAttemptStatusByMessageId).not.toHaveBeenCalled();
  });

  it("ignores a signed callback with no MessageSid", async () => {
    const res = await statusPOST(signed(STATUS_URL, { MessageStatus: "delivered" }));
    expect(res.status).toBe(204);
    expect(reactivationRepo.updateOutboxStatusByMessageId).not.toHaveBeenCalled();
  });
});

describe("voice webhook: signature enforcement", () => {
  it("fails CLOSED in production when TWILIO_AUTH_TOKEN is missing", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await voicePOST(formRequest(VOICE_URL, { From: "+447700900123" }));
    expect(res.status).toBe(403);
  });

  it("rejects an invalid signature with 403", async () => {
    const res = await voicePOST(formRequest(VOICE_URL, { From: "+447700900123" }, "nope"));
    expect(res.status).toBe(403);
  });

  it("answers a correctly signed call with TwiML", async () => {
    const res = await voicePOST(signed(VOICE_URL, { From: "+447700900123" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Say>");
  });
});

// ---------------------------------------------------------------------------
// Malformed payloads must not 500
// ---------------------------------------------------------------------------
describe("malformed payloads", () => {
  it("inbound: a non-form body returns a 4xx, not an unhandled throw", async () => {
    const res = await inboundPOST(malformed(INBOUND_URL));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("status: a non-form body returns a 4xx, not an unhandled throw", async () => {
    const res = await statusPOST(malformed(STATUS_URL));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("voice: a non-form body still answers the call leg with TwiML", async () => {
    const res = await voicePOST(malformed(VOICE_URL));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Say>");
  });

  it("inbound: a signed request with no From is a safe no-op TwiML", async () => {
    const res = await inboundPOST(signed(INBOUND_URL, { Body: "hi" }));
    expect(res.status).toBe(200);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// STOP handling -> suppression
// ---------------------------------------------------------------------------
describe("inbound STOP handling", () => {
  it("suppresses an unknown number by address on the channel used, and never replies", async () => {
    const res = await inboundPOST(signed(INBOUND_URL, { From: "+447700900123", Body: "STOP" }));
    expect(res.status).toBe(200);
    expect(addSuppression).toHaveBeenCalledWith("site-cc", "sms", "+447700900123", "stop");
    // One STOP covers BOTH phone channels: the same number receives SMS and WhatsApp.
    expect(addSuppression).toHaveBeenCalledWith("site-cc", "whatsapp", "+447700900123", "stop");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("suppresses a reactivation target by patient ref under the target's own site", async () => {
    vi.mocked(reactivationRepo.findTargetByAddress).mockResolvedValueOnce({
      targetId: "patient:789",
      siteId: "site-a",
    } as never);
    await inboundPOST(signed(INBOUND_URL, { From: "+447700900456", Body: "stop" }));
    expect(addSuppression).toHaveBeenCalledWith("site-a", "sms", "patient:789", "stop");
    // The ADDRESS is suppressed too, so the same person arriving later through a
    // public form (no patient id on the lead) is still blocked.
    expect(addSuppression).toHaveBeenCalledWith("site-a", "sms", "+447700900456", "stop");
  });

  it("uses the whatsapp channel when the STOP arrives via WhatsApp", async () => {
    await inboundPOST(signed(INBOUND_URL, { From: "whatsapp:+447700900123", Body: "STOP" }));
    expect(addSuppression).toHaveBeenCalledWith("site-cc", "whatsapp", "+447700900123", "stop");
  });

  it("attacker-controlled params cannot pick the suppression tenant (site spoofing)", async () => {
    // Even a validly signed payload carrying siteId/SiteId/AccountSid fields must
    // not steer the site attribution: the site comes from server-side lookups only.
    await inboundPOST(
      signed(INBOUND_URL, {
        From: "+447700900123",
        Body: "STOP",
        siteId: "site-evil",
        SiteId: "site-evil",
        AccountSid: "ACevil",
      }),
    );
    expect(addSuppression).toHaveBeenCalledWith("site-cc", "sms", "+447700900123", "stop");
  });

  it("a suppressed number never gets an automated agent reply (opt-out gate)", async () => {
    vi.mocked(isSuppressed).mockResolvedValue(true as never);
    const res = await inboundPOST(signed(INBOUND_URL, { From: "+447700900123", Body: "hello" }));
    expect(res.status).toBe(200);
    expect(setConversationStatus).toHaveBeenCalledWith("conv-1", "needs_human");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    vi.mocked(isSuppressed).mockResolvedValue(false as never);
  });
});

// ---------------------------------------------------------------------------
// Inbound routing chain: noshow -> reactivation -> recall -> coordinator -> agent
// ---------------------------------------------------------------------------
describe("inbound routing chain", () => {
  it("a structured no-show reply short-circuits before the agent", async () => {
    vi.mocked(handleNoshowInbound).mockResolvedValueOnce({ handled: true, reply: "Confirmed, see you then." });
    const res = await inboundPOST(signed(INBOUND_URL, { From: "+447700900123", Body: "YES" }));
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "sms",
      to: "+447700900123",
      body: "Confirmed, see you then.",
    });
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(reactivationRepo.findTargetByAddress).not.toHaveBeenCalled();
  });

  it("a reactivation target logs an inbound touch and pauses its active cadence", async () => {
    vi.mocked(reactivationRepo.findTargetByAddress).mockResolvedValueOnce({
      targetId: "patient:789",
      siteId: "site-a",
    } as never);
    vi.mocked(reactivationRepo.getCadenceByTarget).mockResolvedValueOnce({
      id: "cad-1",
      status: "active",
    } as never);
    await inboundPOST(signed(INBOUND_URL, { From: "+447700900456", Body: "Tell me more" }));
    expect(reactivationRepo.insertInboundTouch).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "patient:789", cadenceId: "cad-1", siteId: "site-a", channel: "sms" }),
    );
    expect(reactivationRepo.updateCadence).toHaveBeenCalledWith("cad-1", { status: "paused" });
    // Recall is now checked on EVERY inbound (so a patient in both cadences has both
    // paused); here recall finds nothing, so only the reactivation cadence pauses.
    expect(recallRepo.findTargetByAddress).toHaveBeenCalled();
    expect(recallRepo.updateCadence).not.toHaveBeenCalled();
  });

  it("pauses BOTH cadences when a number is enrolled in reactivation AND recall", async () => {
    vi.mocked(reactivationRepo.findTargetByAddress).mockResolvedValueOnce({ targetId: "patient:999", siteId: "site-a" } as never);
    vi.mocked(reactivationRepo.getCadenceByTarget).mockResolvedValueOnce({ id: "cad-x", status: "active" } as never);
    vi.mocked(recallRepo.findTargetByAddress).mockResolvedValueOnce({ targetId: "patient:999", siteId: "site-a" } as never);
    vi.mocked(recallRepo.getCadenceByTarget).mockResolvedValueOnce({ id: "rcad-x", status: "active" } as never);
    await inboundPOST(signed(INBOUND_URL, { From: "+447700900999", Body: "Sorry, been busy" }));
    // The fix: BOTH pause, not just the first match, so neither sweep keeps chasing.
    expect(reactivationRepo.updateCadence).toHaveBeenCalledWith("cad-x", { status: "paused" });
    expect(recallRepo.updateCadence).toHaveBeenCalledWith("rcad-x", { status: "paused" });
  });

  it("falls back to recall when reactivation misses", async () => {
    vi.mocked(recallRepo.findTargetByAddress).mockResolvedValueOnce({
      targetId: "patient:456",
      siteId: "site-b",
    } as never);
    vi.mocked(recallRepo.getCadenceByTarget).mockResolvedValueOnce({
      id: "rcad-1",
      status: "active",
    } as never);
    await inboundPOST(signed(INBOUND_URL, { From: "+447700900789", Body: "When am I due?" }));
    expect(recallRepo.insertInboundTouch).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "patient:456", cadenceId: "rcad-1", siteId: "site-b" }),
    );
    expect(recallRepo.updateCadence).toHaveBeenCalledWith("rcad-1", { status: "paused" });
    // The coordinator is now also checked on every inbound; here it finds nothing.
    expect(coordinatorRepo.findTargetByAddress).toHaveBeenCalled();
  });

  it("falls back to the coordinator when reactivation and recall both miss", async () => {
    vi.mocked(coordinatorRepo.findTargetByAddress).mockResolvedValueOnce({
      opportunityId: "opp-1",
      siteId: "site-c",
    } as never);
    await inboundPOST(signed(INBOUND_URL, { From: "+447700900321", Body: "About that quote" }));
    expect(coordinatorRepo.insertInboundTouch).toHaveBeenCalledWith(
      expect.objectContaining({ opportunityId: "opp-1", siteId: "site-c" }),
    );
  });

  it("an unmatched free-text inbound reaches the agent and the reply is sent + logged", async () => {
    const res = await inboundPOST(signed(INBOUND_URL, { From: "+447700900123", Body: "I'd like to book" }));
    expect(res.status).toBe(200);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ channel: "sms", to: "+447700900123", body: "Agent reply" });
    // Both the patient message and the agent reply are persisted.
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", role: "patient", body: "I'd like to book" }),
    );
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", role: "agent", body: "Agent reply" }),
    );
  });

  it("an agent failure hands over to a human with a fallback message, never a 500", async () => {
    vi.mocked(runAgentTurn).mockRejectedValueOnce(new Error("model down"));
    const res = await inboundPOST(signed(INBOUND_URL, { From: "+447700900123", Body: "hello" }));
    expect(res.status).toBe(200);
    expect(setConversationStatus).toHaveBeenCalledWith("conv-1", "needs_human");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Thanks, a member of our team will be in touch shortly." }),
    );
  });
});
