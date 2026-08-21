// ===========================================================================
// THE CONTINUING-TREATMENT RULE, PROVED ON THE SERVER.
//
// WHY THIS FILE EXISTS. The rule was already tested twice, in continuity.test.ts
// and move-validate.test.ts, and both of those test the PURE function. Neither
// touches the wiring, and the wiring is the whole security argument: the client
// refuses a bad drop for the reader's benefit, and the server re-runs the same
// check against a row IT re-read, because a caller who does not use the UI is
// exactly who the server-side re-validation exists for.
//
// The gap was measured, not guessed. Replacing
//
//     movingReason: current.reason,
//
// in move-service.ts with the literal "Checkup" — which is a server that would
// hand any root canal to any clinician and write it to Dentally — left all 4364
// tests in this repo passing. The route's own test file drives a "Scale &
// Polish" move, so it proves a TRANSFERABLE reason is allowed and nothing about
// a continuing one being refused. That mutant is killed here.
//
// Only the I/O seams are faked, exactly as the route's own test does it: auth,
// the site table, the kill switch, the Dentally write client, the Dentally reads
// and the diary tables. The real performMove, the real validateMove and the real
// continuity module all run.
// ===========================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  book: new Map<string, Record<string, unknown>[]>(),
  availability: { rows: [] as unknown[], failed: false },
  updateAppointment: vi.fn(async (id: string) => ({ appointment: { id } })),
  // The row is captured, not ignored: the refusal audit is asserted below.
  insertMove: vi.fn(async (row: Record<string, unknown>): Promise<string | null> =>
    row ? "move-1" : null,
  ),
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

vi.mock("@/lib/systems/repository", () => ({ isSystemEnabledStrict: async () => true }));

vi.mock("@/lib/dentally/write", () => ({
  isDentallyWriteEnabled: () => true,
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
  // The real read also reports which requested days Dentally cannot answer for
  // (a day that has ended). Defaulted to none here so every existing case is
  // unchanged; a case that wants that path sets it on h.availability.
  listDiaryAvailabilitySafe: async () => ({ unanswerableDayKeys: [] as string[], ...h.availability }),
  invalidateAppointmentsCache: vi.fn(),
}));

vi.mock("@/lib/calendar/repository", () => ({
  listEntries: async () => ({ entries: [], failed: false }),
  insertMove: h.insertMove,
  insertTouch: h.insertTouch,
  enqueueOutbox: h.enqueueOutbox,
  listMovesForAppointment: async () => ({ moves: [], failed: false }),
}));

// The PER-PERSON capability gate, faked at the seam. Its own behaviour is proven
// in src/lib/auth/capability-guard.test.ts; that this route calls it is proven by
// the fs sweep in src/app/api/destructive-route-capability-coverage.test.ts.
vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => null,
  hasCapability: async () => true,
}));


vi.mock("@/lib/telemetry", () => ({ recordUsage: async () => undefined }));

import { performMove } from "./move-service";

// Fri 31 Jul 2026 is BST, so 09:30 London is 08:30Z. Instants throughout.
const DAY = "2026-07-31";
const AT = (hh: number, mm = 0): string =>
  new Date(Date.UTC(2026, 6, 31, hh - 1, mm, 0)).toISOString();
const APPT_ID = "appt-1";

/** The row the SERVER re-reads for itself. Its `reason` is the one that counts. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APPT_ID,
    patient_id: "pat-9",
    patient_name: "Nadia Lamprell",
    site_id: "uuid-site-cc",
    start_time: AT(9, 30),
    finish_time: AT(10, 0),
    duration: 30,
    state: "confirmed",
    reason: "Scale & Polish",
    practitioner_id: "prac-1",
    ...over,
  };
}

/** A move to the OTHER clinician, at a time both of them are free. */
function crossClinicianBody(over: Record<string, unknown> = {}): unknown {
  return {
    siteId: "site-cc",
    day: DAY,
    startTime: AT(14, 30),
    finishTime: AT(15, 0),
    practitionerId: "prac-2",
    expected: { startTime: AT(9, 30), finishTime: AT(10, 0), practitionerId: "prac-1" },
    notifyPatient: false,
    ...over,
  };
}

/** The same appointment, three hours later, with the SAME clinician. */
function sameClinicianBody(): unknown {
  return {
    siteId: "site-cc",
    day: DAY,
    startTime: AT(14, 30),
    finishTime: AT(15, 0),
    practitionerId: "prac-1",
    expected: { startTime: AT(9, 30), finishTime: AT(10, 0), practitionerId: "prac-1" },
    notifyPatient: false,
  };
}

async function call(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await performMove(APPT_ID, body);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.book = new Map([[DAY, [row()]]]);
  h.availability = {
    rows: [
      { practitioner_id: "prac-1", start_time: AT(8, 0), finish_time: AT(19, 0) },
      { practitioner_id: "prac-2", start_time: AT(8, 0), finish_time: AT(19, 0) },
    ],
    failed: false,
  };
  h.updateAppointment.mockImplementation(async (id: string) => {
    const rows = h.book.get(DAY) ?? [];
    h.book.set(
      DAY,
      rows.map((r) =>
        r.id === id
          ? { ...r, start_time: AT(14, 30), finish_time: AT(15, 0), practitioner_id: "prac-2" }
          : r,
      ),
    );
    return { appointment: { id } };
  });
});

