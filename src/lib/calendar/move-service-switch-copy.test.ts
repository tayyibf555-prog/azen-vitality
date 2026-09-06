// ===========================================================================
// THE DESK'S OWN REFUSAL DESCRIBES THE DESK.
//
// WHY THIS FILE EXISTS. The 503 body performMove returns when the owner's
// `calendar-writes` switch is off used to be the CATALOG's `halts` sentence,
// read straight out of SYSTEM_BY_SLUG. That was a fine economy until ruling W3/9
// required `halts` to name every door the switch closes — it now ends "— and the
// co-pilot cannot book, move or cancel one either", which is exactly right on
// System controls and a non-sequitur to a receptionist who has just dragged an
// appointment across the grid and been told no.
//
// Reusing one string for two audiences is the defect; two strings that can drift
// apart is the other one. So this file holds BOTH halves at once, and it holds
// them BEHAVIOURALLY — by driving the real performMove with the switch off
// rather than by grepping the constant:
//
//   1. the body the DESK gets says what the DESK can no longer do, and names the
//      control that brings it back;
//   2. the body the DESK gets does NOT relay the co-pilot clause;
//   3. the OWNER's sentence still carries it, so this split did not quietly
//      strip the fact out of the place it belongs (catalog.test.ts derives that
//      requirement from the write registry; this asserts the two are DIFFERENT
//      strings, which is the property a future "let's just reuse halts again"
//      would break);
//   4. nothing is written to Dentally and no patient is texted — the reason the
//      switch exists at all.
//
// Only the I/O seams are faked, the same set and the same shape as
// move-service-continuity.test.ts: auth, the site table, the kill switch, the
// Dentally write client, the Dentally reads and the diary tables. The real
// performMove runs.
// ===========================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  systemEnabled: true,
  book: new Map<string, Record<string, unknown>[]>(),
  updateAppointment: vi.fn(async (id: string) => ({ appointment: { id } })),
  insertMove: vi.fn(async (): Promise<string | null> => "move-1"),
  insertTouch: vi.fn(async () => ({ id: "touch-1" })),
  enqueueOutbox: vi.fn(async () => ({ id: "outbox-1" })),
}));

vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient {
    constructor() {
      throw new Error("a DentallyClient was constructed directly");
    }
  },
  DentallyError: class DentallyError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/auth/guard", () => ({
  authEnforced: () => true,
  requireUser: async () => ({
    id: "u-1",
    name: "Blerta",
    email: "manager@example.com",
    role: "client_coordinator",
    clientId: "vitality",
    siteIds: ["site-cc"],
  }),
  requireClientAccess: () => null,
  requireSiteAccess: () => null,
}));

vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) =>
    id === "site-cc"
      ? {
          id: "site-cc",
          clientId: "vitality",
          name: "Vitality Dental Care N15",
          openingHours: null,
          publicPhone: null,
        }
      : undefined,
  dentallySiteId: (id: string) => `uuid-${id}`,
  getSites: () => [{ id: "site-cc", clientId: "vitality", name: "Vitality Dental Care N15" }],
}));

// THE SWITCH ITSELF, and it is the only seam this file actually varies.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabledStrict: async () => h.systemEnabled,
  isSystemEnabled: async () => h.systemEnabled,
}));

vi.mock("@/lib/dentally/write", () => ({
  isDentallyWriteEnabled: () => true,
  targetsRealDentally: () => true,
  dentallyAgentClient: () => ({
    listAppointments: async (a: { fromDate?: string }) => ({
      appointments: h.book.get(a.fromDate ?? "") ?? [],
    }),
    updateAppointment: h.updateAppointment,
  }),
}));

vi.mock("@/lib/dentally/read", () => ({
  listSitePractitionersSafe: async () => ({
    practitioners: [
      { id: "prac-1", name: "Dana Hale" },
      { id: "prac-2", name: "Femi Osei" },
    ],
    failed: false,
  }),
  listDiaryAvailabilitySafe: async () => ({
    unanswerableDayKeys: [] as string[],
    answerableFromMin: {} as Record<string, number>,
    rows: [
      { practitioner_id: "prac-1", start_time: AT(8, 0), finish_time: AT(19, 0) },
      { practitioner_id: "prac-2", start_time: AT(8, 0), finish_time: AT(19, 0) },
    ],
    failed: false,
  }),
  invalidateAppointmentsCache: vi.fn(),
}));

vi.mock("@/lib/calendar/repository", () => ({
  listEntries: async () => ({ entries: [], failed: false }),
  insertMove: h.insertMove,
  insertTouch: h.insertTouch,
  enqueueOutbox: h.enqueueOutbox,
  listMovesForAppointment: async () => ({ moves: [], failed: false }),
}));

vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => null,
  hasCapability: async () => true,
}));

vi.mock("@/lib/telemetry", () => ({ recordUsage: async () => undefined }));

import { performMove } from "./move-service";
import { SYSTEM_BY_SLUG } from "@/lib/systems/catalog";

// Fri 31 Jul 2026 is BST, so 09:30 London is 08:30Z. Instants throughout.
const DAY = "2026-07-31";
function AT(hh: number, mm = 0): string {
  return new Date(Date.UTC(2026, 6, 31, hh - 1, mm, 0)).toISOString();
}
const APPT_ID = "appt-1";

function row(): Record<string, unknown> {
  return {
    id: APPT_ID,
    patient_id: "pat-9",
    patient_name: "Nadia Lamprell",
    site_id: "uuid-site-cc",
    start_time: AT(9, 30),
    finish_time: AT(10, 0),
    duration: 30,
    state: "confirmed",
    reason: "Checkup",
    practitioner_id: "prac-1",
  };
}

/** A plain time move, same clinician: nothing else can refuse it. */
function body(): unknown {
  return {
    siteId: "site-cc",
    day: DAY,
    startTime: AT(14, 30),
    finishTime: AT(15, 0),
    practitionerId: "prac-1",
    expected: { startTime: AT(9, 30), finishTime: AT(10, 0), practitionerId: "prac-1" },
    notifyPatient: true,
  };
}

async function call(): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await performMove(APPT_ID, body());
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.systemEnabled = true;
  h.book = new Map([[DAY, [row()]]]);
});

describe("the diary switch refusal is written for the desk, not for System controls", () => {
  it("tells the person at the desk what the desk can no longer do, and where the switch is", async () => {
    h.systemEnabled = false;
    const { status, json } = await call();
    expect(status).toBe(503);
    const error = String(json.error);
    // What they were trying to do, in the words of the thing they were doing it in.
    expect(error, "the desk refusal no longer says what the desk cannot do").toMatch(
      /moved, reassigned or resized from the diary/i,
    );
    // And where it comes back from, because a receptionist reading a flat "no"
    // has nowhere to go with it.
    expect(error, "the desk refusal does not name the control that restores it").toMatch(
      /System controls/i,
    );
  });

  it("does NOT relay the co-pilot clause the owner's sentence carries", async () => {
    // THE DEFECT THIS PINS. The body was `SYSTEM_BY_SLUG.get("calendar-writes")?.halts`,
    // so the day ruling W3/9 added "— and the co-pilot cannot book, move or
    // cancel one either" to the owner's sentence, a receptionist dragging an
    // appointment started being told about a tool they may not even have.
    h.systemEnabled = false;
    const { json } = await call();
    expect(
      String(json.error),
      "the desk refusal is relaying the owner's co-pilot clause again",
    ).not.toMatch(/co-pilot/i);
  });

  it("leaves the OWNER's sentence carrying it — two audiences, two strings", () => {
    // The other direction, so this split cannot be 'fixed' by trimming the
    // catalog instead. catalog.test.ts derives the co-pilot clause from the
    // write registry; what is asserted HERE is that the desk's body and the
    // catalog's sentence are no longer the same string, which is the property a
    // future "just reuse halts again" would break.
    const halts = SYSTEM_BY_SLUG.get("calendar-writes")?.halts ?? "";
    expect(halts, "the owner's sentence lost the co-pilot clause").toMatch(/co-pilot/i);
    expect(halts).toMatch(/from the diary/i);
  });

  it("writes nothing to Dentally and texts nobody, which is why the switch exists", async () => {
    h.systemEnabled = false;
    const { status } = await call();
    expect(status).toBe(503);
    expect(h.updateAppointment).not.toHaveBeenCalled();
    expect(h.insertTouch).not.toHaveBeenCalled();
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("still moves the appointment with the switch ON, so the refusal is the switch and not this file", async () => {
    // The control. Without it every assertion above passes on a move that was
    // refused for some unrelated reason.
    h.updateAppointment.mockImplementation(async (id: string) => {
      const rows = h.book.get(DAY) ?? [];
      h.book.set(
        DAY,
        rows.map((r) =>
          r.id === id ? { ...r, start_time: AT(14, 30), finish_time: AT(15, 0) } : r,
        ),
      );
      return { appointment: { id } };
    });
    const { status, json } = await call();
    expect(status).toBe(200);
    expect(json.confirmed).toBe(true);
    expect(h.updateAppointment).toHaveBeenCalledTimes(1);
  });
});
