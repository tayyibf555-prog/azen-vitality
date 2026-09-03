import { describe, it, expect, vi, beforeEach } from "vitest";

import { createFakeSupabase } from "@/lib/test-support/fake-supabase";

// ===========================================================================
// RULING W2-C/2 (3 Sep 2026) — the first contact and the anti-overlap cap.
//
// A speed-to-lead first contact is a REPLY to an inbound enquiry. So it sits on
// exactly one side of the cross-module daily cap:
//
//   IT DOES NOT CONSULT IT. Someone who has just asked us a question gets an
//   answer, whatever unsolicited text another sweep sent them earlier today.
//
//   IT MUST STAMP IT. Once we have replied, the unsolicited sweeps (recall,
//   reactivation, no-show, coordinator, closer, collection, post-op) hold off for
//   the rest of the London day — they all read message_daily_log before sending.
//   Before this ruling contactLead sent directly and stamped nothing, so a lead
//   who enquired at nine could be chased by a recall text at ten.
//
// These tests run the REAL cap helper (src/lib/messaging/frequency.ts) against
// the in-memory database, so what is proven is not "recordContacted was called"
// but "a later sweep's own cap read now returns suppressed for that key".
// ===========================================================================

const fake = createFakeSupabase();

const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const insertAttempt = vi.fn();
const listAttempts = vi.fn();
const recordFirstResponse = vi.fn();
const setLeadStage = vi.fn();
const findOrCreateConversation = vi.fn();
const appendMessage = vi.fn();
const draftFirstContact = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => fake.client }));
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
  listAttempts: (...a: unknown[]) => listAttempts(...a),
  recordFirstResponse: (...a: unknown[]) => recordFirstResponse(...a),
  setLeadStage: (...a: unknown[]) => setLeadStage(...a),
}));
vi.mock("@/lib/agent/repository", () => ({
  findOrCreateConversation: (...a: unknown[]) => findOrCreateConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
}));
// Assessment context is optional colour on the draft and irrelevant here.
vi.mock("@/lib/smile-assessment/repository", () => ({ latestResponseByLead: async () => null }));

import { contactLead } from "./contact";
import { wasContactedToday } from "@/lib/messaging/frequency";
import { londonDayKey } from "@/lib/time/london";
import type { SpeedToLeadLead } from "./types";

const SITE = "site-cc";
const PHONE = "+447700900123";

function lead(overrides: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
  return {
    id: "lead-1",
    siteId: SITE,
    dentallyPatientId: null,
    name: "Test Lead",
    email: null,
    phone: PHONE,
    channel: "sms",
    treatmentInterest: null,
    source: "web",
    score: null,
    stage: "new",
    consent: { sms: true },
    createdAt: "2026-09-03T09:00:00Z",
    firstResponseAt: null,
    conversationId: null,
    updatedAt: "2026-09-03T09:00:00Z",
    nurtureStep: 0,
    nurtureNextAt: null,
    ...overrides,
  };
}

/** What an unsolicited sweep asks before it sends to this handset today. */
async function sweepWouldBeSuppressed(address = PHONE): Promise<boolean> {
  return wasContactedToday(SITE, address, londonDayKey(new Date()));
}

/** An earlier unsolicited text to the same handset, already stamped today. */
function stampToday(address = PHONE, source = "recall"): void {
  fake.seed("message_daily_log", {
    site_id: SITE,
    address,
    sent_on: londonDayKey(new Date()),
    source,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.reset();
  isSuppressed.mockResolvedValue(false);
  listAttempts.mockResolvedValue([]);
  findOrCreateConversation.mockResolvedValue({ id: "conv-1" });
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
  draftFirstContact.mockResolvedValue({
    body: "Hi! Thanks for your enquiry with Vitality Dental. When suits you for a chat?",
  });
});

describe("ruling W2-C/2: a first contact stamps the daily cap and never consults it", () => {
  it("holds the unsolicited sweeps off for the rest of the day after a first contact", async () => {
    expect(await sweepWouldBeSuppressed(), "the day started already capped").toBe(false);

    await contactLead(lead());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    // The real cap read, the one every sweep makes, now says "not today".
    expect(await sweepWouldBeSuppressed(), "a recall text could still chase this lead today").toBe(true);
  });

  it("stamps the key the sweeps actually consult: site, canonical address, London day", async () => {
    await contactLead(lead());

    // Leads are normalised to E.164 / lower-cased email at every intake boundary
    // (src/lib/messaging/phone.ts), which is the same canonical form the drain
    // resolves a patient to — so one stamp covers both.
    expect(fake.rows("message_daily_log")).toEqual([
      expect.objectContaining({
        site_id: SITE,
        address: PHONE,
        sent_on: londonDayKey(new Date()),
        source: "speed-to-lead",
      }),
    ]);
  });

  it("stamps an EMAIL first contact under the email address", async () => {
    await contactLead(lead({ channel: "email", email: "someone@example.com", consent: { email: true } }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(await sweepWouldBeSuppressed("someone@example.com")).toBe(true);
  });

  it("CONTROL: an earlier unsolicited text today does NOT stop the reply going out", async () => {
    // The patient has just asked us something. A recall text at nine is not a
    // reason to leave their enquiry unanswered at ten.
    stampToday();

    await contactLead(lead());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "contacted");
    // And the day is still stamped exactly once: the upsert dedupes on the key.
    expect(fake.rows("message_daily_log")).toHaveLength(1);
  });

  it("stamps nothing when the send fails: only a message that went out consumes the day", async () => {
    sendMessage.mockRejectedValue(new Error("twilio down"));

    await contactLead(lead());

    expect(fake.rows("message_daily_log")).toEqual([]);
    expect(await sweepWouldBeSuppressed(), "a failed send silenced the sweeps for the day").toBe(false);
  });

  it("stamps nothing when the draft is blocked by the output guardrail", async () => {
    // Blocked before the wire: nothing reached the patient, so nothing may be
    // charged against their day.
    draftFirstContact.mockResolvedValue({
      body: "Hi! Thanks for your enquiry. We can see you privately next week.",
    });

    await contactLead(lead());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(fake.rows("message_daily_log")).toEqual([]);
  });

  it("a cap-table outage never blocks the reply (the cap is fatigue control, not a safety gate)", async () => {
    fake.failTable("message_daily_log");

    await contactLead(lead());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "contacted");
  });
});
