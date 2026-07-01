import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 2 (consent + suppression gates): speed-to-lead first contact.
// Proves: missing consent -> silently skipped (nothing sent, nothing recorded);
// suppression wins over consent (address AND patient-ref forms); the happy path
// actually sends so we know the gate is what blocks.

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
import type { SpeedToLeadLead } from "./types";

function lead(overrides: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
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

beforeEach(() => {
  vi.clearAllMocks();
  isSuppressed.mockResolvedValue(false);
  findOrCreateConversation.mockResolvedValue({ id: "conv-1" });
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
});

describe("contactLead consent gate", () => {
  it("never sends or records when the chosen channel has no consent", async () => {
    await contactLead(lead({ consent: {} }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(insertAttempt).not.toHaveBeenCalled();
    expect(setLeadStage).not.toHaveBeenCalled();
  });

  it("does not treat email consent as SMS consent", async () => {
    await contactLead(lead({ channel: "sms", consent: { email: true } }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("never sends when there is no deliverable address, even with consent", async () => {
    await contactLead(lead({ phone: null }));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("contactLead suppression beats consent", () => {
  it("blocks a consented lead whose address is on the opt-out list", async () => {
    isSuppressed.mockImplementation(async (_site: string, _ch: string, ref: string) => ref === "+447700900123");
    await contactLead(lead());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(setLeadStage).not.toHaveBeenCalled();
    // The block is recorded (failed attempt), not silently lost.
    expect(insertAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("blocks a consented lead whose known patient id is on the opt-out list", async () => {
    // A known patient who texted STOP is suppressed as patient:<id> by the inbound
    // webhook. A later enquiry from the same person must not be first-contacted.
    isSuppressed.mockImplementation(async (_site: string, _ch: string, ref: string) => ref === "patient:p-42");
    await contactLead(lead({ dentallyPatientId: "p-42" }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(setLeadStage).not.toHaveBeenCalled();
  });
});

describe("contactLead happy path (control)", () => {
  it("sends and advances the stage when consented and not suppressed", async () => {
    await contactLead(lead());
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(insertAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: "sent" }));
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "contacted");
  });
});
