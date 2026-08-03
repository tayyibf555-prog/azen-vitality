import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkAgentReply } from "@/lib/agent/guardrail";

// ---------------------------------------------------------------------------
// AREA 11+12 deep test: after-hours capture of a missed CALL.
//
// A missed call must (1) always be logged to the worklist without loss,
// (2) trigger a consent-aware SMS follow-up ONLY when outside hours AND the
// number is not suppressed, (3) dedupe so a repeat dialler cannot flood the
// worklist or rack up SMS spend, and (4) never put NHS/private/funding wording
// in the spoken or texted copy.
//
// The webhook swallows send errors and returns TwiML, so we assert on the
// repository/messaging spies rather than the HTTP body alone.
// ---------------------------------------------------------------------------

const insertCapture = vi.fn(async (..._a: unknown[]) => ({ id: "cap-1" }));
const markFollowUpSent = vi.fn(async (..._a: unknown[]) => undefined);
let openCapture = false;
const hasOpenCaptureFrom = vi.fn(async (..._a: unknown[]) => openCapture);

// The routes under test consult the kill switch on every send path (fail-closed
// once messaging is live); these tests default to everything ON, and flip
// `systemOn` where the switch itself is what is under test.
let systemOn = true;
const systemEnabledForSend = vi.fn(async (..._a: unknown[]) => systemOn);
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: (...a: unknown[]) => systemEnabledForSend(...a),
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
}));

vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: (...a: unknown[]) => insertCapture(...a),
  markFollowUpSent: (...a: unknown[]) => markFollowUpSent(...a),
  hasOpenCaptureFrom: (...a: unknown[]) => hasOpenCaptureFrom(...a),
}));

let outside = true;
const isOutsideHours = vi.fn((..._a: unknown[]) => outside);
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: (...a: unknown[]) => isOutsideHours(...a),
  getSiteById: () => ({ id: "site-cc", timezone: "Europe/London", openingHours: {} }),
}));

const sendMessage = vi.fn(async (..._a: unknown[]) => ({
  provider: "dry-run",
  providerMessageId: "dry-1",
  status: "dry_run",
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));

let suppressed = false;
const isSuppressed = vi.fn(async (..._a: unknown[]) => suppressed);
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));

// Speed-to-lead bridge: a missed call after hours is routed into the pipeline
// (insertLead + claim + contactLead) rather than firing a bare SMS. Defaults:
// no existing open lead (so a new one is created + contacted), the claim wins,
// and contactLead succeeds. Individual tests override to exercise dedup + fallback.
let openLead: { id: string } | null = null;
const findOpenLeadByAddress = vi.fn(async (..._a: unknown[]) => openLead);
const insertLead = vi.fn(async (..._a: unknown[]) => ({ id: "lead-1", channel: "sms" }));
let claimWins = true;
const claimLeadForContact = vi.fn(async (..._a: unknown[]) => claimWins);
const releaseLeadClaim = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/speed-to-lead/repository", () => ({
  findOpenLeadByAddress: (...a: unknown[]) => findOpenLeadByAddress(...a),
  insertLead: (...a: unknown[]) => insertLead(...a),
  claimLeadForContact: (...a: unknown[]) => claimLeadForContact(...a),
  releaseLeadClaim: (...a: unknown[]) => releaseLeadClaim(...a),
}));

let contactThrows = false;
const contactLead = vi.fn(async (..._a: unknown[]) => {
  if (contactThrows) throw new Error("contact failed");
});
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: (...a: unknown[]) => contactLead(...a) }));

// No signature verification path in test (TWILIO_AUTH_TOKEN unset, not production).
vi.mock("@/lib/messaging/signature", () => ({ verifyTwilioSignature: () => true }));

// Identity resolution: default to unrecognised so the masked label path runs.
let identity: { patientId: string; patientName: string } | null = null;
vi.mock("@/lib/agent/identify", () => ({
  identifyByPhone: vi.fn(async () => identity),
}));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {} }));

import { POST } from "./route";

function callFrom(number: string): Request {
  const fd = new FormData();
  fd.set("From", number);
  fd.set("CallSid", "CA123");
  return new Request("https://x/api/webhooks/twilio/voice", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  outside = true;
  openCapture = false;
  suppressed = false;
  systemOn = true;
  identity = null;
  openLead = null;
  claimWins = true;
  contactThrows = false;
});

