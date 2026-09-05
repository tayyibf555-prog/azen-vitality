import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// THE THREE STAFF BOOKING DOORS, DRIVEN FOR REAL.
//
// write-gate-sites.test.ts pins these paths with two regexes over the file text:
// `await precheckDentallyWrite(` must be present and `isDentallyWriteEnabled(`
// must be absent. Neither notices the cheaper regression — a route that ASKS the
// gate and then throws the verdict away — and for recall, reactivation and
// coordinator there was no behavioural test anywhere to catch it either. Deleting
// the refusal branch from all three (leaving the call, so both greps still pass)
// kept the whole 13,000-test suite green.
//
// So this file drives the REAL route handlers with the write path unarmed and the
// base URL on the live practice book — today's production posture — and asserts
// the three properties the W1-A ruling exists to protect:
//
//   1. the staff-facing refusal is the 503 and the exact sentence it always was;
//   2. EXACTLY ONE ledger row per click, blocked / writes_disabled (a route that
//      carries on files a second row from the write it then attempts);
//   3. no Dentally quota is spent on a click that cannot book — no availability
//      read, no client built — which is why the precheck runs where it does.
//
// Only the seams are faked: the ledger, the module repositories, auth, the kill
// switches. isDentallyWriteEnabled and targetsRealDentally are the REAL ones,
// reading a real environment, because the environment is the condition under test.
// ===========================================================================

const h = vi.hoisted(() => ({
  recordWriteIntent: vi.fn<(input: Record<string, unknown>) => Promise<string | null>>(async () => "intent-1"),
  agentClient: vi.fn(),
  fetchAvailabilityDays: vi.fn(async () => []),
  createAppointment: vi.fn(async () => ({ appointment: { id: "appt-new" } })),
}));

vi.mock("@/lib/dentally/sync-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dentally/sync-ledger")>();
  return { ...actual, recordWriteIntent: h.recordWriteIntent };
});
vi.mock("@/lib/dentally/write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dentally/write")>();
  return {
    // The REAL predicates: this test is about the unarmed deployment aimed at the
    // live practice book, which is exactly what they answer.
    isDentallyWriteEnabled: actual.isDentallyWriteEnabled,
    targetsRealDentally: actual.targetsRealDentally,
    // The REAL payload builder: a route that carries on past a discarded refusal
    // must be able to reach its write, or the assertions below would pass for the
    // wrong reason.
    buildManualBookingPayload: actual.buildManualBookingPayload,
    dentallyAgentClient: () => {
      h.agentClient();
      return { createAppointment: h.createAppointment };
    },
  };
});
vi.mock("@/lib/booking/slots", () => ({
  fetchAvailabilityDays: (...a: unknown[]) => h.fetchAvailabilityDays(...(a as [])),
  findExactSlot: () => null,
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => true,
  isSystemExplicitlyDisabled: async () => false,
}));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => null,
  requireSiteAccess: () => null,
  requireModuleApiAccess: () => null,
}));
vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => null,
  hasCapability: async () => true,
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: () => ({ id: "site-ng", clientId: "vitality" }),
}));

const TARGET = {
  id: "site-ng:p-1",
  siteId: "site-ng",
  dentallyPatientId: "p-1",
  dueAt: "2026-09-01T00:00:00.000Z",
  consent: { sms: true, email: true },
};

vi.mock("@/lib/recall/repository", () => ({
  getTarget: async () => TARGET,
  getCadenceByTarget: async () => null,
  createCadence: async () => ({ id: "cad-1" }),
  updateCadence: async () => undefined,
  incrementPriorAttempts: async () => undefined,
  setTargetStatus: async () => undefined,
  markGraduated: async () => undefined,
  insertTouch: async () => ({ id: "t-1" }),
  approveTouch: async () => undefined,
  enqueueOutbox: async () => ({ id: "o-1" }),
  listTouches: async () => [],
  hasPendingOutboxForTouch: async () => false,
}));
vi.mock("@/lib/reactivation/repository", () => ({
  getTarget: async () => TARGET,
  getCadenceByTarget: async () => null,
  createCadence: async () => ({ id: "cad-1" }),
  updateCadence: async () => undefined,
  insertTouch: async () => ({ id: "t-1" }),
  listTouches: async () => [],
  approveTouch: async () => undefined,
  enqueueOutbox: async () => ({ id: "o-1" }),
  incrementPriorAttempts: async () => undefined,
  setTargetStatus: async () => undefined,
}));
vi.mock("@/lib/coordinator/repository", () => ({
  getOpportunity: async () => ({ id: "opp-1", siteId: "site-ng", dentallyPatientId: "p-1" }),
  insertTouch: async () => ({ id: "t-1" }),
  approveTouch: async () => undefined,
  enqueueOutbox: async () => ({ id: "o-1" }),
  listTouches: async () => [],
  setLastTouchAt: async () => undefined,
}));
vi.mock("@/lib/recall/draft", () => ({ draftRecall: async () => ({ body: "x" }) }));
vi.mock("@/lib/reactivation/draft", () => ({ draftReactivation: async () => ({ body: "x" }) }));
vi.mock("@/lib/coordinator/draft", () => ({ draftOutreach: async () => ({ body: "x" }) }));
vi.mock("@/lib/reactivation/settings", () => ({ getMaxLapseMonths: async () => 24 }));

