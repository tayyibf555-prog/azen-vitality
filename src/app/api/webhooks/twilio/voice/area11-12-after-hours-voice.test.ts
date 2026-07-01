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
  identity = null;
});

describe("after-hours voice — capture without loss", () => {
  it("logs a missed call even inside opening hours (overflow), no follow-up SMS", async () => {
    outside = false;
    const res = await POST(callFrom("+447700900123"));
    const body = await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled(); // no after-hours text inside hours
    expect(body).toContain("please hold");
    // The (channel: "call") capture carries no message body.
    expect((insertCapture.mock.calls[0][0] as { channel: string }).channel).toBe("call");
  });

  it("outside hours: captures AND sends a consent-aware follow-up, marks it sent", async () => {
    const res = await POST(callFrom("+447700900123"));
    await res.text();

    expect(insertCapture).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markFollowUpSent).toHaveBeenCalledTimes(1);
    const smsBody = (sendMessage.mock.calls[0][0] as { body: string }).body;
    // Copy compliance: no NHS/private/funding wording in the follow-up text.
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
