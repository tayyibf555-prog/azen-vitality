import { describe, it, expect, vi, beforeEach } from "vitest";

// Lead nurture sweep. Proves the behaviours the client asked for:
//   - a reply at any point EXITS nurture (no nudge sent),
//   - the per-tick send CAP (10) holds,
//   - a guardrail-tripped draft falls back to the safe deterministic body,
//   - the 60-day age guard + 3-day entry delay are enforced (cutoffs passed to the
//     query),
//   - no consent / suppression retires the lead from nurture (no send),
//   - the cross-module daily cap makes a tick YIELD without advancing,
//   - a clean send advances the cadence, and the final touch completes it.
//
// The cadence maths (nurture-cadence) is REAL; only side-effecting deps are mocked.
// checkAgentReply is REAL so the guardrail-fallback path exercises the true guard.

const listNurtureDue = vi.fn();
const setNurtureSchedule = vi.fn();
const markNurtureDone = vi.fn();
const insertAttempt = vi.fn();
const setLeadStage = vi.fn();
const getConversation = vi.fn();
const appendMessage = vi.fn();
const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const wasContactedToday = vi.fn();
const recordContacted = vi.fn();
const draftNurtureTouch = vi.fn();
const nurtureFallback = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  listNurtureDue: (...a: unknown[]) => listNurtureDue(...a),
  setNurtureSchedule: (...a: unknown[]) => setNurtureSchedule(...a),
  markNurtureDone: (...a: unknown[]) => markNurtureDone(...a),
  insertAttempt: (...a: unknown[]) => insertAttempt(...a),
  setLeadStage: (...a: unknown[]) => setLeadStage(...a),
}));
vi.mock("@/lib/agent/repository", () => ({
  getConversation: (...a: unknown[]) => getConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: (...a: unknown[]) => wasContactedToday(...a),
  recordContacted: (...a: unknown[]) => recordContacted(...a),
}));
vi.mock("@/lib/mock/clients", () => ({
  getClient: () => ({ id: "vitality", name: "Vitality Dental" }),
  getSite: () => ({ id: "site-cc", clientId: "vitality" }),
}));
vi.mock("@/lib/speed-to-lead/draft", () => ({
  draftNurtureTouch: (...a: unknown[]) => draftNurtureTouch(...a),
  nurtureFallback: (...a: unknown[]) => nurtureFallback(...a),
}));

import { nurtureSweep } from "./nurture";
import type { SpeedToLeadLead } from "./types";

const NOW = new Date("2026-07-01T00:00:00.000Z");

function lead(o: Partial<SpeedToLeadLead> = {}): SpeedToLeadLead {
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
    stage: "contacted",
    consent: { sms: true },
    createdAt: "2026-06-20T09:00:00Z",
    firstResponseAt: "2026-06-20T09:01:00Z",
    conversationId: "conv-1",
    updatedAt: "2026-06-20T09:01:00Z",
    nurtureStep: 0,
    nurtureNextAt: null,
    ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getConversation.mockResolvedValue({ lastInboundAt: null }); // not replied by default
  isSuppressed.mockResolvedValue(false);
  wasContactedToday.mockResolvedValue(false);
  recordContacted.mockResolvedValue(undefined);
  setNurtureSchedule.mockResolvedValue(undefined);
  markNurtureDone.mockResolvedValue(undefined);
  setLeadStage.mockResolvedValue(undefined);
  insertAttempt.mockResolvedValue(undefined);
  appendMessage.mockResolvedValue(undefined);
  draftNurtureTouch.mockResolvedValue({ body: "Hi Test, just checking in about your enquiry. Reply and we will find a time." });
  nurtureFallback.mockReturnValue("FALLBACK safe nudge");
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
});