import { POST as recallPost } from "@/app/api/recall/[action]/route";
import { POST as reactivationPost } from "@/app/api/reactivation/[action]/route";
import { POST as coordinatorPost } from "@/app/api/coordinator/[action]/route";

/** The sentence a receptionist reads. It is part of the ruling, not decoration. */
const STAFF_REFUSAL = "Booking into Dentally is not switched on yet. Ask your administrator to enable it.";

/** A body that VALIDATES, so a route with a discarded refusal really carries on. */
const BOOKABLE = {
  start: "2026-09-10T09:00:00.000Z",
  finish_time: "2026-09-10T09:30:00.000Z",
  practitioner_id: 77,
};

type Post = (request: Request, ctx: { params: Promise<{ action: string }> }) => Promise<Response>;

const DOORS: Array<{ name: string; post: Post; body: Record<string, unknown>; source: string }> = [
  {
    name: "recall",
    post: recallPost as Post,
    body: { targetId: TARGET.id, ...BOOKABLE },
    source: "recall",
  },
  {
    name: "reactivation",
    post: reactivationPost as Post,
    body: { targetId: TARGET.id, ...BOOKABLE },
    source: "reactivation",
  },
  {
    name: "coordinator",
    post: coordinatorPost as Post,
    body: { opportunityId: "opp-1", ...BOOKABLE },
    source: "coordinator",
  },
];

function book(door: (typeof DOORS)[number]): Promise<Response> {
  const request = new Request("http://localhost/api/x/book", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(door.body),
  });
  return door.post(request, { params: Promise.resolve({ action: "book" }) });
}

const ENV_KEYS = [
  "DENTALLY_WRITE_ENABLED",
  "DENTALLY_WRITE_API_KEY",
  "DENTALLY_WRITE_BASE_URL",
  "DENTALLY_BASE_URL",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.clearAllMocks();
  h.recordWriteIntent.mockResolvedValue("intent-1");
  h.createAppointment.mockResolvedValue({ appointment: { id: "appt-new" } });
  h.fetchAvailabilityDays.mockResolvedValue([]);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("a staff booking click made while write-back is off is recorded, then refused", () => {
  it.each(DOORS)("$name/book refuses with the 503 the staff sentence belongs to", async (door) => {
    const res = await book(door);
    expect(res.status, `${door.name} no longer refuses the click`).toBe(503);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBe(STAFF_REFUSAL);
  });

  it.each(DOORS)("$name/book files EXACTLY ONE ledger row, blocked / writes_disabled", async (door) => {
    await book(door);
    // One click, one row. A route that discards the verdict carries on to its own
    // write, which the gate refuses again — and the practice's ledger then shows
    // two attempts for one press of a button.
    expect(h.recordWriteIntent, `${door.name} filed the wrong number of intents`).toHaveBeenCalledTimes(1);
    expect(h.recordWriteIntent.mock.calls[0][0]).toMatchObject({
      status: "blocked",
      blockedReason: "writes_disabled",
      kind: "appointment.create",
      source: door.source,
      clientId: "vitality",
      dentallyPatientId: "p-1",
    });
  });

  it.each(DOORS)("$name/book spends no Dentally quota on a booking that cannot happen", async (door) => {
    await book(door);
    // The precheck runs BEFORE the availability read for exactly this reason: the
    // rate budget is shared with production, and a refused click must cost nothing.
    expect(h.fetchAvailabilityDays, `${door.name} read Dentally availability for a refused click`).not.toHaveBeenCalled();
    expect(h.agentClient, `${door.name} built a Dentally client for a refused click`).not.toHaveBeenCalled();
    expect(h.createAppointment, `${door.name} attempted a Dentally write after refusing`).not.toHaveBeenCalled();
  });
});
