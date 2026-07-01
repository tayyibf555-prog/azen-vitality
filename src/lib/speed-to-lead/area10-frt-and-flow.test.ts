import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 10 (speed-to-lead): first-response-time calc + intake->contact flow.

import { firstResponseSeconds } from "./types";
import type { SpeedToLeadLead } from "./types";

function baseLead(overrides: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
  return {
    id: "lead-1",
    siteId: "site-cc",
    dentallyPatientId: null,
    name: "Test Lead",
    email: null,
    phone: "+447700900123",
    channel: "sms",
    treatmentInterest: null,
    source: "web",
    score: null,
    stage: "new",
    consent: { sms: true },
    createdAt: "2026-07-01T09:00:00Z",
    firstResponseAt: null,
    conversationId: null,
    updatedAt: "2026-07-01T09:00:00Z",
    ...overrides,
  };
}

describe("firstResponseSeconds", () => {
  it("is null before first contact", () => {
    expect(firstResponseSeconds(baseLead())).toBeNull();
  });

  it("computes whole seconds from enquiry to first contact", () => {
    const s = firstResponseSeconds(
      baseLead({
        createdAt: "2026-07-01T09:00:00Z",
        firstResponseAt: "2026-07-01T09:00:23Z",
      }),
    );
    expect(s).toBe(23);
  });

  it("rounds sub-second latency to the nearest second", () => {
    const s = firstResponseSeconds(
      baseLead({
        createdAt: "2026-07-01T09:00:00.000Z",
        firstResponseAt: "2026-07-01T09:00:00.600Z",
      }),
    );
    expect(s).toBe(1);
  });

  it("never returns a negative FRT even if clocks skew backwards", () => {
    // A first_response_at stamped slightly before created_at (clock skew across
    // the insert + the send) must not surface a negative SLA metric.
    const s = firstResponseSeconds(
      baseLead({
        createdAt: "2026-07-01T09:00:05Z",
        firstResponseAt: "2026-07-01T09:00:00Z",
      }),
    );
    expect(s).toBe(0);
  });

  it("is null on an unparseable timestamp rather than NaN", () => {
    const s = firstResponseSeconds(
      baseLead({ createdAt: "not-a-date", firstResponseAt: "2026-07-01T09:00:10Z" }),
    );
    expect(s).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// intake -> contact flow: stamping FRT exactly once + stage advance.
// ---------------------------------------------------------------------------

const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const insertAttempt = vi.fn();
const recordFirstResponse = vi.fn();
const setLeadStage = vi.fn();
const findOrCreateConversation = vi.fn();
const appendMessage = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/mock/clients", () => ({
  getClient: () => ({ id: "vitality", name: "Vitality Dental" }),
  getSite: () => ({ id: "site-cc", clientId: "vitality" }),
}));
vi.mock("@/lib/speed-to-lead/draft", () => ({
  draftFirstContact: vi.fn(async () => ({ body: "Hi, thanks for your enquiry." })),
}));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  insertAttempt: (...a: unknown[]) => insertAttempt(...a),
  recordFirstResponse: (...a: unknown[]) => recordFirstResponse(...a),
  setLeadStage: (...a: unknown[]) => setLeadStage(...a),
}));
vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: (...a: unknown[]) => findOrCreateConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
}));

import { contactLead } from "./contact";

beforeEach(() => {
  vi.clearAllMocks();
  isSuppressed.mockResolvedValue(false);
  findOrCreateConversation.mockResolvedValue({ id: "conv-1" });
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
});

describe("contactLead intake->contact flow", () => {
  it("stamps first_response_at on the first successful contact", async () => {
    await contactLead(baseLead());
    expect(recordFirstResponse).toHaveBeenCalledTimes(1);
    expect(recordFirstResponse).toHaveBeenCalledWith(
      "lead-1",
      expect.objectContaining({ conversationId: "conv-1" }),
    );
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "contacted");
  });

  it("does NOT re-stamp first_response_at on a resend (protects the SLA metric)", async () => {
    // A lead already contacted once (staff 'resend' / a second sweep tick) must not
    // overwrite the original FRT, else the SLA metric is corrupted.
    await contactLead(baseLead({ firstResponseAt: "2026-07-01T09:00:10Z" }));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(recordFirstResponse).not.toHaveBeenCalled();
    // Stage is still (re)advanced to contacted.
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "contacted");
  });

  it("on send failure records a failed attempt and does NOT advance stage or stamp FRT", async () => {
    sendMessage.mockRejectedValueOnce(new Error("provider down"));
    await contactLead(baseLead());
    expect(insertAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(recordFirstResponse).not.toHaveBeenCalled();
    expect(setLeadStage).not.toHaveBeenCalled();
  });

  it("threads the conversation on the lead:<phone> key the inbound webhook uses", async () => {
    await contactLead(baseLead({ phone: "+447700900123" }));
    expect(findOrCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ dentallyPatientId: "lead:+447700900123" }),
    );
  });
});
