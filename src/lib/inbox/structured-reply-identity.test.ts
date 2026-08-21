import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * EVERY branch of the two structured-reply handlers that says something to a patient
 * must also say WHO it said it to.
 *
 * The webhook records these replies on the patient's record, and it can only do that
 * with the identity the handler hands back: both branches run before the webhook has
 * resolved the patient itself, deliberately, so a YES/CANCEL is answered without
 * waiting on a Dentally lookup. A new reply branch added without `patient` therefore
 * would not fail, would not warn, and would simply not appear on the record — which is
 * the exact shape of the defect this whole lane exists to close.
 *
 * So this drives every reply-producing branch there is and asserts the pairing. It is
 * the counterpart to the send-site crawl: that one catches a new SENDER, this one
 * catches a new SENTENCE inside a sender already wired up.
 */

const noshow = vi.hoisted(() => ({
  offer: null as unknown,
  match: null as unknown,
  target: null as unknown,
  claimed: null as unknown,
  filled: false,
}));
const postop = vi.hoisted(() => ({ match: null as unknown, target: null as unknown }));

vi.mock("@/lib/noshow/repository", () => ({
  findOpenOfferByAddress: async () => noshow.offer,
  findTargetByAddress: async () => noshow.match,
  getTarget: async () => noshow.target,
  getCadenceByTarget: async () => null,
  listActiveTargetIdsByAddress: async () =>
    noshow.match ? [(noshow.match as { targetId: string }).targetId] : [],
  insertInboundTouch: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
  updateCadence: vi.fn(async () => {}),
  claimOffer: vi.fn(async () => noshow.claimed),
  setOfferStatus: vi.fn(async () => {}),
  setWaitlistStatus: vi.fn(async () => {}),
  slotIsFilled: vi.fn(async () => noshow.filled),
}));
vi.mock("@/lib/noshow/fill", () => ({ offerSlotToNextCandidate: vi.fn(async () => null) }));
vi.mock("@/lib/dentally/write", () => ({ isDentallyWriteEnabled: () => false }));
vi.mock("@/lib/postop/repository", () => ({
  findTargetByAddress: async () => postop.match,
  getTarget: async () => postop.target,
  insertInboundTouch: vi.fn(async () => {}),
  recordEscalation: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: () => ({ id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental" }),
}));
vi.mock("@/lib/messaging/suppression", () => {
  const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
  return {
    isStopKeyword: (b: string) => STOP.has(String(b).trim().toLowerCase()),
    isSuppressed: async () => false,
  };
});

import { handleNoshowInbound } from "@/lib/noshow/inbound";
import { handlePostopInbound } from "@/lib/postop/inbound";
import type { DentallyClient } from "@/lib/dentally/client";

const FROM = "+447700900321";
const SITE = "site-cc";
const PATIENT = "pat-4471";
const dentally = { cancelAppointment: async () => {} } as unknown as DentallyClient;

const FUTURE = "2026-12-01T09:00:00Z";
const NOW = new Date("2026-08-21T09:00:00Z");

function offer(overrides: Record<string, unknown> = {}) {
  return {
    id: "offer-1",
    siteId: SITE,
    waitlistId: "wl-1",
    dentallyPatientId: PATIENT,
    freedAppointmentId: "appt-freed",
    freedStartAt: FUTURE,
    durationMin: 30,
    practitioner: "Dr Khan",
    touchId: null,
    status: "offered",
    offeredAt: "2026-08-21T08:00:00Z",
    expiresAt: "2026-08-21T20:00:00Z",
    respondedAt: null,
    ...overrides,
  };
}

function target() {
  return {
    id: `${SITE}:${PATIENT}:appt-1`,
    siteId: SITE,
    dentallyPatientId: PATIENT,
    appointmentId: "appt-1",
    patientName: "Sarah Ahmed",
    appointmentStartAt: FUTURE,
    appointmentState: "scheduled",
    durationMin: 30,
    practitioner: "Dr Khan",
    riskScore: 10,
    riskBand: "low",
    status: "scheduled",
    priorAttempts: 1,
    consent: { sms: true, email: false, marketing: false },
    updatedFromDentallyAt: "2026-08-20T09:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  noshow.offer = null;
  noshow.match = null;
  noshow.target = null;
  noshow.claimed = null;
  noshow.filled = false;
  postop.match = null;
  postop.target = null;
});

async function noshowReply(body: string) {
  return handleNoshowInbound({ from: FROM, body, channel: "sms", dentally, now: NOW });
}

describe("every no-show reply carries the patient it is for", () => {
  const cases: Array<[string, () => void, string]> = [
    [
      "accepting a slot offer",
      () => {
        noshow.offer = offer();
        noshow.claimed = offer({ status: "accepted" });
      },
      "YES",
    ],
    [
      "accepting an offer whose slot has already passed",
      () => {
        noshow.offer = offer({ freedStartAt: "2026-08-20T09:00:00Z" });
      },
      "YES",
    ],
    [
      "accepting an offer another patient has already taken",
      () => {
        noshow.offer = offer();
        noshow.claimed = null;
      },
      "YES",
    ],
    [
      "declining a slot offer",
      () => {
        noshow.offer = offer();
      },
      "no thanks",
    ],
    [
      "confirming an appointment",
      () => {
        noshow.match = { targetId: `${SITE}:${PATIENT}:appt-1`, siteId: SITE };
        noshow.target = target();
      },
      "YES",
    ],
    [
      "cancelling an appointment, handed to reception",
      () => {
        noshow.match = { targetId: `${SITE}:${PATIENT}:appt-1`, siteId: SITE };
        noshow.target = target();
      },
      "I need to cancel",
    ],
  ];

  for (const [name, seed, body] of cases) {
    it(`says who it is talking to when ${name}`, async () => {
      seed();
      const result = await noshowReply(body);
      expect(result.handled, name).toBe(true);
      expect(result.reply, name).toBeTruthy();
      expect(result.patient, `${name}: a reply with no patient cannot reach the record`).toBeTruthy();
      expect(result.patient?.siteId, name).toBe(SITE);
      expect(result.patient?.dentallyPatientId, name).toBe(PATIENT);
    });
  }

  it("resolves the patient from the target KEY when the target row cannot be read", async () => {
    // The key is `<site>:<patient>:<appointment>`. Losing the display name to a
    // transient read costs a label; losing the patient link would put the reply on
    // nobody's record at all, which is the half that must survive.
    noshow.match = { targetId: `${SITE}:${PATIENT}:appt-1`, siteId: SITE };
    noshow.target = null;
    const result = await noshowReply("YES");
    expect(result.patient?.dentallyPatientId).toBe(PATIENT);
    expect(result.patient?.patientName).toBe("");
  });

  it("carries no patient when it says nothing, because there is nothing to record", async () => {
    // Ambiguity falls through to the agent. A patient on a handled:false result would
    // invite a caller to record a message that was never sent.
    noshow.offer = offer();
    const ambiguous = await noshowReply("maybe, what time was it again?");
    expect(ambiguous.handled).toBe(false);
    expect(ambiguous.reply).toBeUndefined();
  });
});

describe("every post-op acknowledgement carries the patient it is for", () => {
  function seedPostop(): void {
    postop.match = {
      targetId: "postop-1",
      siteId: SITE,
      sentAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    };
    postop.target = {
      id: "postop-1",
      siteId: SITE,
      dentallyPatientId: PATIENT,
      appointmentId: "appt-9",
      patientName: "Sarah Ahmed",
      status: "sent",
    };
  }

  it("says who it is talking to when acknowledging a symptom", async () => {
    seedPostop();
    const result = await handlePostopInbound({
      from: FROM,
      body: "my jaw is quite sore today",
      channel: "sms",
      sendingEnabled: true,
      now: NOW,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toBeTruthy();
    expect(result.patient).toEqual({
      siteId: SITE,
      dentallyPatientId: PATIENT,
      patientName: "Sarah Ahmed",
    });
  });

  it("still says who, even when the kill switch means it says nothing to them", async () => {
    // handled:true / reply:null is a valid outcome. The identity travels anyway, so a
    // caller cannot end up recording a message against the wrong person if the branch
    // later gains something to say.
    seedPostop();
    const result = await handlePostopInbound({
      from: FROM,
      body: "my jaw is quite sore today",
      channel: "sms",
      sendingEnabled: false,
      now: NOW,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toBeNull();
    expect(result.patient?.dentallyPatientId).toBe(PATIENT);
  });
});
