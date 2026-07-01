import { describe, it, expect, vi, beforeEach } from "vitest";

// stl-terminal-retire: a lead that can NEVER be contacted (no consent for its
// channel, or the address is suppressed/opted out) must be given a TERMINAL
// outcome, not left at stage 'new'. Otherwise listUncontacted re-picks it every
// sweep forever (wasted work; never surfaces as handled).
//
// This test drives contactLead against an in-memory stand-in for the repository:
// setLeadStage mutates a shared row, listUncontacted reads it. We prove that
// after a no-consent (or suppressed) lead is contacted, listUncontacted no longer
// returns it — i.e. the sweep will not re-select it. The pre-fix code returned
// early leaving stage='new', so listUncontacted kept returning the lead and this
// test fails.

import type { SpeedToLeadLead, LeadStage } from "./types";

// A single mutable lead row the fakes share.
let row: SpeedToLeadLead;

const sendMessage = vi.fn();
const isSuppressed = vi.fn();

// Fake repository: setLeadStage mutates the row; listUncontacted applies the same
// predicate as the real query (stage === 'new' AND first_response_at === null).
const insertAttempt = vi.fn(async (..._a: unknown[]) => ({}));
const recordFirstResponse = vi.fn(async (..._a: unknown[]) => {});
const setLeadStage = vi.fn(async (_id: string, stage: LeadStage) => {
  row.stage = stage;
});
function listUncontacted(): SpeedToLeadLead[] {
  return row.stage === "new" && row.firstResponseAt === null ? [row] : [];
}

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
  setLeadStage: (id: string, stage: LeadStage) => setLeadStage(id, stage),
}));
vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: vi.fn(async () => ({ id: "conv-1" })),
  appendMessage: vi.fn(async () => {}),
}));

import { contactLead } from "./contact";

function makeRow(overrides: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
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
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
});

describe("terminal retirement of uncontactable leads", () => {
  it("retires a no-consent lead so the SLA sweep never re-picks it", async () => {
    row = makeRow({ consent: {} });
    // Before contact the sweep would pick it up.
    expect(listUncontacted()).toHaveLength(1);

    await contactLead(row);

    // Retired to a terminal stage, reason recorded on a failed attempt, nothing sent.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(row.stage).toBe("lost");
    expect(insertAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", body: expect.stringMatching(/consent/i) }),
    );
    // The whole point: the sweep no longer re-selects it.
    expect(listUncontacted()).toHaveLength(0);
  });

  it("retires a suppressed (opted-out) lead so the sweep never re-picks it", async () => {
    row = makeRow();
    isSuppressed.mockImplementation(async (_s: string, _c: string, ref: string) => ref === "+447700900123");
    expect(listUncontacted()).toHaveLength(1);

    await contactLead(row);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(row.stage).toBe("lost");
    expect(listUncontacted()).toHaveLength(0);
  });

  it("does NOT retire the happy path — a consented, unsuppressed lead is contacted", async () => {
    row = makeRow();
    await contactLead(row);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // Advanced to 'contacted', not 'lost'.
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "contacted");
    expect(row.stage).toBe("contacted");
  });
});
