// AREA 9 (no-show defence): inbound reply handling for waitlist slot offers.
//
// The critical safety property: a freed slot can NEVER be double-booked. Two YES
// replies racing to the same offer must resolve to exactly one booking; the loser
// gets the "slot taken" reply. We drive handleNoshowInbound against an in-memory
// repository fake whose claimOffer reproduces the real conditional-update
// (offered -> accepted only if still open), so the atomic-claim guard is exercised
// rather than mocked away. A failed Dentally booking must release + re-offer.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SlotOffer } from "./types";

const store = vi.hoisted(() => ({
  offers: [] as SlotOffer[],
  waitlistStatus: new Map<string, string>(),
  reoffered: [] as string[], // freedAppointmentIds passed to fill
  createAppointment: vi.fn(),
  seq: 0,
}));

vi.mock("./repository", () => ({
  // Returns the open offer whose SMS went to this address.
  findOpenOfferByAddress: vi.fn(async (_addr: string) =>
    store.offers.find((o) => o.status === "offered") ?? null,
  ),
  // Real conditional claim: succeeds only if still 'offered'; else null.
  claimOffer: vi.fn(async (offerId: string) => {
    const o = store.offers.find((x) => x.id === offerId);
    if (!o || o.status !== "offered") return null;
    o.status = "accepted";
    o.respondedAt = new Date().toISOString();
    return o;
  }),
  slotIsFilled: vi.fn(async (freedAppointmentId: string) =>
    store.offers.some((o) => o.freedAppointmentId === freedAppointmentId && o.status === "filled"),
  ),
  setOfferStatus: vi.fn(async (id: string, status: string, respondedAt?: string) => {
    const o = store.offers.find((x) => x.id === id);
    if (o) { o.status = status as SlotOffer["status"]; if (respondedAt) o.respondedAt = respondedAt; }
  }),
  setWaitlistStatus: vi.fn(async (wid: string, status: string) => { store.waitlistStatus.set(wid, status); }),
  // Unused-in-offer-path repo fns still imported by inbound.ts:
  findTargetByAddress: vi.fn(async () => null),
  getTarget: vi.fn(async () => null),
  getCadenceByTarget: vi.fn(async () => null),
  insertInboundTouch: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
  updateCadence: vi.fn(async () => {}),
}));

vi.mock("./fill", () => ({
  offerSlotToNextCandidate: vi.fn(async (slot: { appointmentId: string }) => {
    store.reoffered.push(slot.appointmentId);
    return { waitlistId: "next-in-line" };
  }),
}));

vi.mock("@/lib/messaging/suppression", () => ({
  isStopKeyword: (body: string) => /^\s*(stop|end|quit|unsubscribe)\b/i.test(body),
}));

import { handleNoshowInbound } from "./inbound";
import { offerSlotToNextCandidate } from "./fill";

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
    expiresAt: "2026-07-01T12:00:00.000Z",
    respondedAt: null,
    ...overrides,
  };
  store.offers.push(o);
  return o;
}

function fakeDentally() {
  return { createAppointment: store.createAppointment } as unknown as import("@/lib/dentally/client").DentallyClient;
}

beforeEach(() => {
  store.offers.length = 0;
  store.waitlistStatus.clear();
  store.reoffered.length = 0;
  store.createAppointment.mockReset();
  store.createAppointment.mockResolvedValue({ id: "new-appt" });
  store.seq = 0;
  vi.clearAllMocks();
});

describe("waitlist offer: YES books the slot", () => {
  it("a single YES claims the offer, books via Dentally, and marks it filled", async () => {
    const offer = seedOffer();
    const res = await handleNoshowInbound({
      from: "+447700900001", body: "YES", channel: "sms", dentally: fakeDentally(),
      now: new Date("2026-07-01T09:00:00Z"),
    });
    expect(res.handled).toBe(true);
    expect(res.reply).toMatch(/booked in/i);
    expect(store.createAppointment).toHaveBeenCalledTimes(1);
    expect(offer.status).toBe("filled");
    expect(store.waitlistStatus.get(offer.waitlistId)).toBe("booked");
  });
});

