import { describe, it, expect, vi, beforeEach } from "vitest";

// Speed-to-lead first contact: NeverBounce pre-send EMAIL validation.
// The email mirror of the phone (Twilio Lookup) branch already covered for SMS.
//
// Proves: an email lead whose address is undeliverable (invalid/disposable) is
// retired to the terminal 'lost' stage BEFORE any draft/send - never sent, never
// recorded as a failed attempt (so the SLA sweep stops re-picking it). A
// deliverable address (or a dormant/fail-open verdict) proceeds to send, proving
// the block is what stops it.

const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const insertAttempt = vi.fn();
const recordFirstResponse = vi.fn();
const setLeadStage = vi.fn();
const findOrCreateConversation = vi.fn();
const appendMessage = vi.fn();
const validateEmail = vi.fn();
const validateMobile = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/messaging/lookup", () => ({ validateMobile: (...a: unknown[]) => validateMobile(...a) }));
vi.mock("@/lib/messaging/email-lookup", () => ({ validateEmail: (...a: unknown[]) => validateEmail(...a) }));
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
import type { SpeedToLeadLead } from "./types";

function emailLead(overrides: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
  return {
    id: "lead-1",
    siteId: "site-cc",
    dentallyPatientId: null,
    name: "Test Lead",
    email: "patient@example.com",
    phone: null,
    channel: "email",
    treatmentInterest: null,
    source: "web",
    score: null,
    stage: "new",
    consent: { email: true },
    createdAt: "2026-07-01T09:00:00Z",
    firstResponseAt: null,
    conversationId: null,
    updatedAt: "2026-07-01T09:00:00Z",
    nurtureStep: 0,
    nurtureNextAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isSuppressed.mockResolvedValue(false);
  findOrCreateConversation.mockResolvedValue({ id: "conv-1" });
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
});

describe("contactLead email deliverability gate", () => {
  it("retires an INVALID address to 'lost' pre-send, never sending or recording a failed attempt", async () => {
    validateEmail.mockResolvedValue({ valid: false, verdict: "invalid", source: "api" });

    await contactLead(emailLead());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "lost");
    // Pre-send block is NOT a failed send: nothing is drafted or recorded as an attempt.
    expect(insertAttempt).not.toHaveBeenCalled();
  });

  it("retires a DISPOSABLE address to 'lost' pre-send", async () => {
    validateEmail.mockResolvedValue({ valid: false, verdict: "disposable", source: "api" });

    await contactLead(emailLead());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "lost");
  });

  it("control: a deliverable address sends and advances the stage", async () => {
    validateEmail.mockResolvedValue({ valid: true, verdict: "valid", source: "api" });

    await contactLead(emailLead());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(insertAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: "sent" }));
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "contacted");
  });

  it("dormant/fail-open verdict (valid) still sends", async () => {
    validateEmail.mockResolvedValue({ valid: true, verdict: null, source: "disabled" });

    await contactLead(emailLead());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "contacted");
  });

  it("does not consult the phone validator for an email lead", async () => {
    validateEmail.mockResolvedValue({ valid: true, verdict: "valid", source: "api" });

    await contactLead(emailLead());

    expect(validateEmail).toHaveBeenCalledTimes(1);
    expect(validateMobile).not.toHaveBeenCalled();
  });
});
