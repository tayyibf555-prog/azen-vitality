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
const contactLead = vi.fn();
const findOpenLeadByAddress = vi.fn();
const insertLead = vi.fn();
const claimLeadForContact = vi.fn();
const releaseLeadClaim = vi.fn();

vi.mock("@/lib/messaging/signature", () => ({ verifyTwilioSignature: () => true }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/agent/identify", () => ({ identifyByPhone: (...a: unknown[]) => identifyByPhone(...a) }));
vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {} }));
// The voice route now bridges an after-hours missed call into speed-to-lead; mock it so
// the route's transitive `import "server-only"` (in contact.ts) is not pulled into the test.
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: (...a: unknown[]) => contactLead(...a) }));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  findOpenLeadByAddress: (...a: unknown[]) => findOpenLeadByAddress(...a),
  insertLead: (...a: unknown[]) => insertLead(...a),
  claimLeadForContact: (...a: unknown[]) => claimLeadForContact(...a),
  releaseLeadClaim: (...a: unknown[]) => releaseLeadClaim(...a),
}));
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
  findOpenLeadByAddress.mockResolvedValue(null); // no existing lead -> create + contact
  insertLead.mockResolvedValue({ id: "lead-1", channel: "sms" });
  claimLeadForContact.mockResolvedValue(true);
  contactLead.mockResolvedValue(undefined);
});

describe("after-hours missed-call SMS honours suppression", () => {
  it("does not text a number suppressed by ADDRESS", async () => {
    isSuppressed.mockImplementation(async (_s: string, _c: string, ref: string) => ref === FROM);
    const res = await POST(call());
    expect(res.status).toBe(200);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(contactLead).not.toHaveBeenCalled(); // suppression skips the whole bridge
    expect(insertLead).not.toHaveBeenCalled();
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
    expect(contactLead).not.toHaveBeenCalled(); // suppression skips the whole bridge
    expect(insertLead).not.toHaveBeenCalled();
    expect(markFollowUpSent).not.toHaveBeenCalled();
  });

  it("control: an unsuppressed caller is routed into speed-to-lead and marked followed up", async () => {
    const res = await POST(call());
    expect(res.status).toBe(200);
    // The missed call now bridges into speed-to-lead (an AI-drafted opener via
    // contactLead), not the bare fixed SMS; the follow-up is still marked on the capture.
    expect(insertLead).toHaveBeenCalledTimes(1);
    expect(contactLead).toHaveBeenCalledTimes(1);
    expect(markFollowUpSent).toHaveBeenCalledWith("cap-1");
    expect(sendMessage).not.toHaveBeenCalled(); // the bare-SMS fallback did not fire
  });
});