describe("waitlist offer: two YES replies can never both book the same slot", () => {
  it("the second YES loses the atomic claim and gets the 'slot taken' reply (no second booking)", async () => {
    const offer = seedOffer();
    const dentally = fakeDentally();

    const first = await handleNoshowInbound({ from: "+447700900001", body: "yes please", channel: "sms", dentally, now: new Date("2026-07-01T09:00:00Z") });
    expect(first.reply).toMatch(/booked in/i);
    expect(offer.status).toBe("filled");

    // The second reply arrives; findOpenOfferByAddress now returns null (no open
    // offer), so the handler falls through — but even if it saw the offer, the
    // claim is no longer 'offered'. Prove no second booking happened.
    const second = await handleNoshowInbound({ from: "+447700900001", body: "YES", channel: "sms", dentally, now: new Date("2026-07-01T09:01:00Z") });
    expect(store.createAppointment).toHaveBeenCalledTimes(1); // still ONE booking
    expect(second.handled).toBe(false); // fell through to the agent, no double-book
  });

  it("if the claim is lost mid-flight (already accepted), the reply is 'slot taken' and no booking is made", async () => {
    // Two offers exist but findOpenOfferByAddress returns the first 'offered' one.
    const offer = seedOffer({ status: "accepted" }); // already claimed by a racing reply
    // Force findOpenOfferByAddress to hand us this already-accepted offer.
    const repo = await import("./repository");
    (repo.findOpenOfferByAddress as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(offer);

    const res = await handleNoshowInbound({ from: "+447700900001", body: "YES", channel: "sms", dentally: fakeDentally(), now: new Date("2026-07-01T09:00:00Z") });
    expect(res.reply).toMatch(/just been taken/i);
    expect(store.createAppointment).not.toHaveBeenCalled();
  });
});

describe("waitlist offer: booking failure releases and re-offers", () => {
  it("a Dentally createAppointment throw releases the claim and passes the slot to the next candidate", async () => {
    const offer = seedOffer();
    store.createAppointment.mockRejectedValueOnce(new Error("Dentally 500"));

    const res = await handleNoshowInbound({ from: "+447700900001", body: "yes", channel: "sms", dentally: fakeDentally(), now: new Date("2026-07-01T09:00:00Z") });
    expect(res.reply).toMatch(/just been taken/i);
    // The offer was released (declined) and the waitlist entry returned to waiting.
    expect(offer.status).toBe("declined");
    expect(store.waitlistStatus.get(offer.waitlistId)).toBe("waiting");
    // The freed slot was re-offered to the next person, not frozen until TTL.
    expect(offerSlotToNextCandidate).toHaveBeenCalledTimes(1);
    expect(store.reoffered).toEqual(["freed-1"]);
  });
});

describe("waitlist offer: NO declines and re-offers", () => {
  it("NO declines the offer, returns the entry to waiting, and re-offers to the next person", async () => {
    const offer = seedOffer();
    const res = await handleNoshowInbound({ from: "+447700900001", body: "No thanks", channel: "sms", dentally: fakeDentally(), now: new Date("2026-07-01T09:00:00Z") });
    expect(res.reply).toMatch(/keep you on the list/i);
    expect(offer.status).toBe("declined");
    expect(store.waitlistStatus.get(offer.waitlistId)).toBe("waiting");
    expect(store.reoffered).toEqual(["freed-1"]);
    expect(store.createAppointment).not.toHaveBeenCalled();
  });
});

describe("waitlist offer: carrier STOP is never read as an offer decline", () => {
  it("a STOP keyword falls through to the suppression path (handled:false), not a decline", async () => {
    const offer = seedOffer();
    const res = await handleNoshowInbound({ from: "+447700900001", body: "STOP", channel: "sms", dentally: fakeDentally(), now: new Date("2026-07-01T09:00:00Z") });
    expect(res.handled).toBe(false);
    // The offer is untouched; suppression is recorded by the webhook, not here.
    expect(offer.status).toBe("offered");
    expect(store.reoffered).toHaveLength(0);
  });
});

describe("waitlist offer: ambiguous reply defers to the agent", () => {
  it("an ambiguous reply to an open offer is not handled here (agent takes over)", async () => {
    seedOffer();
    const res = await handleNoshowInbound({ from: "+447700900001", body: "what time was that again", channel: "sms", dentally: fakeDentally(), now: new Date("2026-07-01T09:00:00Z") });
    expect(res.handled).toBe(false);
    expect(store.createAppointment).not.toHaveBeenCalled();
  });
});