describe("performMove: the continuing-treatment rule, server side", () => {
  it("REFUSES a continuing course handed to another clinician, and writes NOTHING", async () => {
    h.book = new Map([[DAY, [row({ reason: "Root canal review" })]]]);
    const { status, json } = await call(crossClinicianBody());
    expect(status).toBe(409);
    expect(String(json.error)).toContain("Dana Hale");
    expect(String(json.error)).toContain("continuing treatment");
    // THE WHOLE POINT: nothing reaches Dentally, and the patient is not texted.
    expect(h.updateAppointment).not.toHaveBeenCalled();
    expect(h.insertTouch).not.toHaveBeenCalled();
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
    // The refusal IS written to this platform's own move history — deliberately,
    // see refuse() in move-service.ts: "why did that not save" is a question
    // asked a week later. It is a local audit row, never a Dentally write, and
    // it carries the reason so the answer is in the row itself.
    expect(h.insertMove).toHaveBeenCalledTimes(1);
    const audit = h.insertMove.mock.calls[0][0] as Record<string, unknown>;
    expect(audit.outcome).toBe("refused");
    expect(String(audit.detail)).toContain("Dana Hale");
  });

  it("refuses the same course typed as Continuing Treatment", async () => {
    h.book = new Map([[DAY, [row({ reason: "Continuing Treatment" })]]]);
    const { status } = await call(crossClinicianBody());
    expect(status).toBe(409);
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("refuses an AMBIGUOUS reason across clinicians, because the fail-safe side is refusal", async () => {
    for (const reason of ["Review", "Emergency", "Something nobody has typed before", null]) {
      vi.clearAllMocks();
      h.book = new Map([[DAY, [row({ reason })]]]);
      const { status } = await call(crossClinicianBody());
      expect(status).toBe(409);
      expect(h.updateAppointment).not.toHaveBeenCalled();
    }
  });

  it("ALLOWS a checkup across clinicians, so the rule has not simply frozen the diary", async () => {
    h.book = new Map([[DAY, [row({ reason: "Checkup" })]]]);
    const { status, json } = await call(crossClinicianBody());
    expect(status).toBe(200);
    expect(json.confirmed).toBe(true);
    expect(h.updateAppointment).toHaveBeenCalledTimes(1);
  });

  it("ALLOWS a continuing course to move in TIME within its own clinician's column", async () => {
    h.book = new Map([[DAY, [row({ reason: "Root canal review" })]]]);
    h.updateAppointment.mockImplementation(async (id: string) => {
      const rows = h.book.get(DAY) ?? [];
      h.book.set(
        DAY,
        rows.map((r) =>
          r.id === id
            ? { ...r, start_time: AT(14, 30), finish_time: AT(15, 0), practitioner_id: "prac-1" }
            : r,
        ),
      );
      return { appointment: { id } };
    });
    const { status, json } = await call(sameClinicianBody());
    expect(status).toBe(200);
    expect(json.confirmed).toBe(true);
    expect(h.updateAppointment).toHaveBeenCalledTimes(1);
  });

  it("reads the reason off ITS OWN row, so a client cannot launder a course by omitting it", async () => {
    // The request body carries a harmless-looking reason. The server never looks
    // at it: `current` is the row it re-read from Dentally, and that row says
    // root canal. If this ever passes with a 200, the client is the only thing
    // enforcing a clinical rule.
    h.book = new Map([[DAY, [row({ reason: "Root canal review" })]]]);
    const { status } = await call(crossClinicianBody({ reason: "Checkup", movingReason: "Checkup" }));
    expect(status).toBe(409);
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("names the clinician from the SITE's practitioner list, not from the raw row", async () => {
    h.book = new Map([[DAY, [row({ reason: "Root canal review", practitioner: "Someone Else" })]]]);
    const { json } = await call(crossClinicianBody());
    expect(String(json.error)).toContain("Dana Hale");
  });

  it("still refuses when the availability read fails, though for the read's reason first", async () => {
    // A DELIBERATE DIVERGENCE FROM THE CLIENT, recorded here so nobody 'fixes'
    // it by accident. validateMove puts continuity at check 2, before
    // hours_unknown, because on the grid "it has to stay with Dana Hale" is the
    // more useful of the two sentences. The SERVER refuses an unreadable
    // availability read outright at step 12, before it builds a validateMove
    // context at all, so the outage sentence wins there. Both refuse, neither
    // writes, and that is the only property that has to hold.
    h.book = new Map([[DAY, [row({ reason: "Root canal review" })]]]);
    h.availability = { rows: [], failed: true };
    const { status, json } = await call(crossClinicianBody());
    expect(status).toBe(503);
    expect(String(json.error)).toContain("could not check the clinician's working hours");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });
});
