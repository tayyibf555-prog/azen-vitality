import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE MISSED-CALL CALLBACK TEXT, ON THE CALLER'S RECORD.
 *
 * Somebody rings the practice, nobody picks up, and the platform texts them back.
 * That text used to exist in Twilio's logs and nowhere else: the voice webhook has
 * no outbox, writes no `*_touch` row, and returns before any conversation store is
 * touched. A patient could ring three times in a week, be texted three times, and
 * their Correspondence tab would show an empty history under a heading claiming to
 * hold every message this platform has sent them.
 *
 * These tests drive the real route and read the record back with the real
 * `getThreadForPatient`. Only Postgres, Twilio and the Dentally lookup are faked.
 */

const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const identifyByPhone = vi.fn();
const markFollowUpSent = vi.fn();

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));
vi.mock("@/lib/messaging/signature", () => ({ verifyTwilioSignature: () => true }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: (...a: unknown[]) => identifyByPhone(...a) }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {} }));
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: vi.fn(async () => {}) }));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  findOpenLeadByAddress: vi.fn(async () => null),
  insertLead: vi.fn(async () => ({ id: "lead-1", channel: "sms" })),
  claimLeadForContact: vi.fn(async () => true),
  releaseLeadClaim: vi.fn(async () => {}),
}));
vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: vi.fn(async () => ({ id: "cap-1" })),
  markFollowUpSent: (...a: unknown[]) => markFollowUpSent(...a),
  hasOpenCaptureFrom: vi.fn(async () => false),
}));
// IN HOURS: this is the overflow-callback branch, the simplest of the two paths
// through the single sendCallbackSms the route uses. Both callers share it, so
// covering one covers the send path for both.
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: () => false,
  getSiteById: () => null,
}));

vi.mock("@/lib/supabase/server", async () => {
  const mod = await import("@/lib/inbox/test-support/agent-store-fake");
  return { serviceClient: () => mod.serviceClientFake() };
});

/**
 * A recorder that BREAKS ITS CONTRACT, for the tests at the foot of this file.
 *
 * This route already guards its recorder call with a `.catch()`; the other three
 * recorded sites did not, and were only safe because of a promise in a comment.
 * The guard is now uniform, and pinned everywhere rather than trusted anywhere: a
 * 500 here is a Twilio retry, which on a VOICE webhook means a second capture row
 * and a second callback text to somebody who rang once. Off by default.
 */
const recorderThrows = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/inbox/record-outbound", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/inbox/record-outbound")>();
  return {
    ...real,
    recordOutbound: async (input: Parameters<typeof real.recordOutbound>[0]) => {
      if (recorderThrows.on) throw new Error("recordOutbound broke its never-throws contract");
      return real.recordOutbound(input);
    },
  };
});

import { agentStore, resetAgentStore, rowsIn } from "@/lib/inbox/test-support/agent-store-fake";
import { POST } from "./route";
import { getThreadForPatient } from "@/lib/inbox/repository";

const FROM = "+447700900456";
// The route attributes an inbound call to AGENT_DEFAULT_SITE_ID, defaulting to site-cc.
const SITE = "site-cc";

function call(): Request {
  const form = new FormData();
  form.set("From", FROM);
  return new Request("http://localhost/api/webhooks/twilio/voice", { method: "POST", body: form });
}

const KNOWN = {
  patientId: "pat-77",
  siteId: SITE,
  patientName: "Marcus Byrne",
  treatment: null,
  fundingType: null,
  lastVisitAt: null,
  recallDueAt: null,
  source: "directory" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentStore();
  recorderThrows.on = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  isSuppressed.mockResolvedValue(false);
  identifyByPhone.mockResolvedValue(null);
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
});

describe("the callback text reaches the caller's record", () => {
  it("appears on an identified patient's timeline, outbound, with the words that were sent", async () => {
    identifyByPhone.mockResolvedValue(KNOWN);
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const sentBody = String(sendMessage.mock.calls[0][0].body);
    const read = await getThreadForPatient([SITE], KNOWN.patientId);
    const messages = read.thread?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe(sentBody);
    expect(messages[0].direction).toBe("outbound");
    expect(messages[0].channel).toBe("sms");
    expect(read.thread?.contactRef).toBe(`patient:${KNOWN.patientId}`);
  });

  it("threads an UNIDENTIFIED caller under lead:<number>, the key the SMS webhook uses", async () => {
    // Not cosmetic: if they text back, the inbound webhook keys them `lead:<from>`.
    // A different key here would fork the thread and the callback text would sit on
    // a conversation nothing ever reads again.
    const res = await POST(call());
    expect(res.status).toBe(200);
    const convs = rowsIn("agent_conversation");
    expect(convs).toHaveLength(1);
    expect(convs[0].dentally_patient_id).toBe(`lead:${FROM}`);
  });

  it("writes nothing when no text went out", async () => {
    // A suppressed caller is captured for a manual callback and never texted, so
    // there is nothing to put on a record.
    isSuppressed.mockResolvedValue(true);
    await POST(call());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(rowsIn("agent_message")).toHaveLength(0);
  });

  it("writes nothing when the send FAILED, so the record never shows an unsent message", async () => {
    sendMessage.mockRejectedValue(new Error("twilio down"));
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(rowsIn("agent_message")).toHaveLength(0);
  });
});

describe("recording failure never touches the call leg or the text", () => {
  it("still answers the caller, and does not text them twice", async () => {
    identifyByPhone.mockResolvedValue(KNOWN);
    agentStore.failTables.add("agent_message");
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Response>");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(rowsIn("agent_message")).toHaveLength(0);
  });

  it("still promises the text in the spoken line, because the text really did go", async () => {
    // The failure mode this guards: making the caller hear "we could not send you a
    // text" because a database write failed after the text had already left.
    identifyByPhone.mockResolvedValue(KNOWN);
    agentStore.failTables.add("agent_conversation");
    const withFailure = await (await POST(call())).text();

    resetAgentStore();
    vi.clearAllMocks();
    identifyByPhone.mockResolvedValue(KNOWN);
    isSuppressed.mockResolvedValue(false);
    sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
    const healthy = await (await POST(call())).text();

    expect(withFailure).toBe(healthy);
    expect(markFollowUpSent).toHaveBeenCalledWith("cap-1");
  });
});

describe("a recorder that throws cannot 500 this webhook", () => {
  it("still answers the call leg with TwiML, and does not text the caller twice", async () => {
    identifyByPhone.mockResolvedValue(KNOWN);
    recorderThrows.on = true;
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Response>");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("says the same words to the caller as a healthy run does", async () => {
    // The spoken line promises the text. A recorder failure must not be able to
    // change what the caller hears, because the text really did go.
    identifyByPhone.mockResolvedValue(KNOWN);
    recorderThrows.on = true;
    const withThrow = await (await POST(call())).text();

    resetAgentStore();
    vi.clearAllMocks();
    recorderThrows.on = false;
    identifyByPhone.mockResolvedValue(KNOWN);
    isSuppressed.mockResolvedValue(false);
    sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
    const healthy = await (await POST(call())).text();

    expect(withThrow).toBe(healthy);
  });
});
