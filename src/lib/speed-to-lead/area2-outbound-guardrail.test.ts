import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 2 (outbound guardrail): speed-to-lead first contact.
//
// Speed-to-lead drafts its first-contact message with Claude (draftFirstContact)
// and sends it DIRECTLY via sendMessage, deliberately bypassing the messaging
// drain. The drain applies checkAgentReply as an "output backstop for EVERY
// module send" (see src/app/api/messaging/drain/route.ts) so that no
// NHS/private/funding jargon or clinical advice ever reaches a patient. Because
// this path skips the drain, that backstop must be enforced here too, or an LLM
// that drafts forbidden wording sends it straight to a brand-new lead.
//
// These tests prove the guardrail is honoured on the direct path: a drafted
// message containing funding jargon must be blocked (never sent), and a clean
// draft must still send (control, so we know the block is what stops it).

const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const insertAttempt = vi.fn();
const recordFirstResponse = vi.fn();
const setLeadStage = vi.fn();
const findOrCreateConversation = vi.fn();
const appendMessage = vi.fn();
const draftFirstContact = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/mock/clients", () => ({
  getClient: () => ({ id: "vitality", name: "Vitality Dental" }),
  getSite: () => ({ id: "site-cc", clientId: "vitality" }),
}));
vi.mock("@/lib/speed-to-lead/draft", () => ({
  draftFirstContact: (...a: unknown[]) => draftFirstContact(...a),
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

describe("contactLead outbound guardrail (direct-send path bypasses the drain)", () => {
  it("never sends an LLM draft that carries forbidden funding/NHS jargon", async () => {
    // The model drafts patient copy that names a funding category. The drain
    // would block this via checkAgentReply; the direct path must too.
    draftFirstContact.mockResolvedValue({
      body: "Hi! Thanks for your enquiry. We can see you privately next week.",
    });

    await contactLead(lead());

    // The forbidden wording must NEVER reach the wire.
    expect(sendMessage).not.toHaveBeenCalled();
    // And the lead must not be falsely stamped 'contacted' off a blocked send.
    expect(setLeadStage).not.toHaveBeenCalledWith("lead-1", "contacted");
  });

  it("still sends a clean draft (control, proves the guard is what blocks)", async () => {
    draftFirstContact.mockResolvedValue({
      body: "Hi! Thanks for your enquiry with Vitality Dental. When suits you for a chat?",
    });

    await contactLead(lead());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(insertAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: "sent" }));
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "contacted");
  });
});
