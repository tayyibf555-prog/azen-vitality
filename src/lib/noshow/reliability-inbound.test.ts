// RELIABILITY regressions for the no-show inbound handler.
//
// #1 (blocker): a conversational reply that merely BEGINS with "no" ("No problem,
// see you then", "No worries, will be there") must NOT be read as an appointment
// cancel. Before the fix, isCancel matched any leading "no", so a patient
// confirming they would attend had their real Dentally appointment cancelled and
// their slot given away.
//
// #8 (high): a YES to a waitlist offer whose freed slot has ALREADY started (offer
// sent late in the day, answered the next morning) must not create a past-dated
// Dentally booking. It expires the offer and keeps the patient on the waitlist.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SlotOffer, NoshowTarget, NoshowCadence } from "./types";

const store = vi.hoisted(() => ({
  offers: [] as SlotOffer[],
  waitlistStatus: new Map<string, string>(),
  targetStatus: new Map<string, string>(),
  cadencePatch: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  reoffered: [] as string[],
  cancelAppointment: vi.fn(),
  createAppointment: vi.fn(),
  target: null as NoshowTarget | null,
  cadence: null as NoshowCadence | null,
  seq: 0,
}));

vi.mock("./repository", () => ({
  findOpenOfferByAddress: vi.fn(async () => store.offers.find((o) => o.status === "offered") ?? null),
  claimOffer: vi.fn(async (offerId: string) => {
    const o = store.offers.find((x) => x.id === offerId);
    if (!o || o.status !== "offered") return null;
    o.status = "accepted";
    return o;
  }),
  slotIsFilled: vi.fn(async () => false),
  setOfferStatus: vi.fn(async (id: string, status: string, respondedAt?: string) => {
    const o = store.offers.find((x) => x.id === id);
    if (o) { o.status = status as SlotOffer["status"]; if (respondedAt) o.respondedAt = respondedAt; }
  }),
  setWaitlistStatus: vi.fn(async (wid: string, status: string) => { store.waitlistStatus.set(wid, status); }),
  // Appointment-confirmation path.
  findTargetByAddress: vi.fn(async () => (store.target ? { targetId: store.target.id, siteId: store.target.siteId } : null)),
  getTarget: vi.fn(async () => store.target),
  getCadenceByTarget: vi.fn(async () => store.cadence),
  insertInboundTouch: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async (id: string, status: string) => { store.targetStatus.set(id, status); }),
  updateCadence: vi.fn(async (id: string, patch: Record<string, unknown>) => { store.cadencePatch.push({ id, patch }); }),
}));

vi.mock("./fill", () => ({
  offerSlotToNextCandidate: vi.fn(async (slot: { appointmentId: string }) => {
    store.reoffered.push(slot.appointmentId);
    return { waitlistId: "next" };
  }),
}));

vi.mock("@/lib/messaging/suppression", () => ({
  isStopKeyword: (body: string) => /^\s*(stop|end|quit|unsubscribe|cancel)\b/i.test(body),
}));

import { handleNoshowInbound } from "./inbound";

function fakeDentally() {
  return {
    createAppointment: store.createAppointment,
    cancelAppointment: store.cancelAppointment,
  } as unknown as import("@/lib/dentally/client").DentallyClient;
}

function seedTarget(): NoshowTarget {
  const t = {
    id: "target-1",
    siteId: "site-cc",
    appointmentId: "appt-77",
    appointmentStartAt: "2026-07-10T09:30:00.000Z",
    durationMin: 30,
    practitioner: "Dr Khan",
    status: "reminded",
  } as unknown as NoshowTarget;
  store.target = t;
  store.cadence = { id: "cad-1", status: "active" } as unknown as NoshowCadence;
  return t;
}