describe("nurtureSweep", () => {
  it("EXITS nurture when the patient has replied (no nudge sent)", async () => {
    getConversation.mockResolvedValue({ lastInboundAt: "2026-06-25T10:00:00Z" });
    listNurtureDue.mockResolvedValue([lead()]);

    const res = await nurtureSweep(NOW);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(setLeadStage).toHaveBeenCalledWith("lead-1", "qualifying");
    expect(res.exited).toBe(1);
    expect(res.sent).toBe(0);
  });

  it("sends touch 1 and schedules touch 2 seven days out", async () => {
    listNurtureDue.mockResolvedValue([lead({ nurtureStep: 0 })]);

    const res = await nurtureSweep(NOW);

    expect(res.sent).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "sms", to: "+447700900123" }),
    );
    // Cadence advanced: step 1, next touch at NOW + 7 days.
    expect(setNurtureSchedule).toHaveBeenCalledWith("lead-1", 1, "2026-07-08T00:00:00.000Z");
    expect(recordContacted).toHaveBeenCalledWith("site-cc", "+447700900123", expect.any(String), "nurture");
  });

  it("completes nurture after the final (third) touch", async () => {
    listNurtureDue.mockResolvedValue([lead({ nurtureStep: 2 })]);

    const res = await nurtureSweep(NOW);

    expect(res.sent).toBe(1);
    expect(markNurtureDone).toHaveBeenCalledWith("lead-1");
    expect(res.completed).toBe(1);
    expect(setNurtureSchedule).not.toHaveBeenCalled(); // terminal, not rescheduled
  });

  it("honours the per-tick send CAP of 10", async () => {
    const many = Array.from({ length: 12 }, (_, i) => lead({ id: `lead-${i + 1}`, conversationId: `conv-${i + 1}` }));
    listNurtureDue.mockResolvedValue(many);

    const res = await nurtureSweep(NOW);

    expect(res.sent).toBe(10);
    expect(sendMessage).toHaveBeenCalledTimes(10);
  });

  it("falls back to the safe body when the draft trips the guardrail", async () => {
    // A draft that names a funding category trips the REAL guardrail.
    draftNurtureTouch.mockResolvedValue({ body: "Hi, we can see you privately next week." });
    listNurtureDue.mockResolvedValue([lead()]);

    await nurtureSweep(NOW);

    expect(nurtureFallback).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ body: "FALLBACK safe nudge" }));
  });

  it("enforces the 60-day age guard and 3-day entry delay via the query cutoffs", async () => {
    listNurtureDue.mockResolvedValue([]);

    await nurtureSweep(NOW);

    expect(listNurtureDue).toHaveBeenCalledWith(
      expect.objectContaining({
        nowIso: "2026-07-01T00:00:00.000Z",
        entryCutoffIso: "2026-06-28T00:00:00.000Z", // now - 3 days
        ageCutoffIso: "2026-05-02T00:00:00.000Z", // now - 60 days
      }),
    );
  });

  it("retires a lead with no SMS consent (no send)", async () => {
    listNurtureDue.mockResolvedValue([lead({ consent: {} })]);

    const res = await nurtureSweep(NOW);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(setNurtureSchedule).toHaveBeenCalledWith("lead-1", 3, null); // retired from cadence
    expect(res.retired).toBe(1);
  });

  it("retires an opted-out (suppressed) lead (no send)", async () => {
    isSuppressed.mockResolvedValue(true);
    listNurtureDue.mockResolvedValue([lead()]);

    const res = await nurtureSweep(NOW);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(setNurtureSchedule).toHaveBeenCalledWith("lead-1", 3, null);
    expect(res.retired).toBe(1);
  });

  it("YIELDS to the cross-module daily cap without advancing the cadence", async () => {
    wasContactedToday.mockResolvedValue(true);
    listNurtureDue.mockResolvedValue([lead()]);

    const res = await nurtureSweep(NOW);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.capped).toBe(1);
    expect(setNurtureSchedule).not.toHaveBeenCalled(); // stays due for the next tick
    expect(markNurtureDone).not.toHaveBeenCalled();
  });

  it("leaves the lead scheduled to retry when the send fails", async () => {
    sendMessage.mockRejectedValue(new Error("provider down"));
    listNurtureDue.mockResolvedValue([lead()]);

    const res = await nurtureSweep(NOW);

    expect(res.failed).toBe(1);
    expect(res.sent).toBe(0);
    expect(insertAttempt).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
    expect(setNurtureSchedule).not.toHaveBeenCalled(); // not advanced -> retried next tick
  });
});
