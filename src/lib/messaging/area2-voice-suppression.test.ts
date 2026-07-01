import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 2 (consent + suppression gates): the after-hours missed-call follow-up.
// A missed call while closed triggers an automated "book by text" SMS. Proves the
// opt-out list is honoured in BOTH forms: by raw address (STOP from an unknown
// number) and by patient ref (STOP from an identified patient is recorded as
// patient:<id> by the inbound webhook, never as the address).

const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const identifyByPhone = vi.fn();
const markFollowUpSent = vi.fn();

vi.mock("@/lib/messaging/signature", () => ({ verifyTwilioSignature: () => true }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: (...a: unknown[]) => identifyByPhone(...a) }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {} }));
vi.mock("@/lib/after-hours/repository", () => ({
  insertCapture: vi.fn(async () => ({ id: "cap-1" })),
  markFollowUpSent: (...a: unknown[]) => markFollowUpSent(...a),
  hasOpenCaptureFrom: vi.fn(async () => false),
}));
vi.mock("@/lib/after-hours/hours", () => ({
  isOutsideHours: () => true, // the call lands while the practice is closed
  getSiteById: () => null,
}));

import { POST } from "@/app/api/webhooks/twilio/voice/route";

const FROM = "+447700900456";

function call(): Request {
  const form = new FormData();
  form.set("From", FROM);
  return new Request("http://localhost/api/webhooks/twilio/voice", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  isSuppressed.mockResolvedValue(false);
  identifyByPhone.mockResolvedValue(null);
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
});

describe("after-hours missed-call SMS honours suppression", () => {
  it("does not text a number suppressed by ADDRESS", async () => {
    isSuppressed.mockImplementation(async (_s: string, _c: string, ref: string) => ref === FROM);
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markFollowUpSent).not.toHaveBeenCalled();
  });

  it("does not text a KNOWN patient suppressed by patient ref", async () => {
    identifyByPhone.mockResolvedValue({
      patientId: "p-7",
      siteId: "site-cc",
      patientName: "Opted Out Olivia",
      treatment: null,
      fundingType: null,
      lastVisitAt: null,
      recallDueAt: null,
      source: "directory",
    });
    isSuppressed.mockImplementation(async (_s: string, _c: string, ref: string) => ref === "patient:p-7");
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markFollowUpSent).not.toHaveBeenCalled();
  });

  it("control: an unsuppressed caller gets the follow-up text once", async () => {
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "sms", to: FROM }));
    expect(markFollowUpSent).toHaveBeenCalledWith("cap-1");
  });
});