describe("after-hours voice — capture without loss", () => {
  it("logs a missed call inside opening hours (overflow) and texts a callback", async () => {
    outside = false;
    const res = await POST(callFrom("+447700900123"));
    const body = await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1);
    // An in-hours overflow call used to be told "please hold" and hung up on: no
    // text, no lead, no SLA. It now gets exactly one callback text, on the SAME
    // send path as the after-hours fallback.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // ...and NOT the speed-to-lead bridge: the practice is open and about to ring
    // this person back, so an AI opener would talk across the callback.
    expect(insertLead).not.toHaveBeenCalled();
    expect(contactLead).not.toHaveBeenCalled();
    expect(body).not.toContain("please hold"); // the TwiML hangs up immediately after
    expect(body).toContain("just sent you a text");
    // The (channel: "call") capture carries no message body.
    expect((insertCapture.mock.calls[0][0] as { channel: string }).channel).toBe("call");
    // The in-hours text promises a callback, not opening hours, and never says
    // the practice is closed (it is not).
    const smsBody = (sendMessage.mock.calls[0][0] as { body: string }).body;
    expect(smsBody).toContain("call you back");
    expect(smsBody).not.toContain("closed");
    expect(checkAgentReply(smsBody).ok).toBe(true);
  });

  it("outside hours: routes a NEW number into speed-to-lead (lead + contact), marks it sent", async () => {
    const res = await POST(callFrom("+447700900123"));
    await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1);
    // Primary path now bridges into speed-to-lead: create the lead, claim it, and
    // fire the AI-drafted first contact — NOT the bare fixed SMS.
    expect(insertLead).toHaveBeenCalledTimes(1);
    expect(claimLeadForContact).toHaveBeenCalledTimes(1);
    expect(contactLead).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled(); // no bare fallback SMS on the happy path
    expect(markFollowUpSent).toHaveBeenCalledTimes(1);
    // The lead carries the resolved number, the sms channel, and sms consent.
    const leadArg = insertLead.mock.calls[0][0] as {
      phone: string;
      channel: string;
      source: string;
      consent: { sms: boolean };
    };
    expect(leadArg.phone).toBe("+447700900123");
    expect(leadArg.channel).toBe("sms");
    expect(leadArg.source).toBe("missed-call");
    expect(leadArg.consent.sms).toBe(true);
  });
});

describe("after-hours voice — speed-to-lead bridge", () => {
  it("passes the resolved patientId + name onto the lead for an identified caller", async () => {
    identity = { patientId: "42", patientName: "Sarah L" };
    await POST(callFrom("+447700900123")).then((r) => r.text());

    expect(insertLead).toHaveBeenCalledTimes(1);
    const leadArg = insertLead.mock.calls[0][0] as { dentallyPatientId: string | null; name: string };
    expect(leadArg.dentallyPatientId).toBe("42");
    expect(leadArg.name).toBe("Sarah L");
  });

  it("dedup: an existing open lead for this number is NOT contacted again", async () => {
    openLead = { id: "existing-lead" }; // findOpenLeadByAddress returns a match
    const res = await POST(callFrom("+447700900123"));
    const body = await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1); // the call is still logged
    expect(findOpenLeadByAddress).toHaveBeenCalledTimes(1);
    expect(insertLead).not.toHaveBeenCalled(); // no second lead
    expect(contactLead).not.toHaveBeenCalled(); // no double first-contact
    expect(sendMessage).not.toHaveBeenCalled(); // no bare fallback either
    expect(markFollowUpSent).not.toHaveBeenCalled();
    expect(body).toContain("Vitality Dental");
  });

  it("fallback: the bridge failing falls back to the bare SMS, and marks it sent", async () => {
    contactThrows = true; // contactLead throws -> the whole bridge rejects
    const res = await POST(callFrom("+447700900123"));
    await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1);
    expect(contactLead).toHaveBeenCalledTimes(1); // bridge tried the AI contact
    // ...and on its failure fell back to the bare fixed SMS so the missed call is
    // never silently dropped.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markFollowUpSent).toHaveBeenCalledTimes(1);
    const smsBody = (sendMessage.mock.calls[0][0] as { body: string }).body;
    // Copy compliance on the fallback text: no NHS/private/funding wording.
    expect(checkAgentReply(smsBody).ok).toBe(true);
    expect(smsBody.toLowerCase()).not.toContain("nhs");
  });
});

