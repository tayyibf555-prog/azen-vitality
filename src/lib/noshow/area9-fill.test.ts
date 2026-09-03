// AREA 9 (no-show defence): waitlist auto-fill orchestration (fill.ts).
//
// fill.ts is the write path that turns a freed slot into a live offer + queued
// offer SMS. We drive it against an in-memory fake of the noshow repository so we
// can assert the real orchestration WITHOUT any DB or network:
//  - a freed slot is offered to the correct (longest-waiting, eligible) candidate,
//  - the same slot can NEVER be offered to two people at once (one live offer),
//  - a slot already filled or already carrying a live offer is not re-offered,
//  - the sender is DRY-RUN SAFE + idempotent: the offer SMS is left as a *queued*
//    outbox row (never stub-"sent"), so the shared MESSAGING_DRY_RUN drain owns
//    delivery. This is the historic markTouchSent double-send bug class.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FreedSlot, SlotOffer, WaitlistEntry } from "./types";

// ---------------------------------------------------------------------------
// In-memory repository fake. Mirrors the real Supabase-backed semantics that
// fill.ts depends on: listOffersForSlot returns every offer ever made for the
// slot; createSlotOffer/insertTouch/enqueueOutbox append rows; approveTouch and
// setWaitlistStatus mutate in place.
// ---------------------------------------------------------------------------
interface TouchRec { id: string; targetId: string | null; step: number; status: string; body: string; }
interface OutboxRec { id: string; touchId: string; status: string; provider: string | null; body: string; toRef: string; }

const store = vi.hoisted(() => ({
  waitlist: [] as WaitlistEntry[],
  offers: [] as SlotOffer[],
  touches: [] as TouchRec[],
  outbox: [] as OutboxRec[],
  seq: 0,
}));

function id(p: string): string { store.seq += 1; return `${p}-${store.seq}`; }

// fill.ts now reads the owner kill switch itself (see the header comment on
// offerSlotToNextCandidate). These cases are about the ORCHESTRATION with the
// system switched on, so the toggle table is faked as empty — no row, and
// 'no-show-defence' is a default-ON slug, so that reads as enabled. The switch's
// own behaviour is proved separately in src/lib/agent-wiring/scenarios.test.ts.
vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
  }),
}));

vi.mock("./repository", () => ({
  listOffersForSlot: vi.fn(async (freedAppointmentId: string) =>
    store.offers.filter((o) => o.freedAppointmentId === freedAppointmentId),
  ),
  listWaitlist: vi.fn(async (args: { siteIds: string[]; statuses?: string[] }) =>
    store.waitlist.filter(
      (w) =>
        args.siteIds.includes(w.siteId) &&
        (!args.statuses || args.statuses.includes(w.status)),
    ),
  ),
  createSlotOffer: vi.fn(async (input: Record<string, unknown>) => {
    const offer: SlotOffer = {
      id: id("offer"),
      siteId: input.siteId as string,
      waitlistId: input.waitlistId as string,
      dentallyPatientId: input.dentallyPatientId as string,
      freedAppointmentId: input.freedAppointmentId as string,
      freedStartAt: input.freedStartAt as string,
      durationMin: input.durationMin as number,
      practitioner: (input.practitioner as string | null) ?? null,
      touchId: null,
      status: "offered",
      offeredAt: new Date().toISOString(),
      expiresAt: input.expiresAt as string,
      respondedAt: null,
    };
    store.offers.push(offer);
    return offer;
  }),
  insertTouch: vi.fn(async (input: Record<string, unknown>) => {
    const t: TouchRec = {
      id: id("touch"),
      targetId: (input.targetId as string | null) ?? null,
      step: input.step as number,
      status: (input.status as string) ?? "draft",
      body: input.body as string,
    };
    store.touches.push(t);
    return { id: t.id };
  }),
  approveTouch: vi.fn(async (touchId: string) => {
    const t = store.touches.find((x) => x.id === touchId);
    if (t) t.status = "approved";
    return { id: touchId };
  }),
  enqueueOutbox: vi.fn(async (input: Record<string, unknown>) => {
    const o: OutboxRec = {
      id: id("ob"),
      touchId: input.touchId as string,
      status: "queued", // the ONLY correct initial state: drain owns delivery
      provider: null,
      body: input.body as string,
      toRef: input.toRef as string,
    };
    store.outbox.push(o);
    return o;
  }),
  setOfferTouch: vi.fn(async (offerId: string, touchId: string) => {
    const o = store.offers.find((x) => x.id === offerId);
    if (o) o.touchId = touchId;
  }),
  setWaitlistStatus: vi.fn(async (wid: string, status: string) => {
    const w = store.waitlist.find((x) => x.id === wid);
    if (w) w.status = status as WaitlistEntry["status"];
  }),
}));