function seedOffer(overrides: Partial<SlotOffer> = {}): SlotOffer {
  store.seq += 1;
  const o: SlotOffer = {
    id: `offer-${store.seq}`,
    siteId: "site-cc",
    waitlistId: `w-${store.seq}`,
    dentallyPatientId: `pat-${store.seq}`,
    freedAppointmentId: "freed-1",
    freedStartAt: "2026-07-10T09:30:00.000Z",
    durationMin: 30,
    practitioner: "Dr Khan",
    touchId: `t-${store.seq}`,
    status: "offered",
    offeredAt: "2026-07-01T08:00:00.000Z",
    expiresAt: "2026-07-11T12:00:00.000Z",
    respondedAt: null,
    ...overrides,
  };
  store.offers.push(o);
  return o;
}

beforeEach(() => {
  store.offers.length = 0;
  store.waitlistStatus.clear();
  store.targetStatus.clear();
  store.cadencePatch.length = 0;
  store.reoffered.length = 0;
  store.target = null;
  store.cadence = null;
  store.cancelAppointment.mockReset();
  store.createAppointment.mockReset().mockResolvedValue({ id: "new-appt" });
  store.seq = 0;
  vi.clearAllMocks();
});

describe("#1: conversational 'no ...' never cancels a real appointment", () => {
  for (const phrase of ["No problem, see you then", "No worries, I'll be there", "Not sure yet, can I check?"]) {
    it(`"${phrase}" does not cancel the appointment (defers to the agent)`, async () => {
      seedTarget();
      const res = await handleNoshowInbound({
        from: "+447700900001", body: phrase, channel: "sms", dentally: fakeDentally(),
        now: new Date("2026-07-08T09:00:00Z"),
      });
      // Never a destructive cancel.
      expect(store.cancelAppointment).not.toHaveBeenCalled();
      expect(store.targetStatus.get("target-1")).not.toBe("cancelled");
      // Reminders paused, handed to the agent.
      expect(res.handled).toBe(false);
      expect(store.cadencePatch).toContainEqual({ id: "cad-1", patch: { status: "paused" } });
    });
  }

  it("an explicit 'No' (bare) DOES still cancel", async () => {
    seedTarget();
    const res = await handleNoshowInbound({
      from: "+447700900001", body: "No", channel: "sms", dentally: fakeDentally(),
      now: new Date("2026-07-08T09:00:00Z"),
    });
    expect(store.cancelAppointment).toHaveBeenCalledTimes(1);
    expect(store.targetStatus.get("target-1")).toBe("cancelled");
    expect(res.reply).toMatch(/cancelled/i);
  });

  it("'No thanks' still declines a waitlist offer (re-offers to the next person)", async () => {
    const offer = seedOffer();
    const res = await handleNoshowInbound({
      from: "+447700900001", body: "No thanks", channel: "sms", dentally: fakeDentally(),
      now: new Date("2026-07-08T09:00:00Z"),
    });
    expect(offer.status).toBe("declined");
    expect(store.reoffered).toEqual(["freed-1"]);
    expect(res.reply).toMatch(/keep you on the list/i);
  });
});

describe("#8: YES to an already-started slot is not booked", () => {
  it("expires the offer and keeps the patient waiting instead of booking a past-dated slot", async () => {
    const offer = seedOffer({ freedStartAt: "2026-07-08T08:00:00.000Z" });
    const res = await handleNoshowInbound({
      from: "+447700900001", body: "YES", channel: "sms", dentally: fakeDentally(),
      now: new Date("2026-07-08T09:00:00Z"), // one hour AFTER the slot started
    });
    expect(store.createAppointment).not.toHaveBeenCalled();
    expect(offer.status).toBe("expired");
    expect(store.waitlistStatus.get(offer.waitlistId)).toBe("waiting");
    expect(res.handled).toBe(true);
    expect(res.reply).toMatch(/passed/i);
  });

  it("a YES to a still-future slot books as normal", async () => {
    const offer = seedOffer({ freedStartAt: "2026-07-10T09:30:00.000Z" });
    const res = await handleNoshowInbound({
      from: "+447700900001", body: "YES", channel: "sms", dentally: fakeDentally(),
      now: new Date("2026-07-08T09:00:00Z"), // before the slot
    });
    expect(store.createAppointment).toHaveBeenCalledTimes(1);
    expect(offer.status).toBe("filled");
    expect(res.reply).toMatch(/booked in/i);
  });
});