describe("after-hours voice — consent / suppression awareness", () => {
  it("does NOT text a suppressed number, but still logs the call for a callback", async () => {
    suppressed = true;
    const res = await POST(callFrom("+447700900123"));
    await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1); // still captured
    expect(sendMessage).not.toHaveBeenCalled(); // suppressed -> no SMS
    expect(markFollowUpSent).not.toHaveBeenCalled();
  });

  it("checks BOTH address and patient:<id> suppression forms for an identified caller", async () => {
    identity = { patientId: "42", patientName: "Sarah L" };
    suppressed = false;
    await POST(callFrom("+447700900123")).then((r) => r.text());
    // Two suppression checks: by raw number and by patient:42.
    const refs = isSuppressed.mock.calls.map((c) => c[2]);
    expect(refs).toContain("+447700900123");
    expect(refs).toContain("patient:42");
  });
});

describe("after-hours voice — in-hours overflow callback", () => {
  it("an identified caller in hours: capture carries the patient id, and EXACTLY one send", async () => {
    outside = false;
    identity = { patientId: "42", patientName: "Sarah L" };
    const res = await POST(callFrom("+447700900123"));
    await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1);
    const capture = insertCapture.mock.calls[0][0] as {
      dentallyPatientId: string | null;
      patientName: string;
    };
    // The id the task queue needs to put this callback on the patient's record.
    expect(capture.dentallyPatientId).toBe("42");
    expect(capture.patientName).toBe("Sarah L");

    // ONE send, on the shared path. A second call site here is how the
    // double-text bug returns, so the count is the assertion.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(insertLead).not.toHaveBeenCalled();
    expect(markFollowUpSent).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0][0] as { channel: string; to: string };
    expect(sent.channel).toBe("sms");
    expect(sent.to).toBe("+447700900123");
  });

  it("in hours + suppressed: still captured, and ZERO sends", async () => {
    outside = false;
    suppressed = true;
    const res = await POST(callFrom("+447700900123"));
    const body = await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1); // an opt-out refuses texts, not a callback
    expect(sendMessage).not.toHaveBeenCalled();
    expect(insertLead).not.toHaveBeenCalled();
    expect(markFollowUpSent).not.toHaveBeenCalled();
    // ...and the caller is not told a text is coming.
    expect(body).not.toContain("sent you a text");
  });

  it("in hours + kill switch OFF: still captured, and ZERO sends", async () => {
    outside = false;
    systemOn = false;
    const res = await POST(callFrom("+447700900123"));
    const body = await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(body).not.toContain("sent you a text");
  });

  it("in hours, the send failing leaves the caller promised nothing", async () => {
    outside = false;
    sendMessage.mockRejectedValueOnce(new Error("provider down"));
    const res = await POST(callFrom("+447700900123"));
    const body = await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markFollowUpSent).not.toHaveBeenCalled();
    expect(body).not.toContain("sent you a text");
  });

  it("a withheld caller ID in hours is captured and flagged, never texted", async () => {
    outside = false;
    const res = await POST(callFrom("anonymous"));
    const body = await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1);
    expect((insertCapture.mock.calls[0][0] as { patientName: string }).patientName).toBe(
      "Caller ID withheld",
    );
    expect(sendMessage).not.toHaveBeenCalled(); // nowhere to send it
    expect(body).not.toContain("sent you a text");
  });
});

describe("after-hours voice — dedup (no flooding)", () => {
  it("a repeat call within the window neither re-captures nor re-texts", async () => {
    openCapture = true; // hasOpenCaptureFrom returns true
    const res = await POST(callFrom("+447700900123"));
    const body = await res.text();

    expect(insertCapture).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(body).toContain("already texted you");
  });
});

describe("after-hours voice — spoken TwiML copy compliance", () => {
  it("the spoken closed-hours message carries no NHS/private/funding wording", async () => {
    const res = await POST(callFrom("+447700900123"));
    const body = await res.text();
    // Strip TwiML tags and assert on the spoken text.
    const spoken = body.replace(/<[^>]+>/g, " ");
    expect(spoken.toLowerCase()).not.toContain("nhs");
    expect(spoken.toLowerCase()).not.toContain("private");
    expect(checkAgentReply(spoken).ok).toBe(true);
  });
});