import { offerSlotToNextCandidate } from "./fill";
import * as repo from "./repository";
import { readFileSync } from "node:fs";

const SITE = "site-cc";
const SLOT: FreedSlot = {
  appointmentId: "freed-appt-1",
  siteId: SITE,
  startAt: "2026-07-10T10:00:00.000Z",
  durationMin: 30,
  practitioner: "Dr Khan",
};

function waiting(overrides: Partial<WaitlistEntry> = {}): WaitlistEntry {
  return {
    id: id("w"),
    siteId: SITE,
    dentallyPatientId: id("pat"),
    patientName: "Sam Lee",
    treatment: null,
    practitionerPref: null,
    earliestAt: null,
    latestAt: null,
    durationMin: 30,
    consent: { sms: true, email: true, marketing: false },
    status: "waiting",
    createdAt: "2026-06-20T09:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  store.waitlist.length = 0;
  store.offers.length = 0;
  store.touches.length = 0;
  store.outbox.length = 0;
  store.seq = 0;
  vi.clearAllMocks();
});

describe("offerSlotToNextCandidate — picks the right person", () => {
  it("offers the freed slot to the longest-waiting eligible SMS-consenting patient", async () => {
    const younger = waiting({ patientName: "Younger", createdAt: "2026-06-25T09:00:00Z" });
    const oldest = waiting({ patientName: "Oldest", createdAt: "2026-06-18T09:00:00Z" });
    store.waitlist.push(younger, oldest);

    const now = new Date("2026-07-01T09:00:00Z");
    const res = await offerSlotToNextCandidate(SLOT, now);

    expect(res).toEqual({ waitlistId: oldest.id });
    expect(store.offers).toHaveLength(1);
    expect(store.offers[0].waitlistId).toBe(oldest.id);
    // The offered patient is moved off 'waiting' so a second freed slot cannot
    // double-book the same person on two offers simultaneously.
    expect(oldest.status).toBe("offered");
    expect(younger.status).toBe("waiting");
    // TTL is honoured (default 4h from now).
    expect(store.offers[0].expiresAt).toBe(new Date(now.getTime() + 4 * 3_600_000).toISOString());
  });

  it("skips a candidate who never consented to SMS (the offer channel)", async () => {
    const noSms = waiting({ patientName: "NoSms", createdAt: "2026-06-18T09:00:00Z", consent: { sms: false, email: true, marketing: false } });
    const yesSms = waiting({ patientName: "YesSms", createdAt: "2026-06-20T09:00:00Z" });
    store.waitlist.push(noSms, yesSms);

    const res = await offerSlotToNextCandidate(SLOT, new Date("2026-07-01T09:00:00Z"));
    expect(res).toEqual({ waitlistId: yesSms.id });
    expect(noSms.status).toBe("waiting");
  });

  it("returns null when nobody fits (empty waitlist)", async () => {
    const res = await offerSlotToNextCandidate(SLOT, new Date("2026-07-01T09:00:00Z"));
    expect(res).toBeNull();
    expect(store.offers).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it("never offers a slot whose start time is already in the past (dead slot)", async () => {
    // A CANCEL arriving after the appointment start, or an offer TTL outliving a
    // near-term slot, can reach the fill choke point with a past start. Offering
    // it would text a patient an appointment they can never attend.
    store.waitlist.push(waiting({ patientName: "A" }));
    const pastSlot: FreedSlot = { ...SLOT, startAt: "2026-07-01T08:00:00.000Z" };
    const now = new Date("2026-07-01T09:00:00.000Z"); // 1h AFTER the slot start

    const res = await offerSlotToNextCandidate(pastSlot, now);
    expect(res).toBeNull();
    expect(store.offers).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it("does not offer a slot starting exactly now (boundary: must be strictly future)", async () => {
    store.waitlist.push(waiting({ patientName: "A" }));
    const now = new Date(SLOT.startAt);
    const res = await offerSlotToNextCandidate(SLOT, now);
    expect(res).toBeNull();
  });
});

describe("offerSlotToNextCandidate — never double-offers a slot", () => {
  it("refuses to offer a slot that already has a live 'offered' offer", async () => {
    const a = waiting({ patientName: "A", createdAt: "2026-06-18T09:00:00Z" });
    const b = waiting({ patientName: "B", createdAt: "2026-06-19T09:00:00Z" });
    store.waitlist.push(a, b);

    // First call creates the one live offer to A.
    const first = await offerSlotToNextCandidate(SLOT, new Date("2026-07-01T09:00:00Z"));
    expect(first).toEqual({ waitlistId: a.id });

    // Second call for the SAME slot must NOT create a parallel offer to B: only
    // one patient can ever hold a live claim on a slot.
    const second = await offerSlotToNextCandidate(SLOT, new Date("2026-07-01T09:05:00Z"));
    expect(second).toBeNull();
    expect(store.offers).toHaveLength(1);
    expect(b.status).toBe("waiting");
  });

  it("refuses to offer a slot that has already been filled", async () => {
    const a = waiting({ patientName: "A" });
    store.waitlist.push(a);
    // Simulate a prior filled offer for this slot (patient already booked in).
    store.offers.push({
      id: "prior", siteId: SITE, waitlistId: "someone-else", dentallyPatientId: "px",
      freedAppointmentId: SLOT.appointmentId, freedStartAt: SLOT.startAt, durationMin: 30,
      practitioner: SLOT.practitioner, touchId: null, status: "filled",
      offeredAt: "2026-07-01T08:00:00Z", expiresAt: "2026-07-01T12:00:00Z", respondedAt: "2026-07-01T08:10:00Z",
    });

    const res = await offerSlotToNextCandidate(SLOT, new Date("2026-07-01T09:00:00Z"));
    expect(res).toBeNull();
    expect(store.offers).toHaveLength(1); // no new offer appended
    expect(a.status).toBe("waiting");
  });

  it("re-offers to the NEXT person after a prior offer expired/declined (excludes the tried entry)", async () => {
    const a = waiting({ patientName: "A", createdAt: "2026-06-18T09:00:00Z" });
    const b = waiting({ patientName: "B", createdAt: "2026-06-19T09:00:00Z" });
    store.waitlist.push(a, b);
    // A was offered and it expired: not live, but A must be excluded from re-offer.
    store.offers.push({
      id: "expired-a", siteId: SITE, waitlistId: a.id, dentallyPatientId: a.dentallyPatientId,
      freedAppointmentId: SLOT.appointmentId, freedStartAt: SLOT.startAt, durationMin: 30,
      practitioner: SLOT.practitioner, touchId: null, status: "expired",
      offeredAt: "2026-07-01T08:00:00Z", expiresAt: "2026-07-01T08:30:00Z", respondedAt: null,
    });

    const res = await offerSlotToNextCandidate(SLOT, new Date("2026-07-01T09:00:00Z"));
    expect(res).toEqual({ waitlistId: b.id }); // not A again
    expect(store.offers.filter((o) => o.status === "offered")).toHaveLength(1);
  });
});

describe("offerSlotToNextCandidate — dry-run safe + idempotent sender path", () => {
  it("leaves the offer SMS as a QUEUED outbox row and never stub-sends it", async () => {
    store.waitlist.push(waiting({ patientName: "A" }));
    await offerSlotToNextCandidate(SLOT, new Date("2026-07-01T09:00:00Z"));

    // Exactly one outbox row, and it is queued (drain owns delivery under
    // MESSAGING_DRY_RUN). A stub "sent"/provider here would be the double-send bug.
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].status).toBe("queued");
    expect(store.outbox[0].provider).toBeNull();
    // The offer touch has target_id null (offers are not tied to a defended target),
    // is auto-approved, and step 0 — never marked 'sent' by the fill path.
    expect(store.touches).toHaveLength(1);
    expect(store.touches[0].targetId).toBeNull();
    expect(store.touches[0].step).toBe(0);
    expect(store.touches[0].status).toBe("approved");
    expect(store.touches[0].status).not.toBe("sent");
  });

  it("REGRESSION GUARD: fill.ts imports the queued-outbox path, not the stub markTouchSent sender", () => {
    // markTouchSent stub-sends (provider:'stub') and would bypass the dry-run
    // drain — the historic double-send landmine. fill.ts must never reference it.
    const called = (repo as Record<string, unknown>);
    expect(typeof called.enqueueOutbox).toBe("function");
    // Static guard on the source: no markTouchSent reference in fill.ts.
    const src = readFileSync(new URL("./fill.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/markTouchSent/);
    expect(src).toMatch(/enqueueOutbox/);
  });

  it("does not queue a message and does not touch the waitlist when the slot is already live", async () => {
    const a = waiting({ patientName: "A" });
    store.waitlist.push(a);
    store.offers.push({
      id: "live", siteId: SITE, waitlistId: "other", dentallyPatientId: "px",
      freedAppointmentId: SLOT.appointmentId, freedStartAt: SLOT.startAt, durationMin: 30,
      practitioner: SLOT.practitioner, touchId: null, status: "offered",
      offeredAt: "2026-07-01T08:00:00Z", expiresAt: "2026-07-01T12:00:00Z", respondedAt: null,
    });

    await offerSlotToNextCandidate(SLOT, new Date("2026-07-01T09:00:00Z"));
    expect(store.outbox).toHaveLength(0);
    expect(a.status).toBe("waiting");
  });
});
