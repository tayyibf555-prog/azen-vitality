// ===========================================================================
// The appointment MOVE route: the guard chain, the server-side re-validation,
// the read-back confirmation and the patient's text.
//
// This drives the REAL handler and the REAL move-service, the REAL pure
// validator (move-validate), the REAL notify predicate and the REAL patient
// draft. Only the I/O seams are faked: auth, the site table, the kill switch,
// the Dentally write client, the Dentally reads, the diary tables and telemetry.
//
// The DentallyClient constructor is booby-trapped, exactly as the no-show write
// gate test does, so a direct ungated client build fails loudly rather than
// silently reaching a real practice.
// ===========================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  authEnforced: true,
  user: {
    id: "u-1",
    name: "Blerta",
    email: "manager@example.com",
    role: "client_coordinator",
    clientId: "vitality",
    siteIds: ["site-cc"],
  } as Record<string, unknown> | null,
  systemEnabled: true,
  writeEnabled: true,
  // The day's rows, keyed by London day. Mutated by updateAppointment when the
  // write is meant to land, so the read-back sees what a real write would leave.
  book: new Map<string, Record<string, unknown>[]>(),
  practitioners: { practitioners: [{ id: "prac-1", name: "Jin Kim" }, { id: "prac-2", name: "Femi Osei" }], failed: false },
  availability: { rows: [], failed: false } as {
    rows: unknown[];
    failed: boolean;
    /** Set only by the past-day case; the mock defaults it to none. */
    unanswerableDayKeys?: string[];
    /** Set only by the part-elapsed-today case; the mock defaults it to none. */
    answerableFromMin?: Record<string, number>;
  },
  entries: { entries: [] as unknown[], failed: false },
  updateAppointment: vi.fn(async (_id: string, _payload: Record<string, unknown>) => ({ appointment: { id: _id } })),
  applyWrite: true,
  listThrows: false,
  readBackThrows: false,
  invalidate: vi.fn((_ids: string[]) => undefined),
  insertMove: vi.fn(async (_row: Record<string, unknown>): Promise<string | null> => "move-1"),
  insertTouch: vi.fn(async (_i: Record<string, unknown>) => ({ id: "touch-1" })),
  enqueueOutbox: vi.fn(async (_i: Record<string, unknown>) => ({ id: "outbox-1" })),
  publicPhone: null as string | null,
  twoSites: false,
  otherSitePractitioners: { practitioners: [] as { id: string; name: string }[], failed: false },
  /** What requireCapability("diary.appointment.move") answers. null = allowed. */
  capabilityDenied: null as Response | null,
}));

vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient {
    constructor() {
      throw new Error("a DentallyClient was constructed directly; writes must go through dentallyAgentClient()");
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
  authEnforced: () => h.authEnforced,
  requireUser: async () => h.user,
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
          publicPhone: h.publicPhone,
        }
      : undefined,
  dentallySiteId: (id: string) => `uuid-${id}`,
  // ONE site, so no practitioner is shared with another practice and the
  // cross-site presence guard passes. Its own behaviour is tested in
  // src/lib/calendar/site-presence.test.ts.
  getSites: () =>
    h.twoSites
      ? [
          { id: "site-cc", clientId: "vitality", name: "Vitality Dental Care N15" },
          { id: "site-rv", clientId: "vitality", name: "N17 Dental" },
        ]
      : [{ id: "site-cc", clientId: "vitality", name: "Vitality Dental Care N15" }],
}));

vi.mock("@/lib/systems/repository", () => ({
  isSystemExplicitlyDisabled: async () => false,
  // The move path deliberately uses the STRICT reader, which fails closed
  // whatever MESSAGING_DRY_RUN says. See src/lib/systems/repository.ts.
  isSystemEnabledStrict: async () => h.systemEnabled,
  // The WriteGate reads the fail-OPEN one while writes are only simulated.
  isSystemEnabled: async () => h.systemEnabled,
}));

vi.mock("@/lib/dentally/write", () => ({
  isDentallyWriteEnabled: () => h.writeEnabled,
  // Added when the WriteGate landed. The gate resolves the target host through
  // the same predicate the client factory uses, so a partial mock of this module
  // has to carry it — and `true` is the posture these tests are ABOUT: a
  // production deployment whose base URL is the live practice book. That is
  // exactly when "writes are off" has to mean nothing happens at all, rather
  // than a write landing in a local mock.
  targetsRealDentally: () => true,
  dentallyAgentClient: () => ({
    listAppointments: async (a: { fromDate?: string }) => {
      if (h.listThrows) throw new Error("dentally is down");
      return { appointments: h.book.get(a.fromDate ?? "") ?? [] };
    },
    updateAppointment: h.updateAppointment,
  }),
}));

vi.mock("@/lib/dentally/read", () => ({
  listSitePractitionersSafe: async (siteId: string) =>
    siteId === "site-cc" ? h.practitioners : h.otherSitePractitioners,
  // The real read also reports which requested days Dentally cannot answer for
  // (a day that has ended). Defaulted to none here so every existing case is
  // unchanged; a case that wants that path sets it on h.availability.
  listDiaryAvailabilitySafe: async () => ({
    unanswerableDayKeys: [] as string[],
    answerableFromMin: {} as Record<string, number>,
    ...h.availability,
  }),
  invalidateAppointmentsCache: h.invalidate,
}));

vi.mock("@/lib/calendar/repository", () => ({
  listEntries: async () => h.entries,
  insertMove: h.insertMove,
  insertTouch: h.insertTouch,
  enqueueOutbox: h.enqueueOutbox,
  listMovesForAppointment: async () => ({ moves: [], failed: false }),
}));

vi.mock("@/lib/telemetry", () => ({ recordUsage: async () => undefined }));

vi.mock("@/lib/calendar/access", () => ({
  requireDiaryAdmin: async () => ({ auth: h.user, siteId: "site-cc", clientId: "vitality" }),
}));

// The PER-PERSON gate (step 3b of the chain), faked at the seam like every other
// I/O boundary here: the real one reads user_capability through the service-role
// client, and its own behaviour — including the 503 when auth is not enforced —
// is proven in src/lib/auth/capability-guard.test.ts. What THIS file proves is
// that the move refuses when it says no, and that nothing reaches Dentally when
// it does.
vi.mock("@/lib/auth/capability-guard", () => ({
  requireCapability: async () => h.capabilityDenied,
  hasCapability: async () => h.capabilityDenied === null,
}));

import { PATCH } from "./route";

// Fri 31 Jul 2026 is BST, so 09:30 London is 08:30Z. Written as instants
// throughout, never as sliced strings: a string slice passes against a Z-emitting
// mock and is an hour wrong in the practice.
const DAY = "2026-07-31";
const AT = (hh: number, mm = 0): string =>
  new Date(Date.UTC(2026, 6, 31, hh - 1, mm, 0)).toISOString();

const APPT_ID = "appt-1";

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

/** A full working day for both clinicians, so a legal drop is genuinely legal. */
function fullDayAvailability(): unknown[] {
  return [
    { practitioner_id: "prac-1", start_time: AT(8, 0), finish_time: AT(19, 0) },
    { practitioner_id: "prac-2", start_time: AT(8, 0), finish_time: AT(19, 0) },
  ];
}

function body(over: Record<string, unknown> = {}): unknown {
  return {
    siteId: "site-cc",
    day: DAY,
    startTime: AT(14, 30),
    finishTime: AT(15, 0),
    practitionerId: "prac-2",
    expected: { startTime: AT(9, 30), finishTime: AT(10, 0), practitionerId: "prac-1" },
    notifyPatient: true,
    ...over,
  };
}

async function call(b: unknown = body(), id = APPT_ID) {
  const res = await PATCH(
    new Request(`http://localhost/api/calendar/appointment/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { res, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.authEnforced = true;
  h.user = {
    id: "u-1",
    name: "Blerta",
    email: "manager@example.com",
    role: "client_coordinator",
    clientId: "vitality",
    siteIds: ["site-cc"],
  };
  h.systemEnabled = true;
  h.writeEnabled = true;
  h.capabilityDenied = null;
  h.applyWrite = true;
  h.listThrows = false;
  h.readBackThrows = false;
  h.publicPhone = null;
  h.twoSites = false;
  h.otherSitePractitioners = { practitioners: [], failed: false };
  h.practitioners = {
    practitioners: [
      { id: "prac-1", name: "Jin Kim" },
      { id: "prac-2", name: "Femi Osei" },
    ],
    failed: false,
  };
  h.availability = { rows: fullDayAvailability(), failed: false };
  h.entries = { entries: [], failed: false };
  h.book = new Map([[DAY, [row()]]]);
  h.insertMove.mockImplementation(async () => "move-1");
  h.updateAppointment.mockImplementation(async (id: string, payload: Record<string, unknown>) => {
    if (h.readBackThrows) h.listThrows = true;
    if (h.applyWrite) {
      const rows = h.book.get(DAY) ?? [];
      h.book.set(
        DAY,
        rows.map((r) =>
          r.id === id
            ? {
                ...r,
                start_time: payload.start_time,
                finish_time: payload.finish_time,
                practitioner_id: payload.practitioner_id,
              }
            : r,
        ),
      );
    }
    // Exactly what the real client synthesises on a 204 or an empty body: the id
    // you sent, echoed back. This is why a resolved promise proves nothing.
    return { appointment: { id } };
  });
});

// ---------------------------------------------------------------------------
// The guard chain, in its exact order.
// ---------------------------------------------------------------------------

describe("the guard chain", () => {
  it("FAILS CLOSED when auth is not enforced, against the platform's permissive default", async () => {
    h.authEnforced = false;
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(String(json.error)).toContain("sign-in is not configured");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("refuses a role below patient-admin", async () => {
    h.user = { ...(h.user as Record<string, unknown>), role: "client_viewer" };
    const { res } = await call();
    expect(res.status).toBe(403);
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("ALLOWS client_coordinator, who is the practice manager and the diary's primary user", async () => {
    const { res, json } = await call();
    expect(res.status).toBe(200);
    expect(json.confirmed).toBe(true);
  });

  it("allows client_owner and agency_admin", async () => {
    for (const role of ["client_owner", "agency_admin"]) {
      h.book = new Map([[DAY, [row()]]]);
      h.user = { ...(h.user as Record<string, unknown>), role };
      const { res } = await call();
      expect(res.status).toBe(200);
    }
  });

  it("refuses when the PERSON's capability has been revoked, even though the role allows it", async () => {
    // The role check above says a practice manager may move appointments. This
    // says THIS practice manager may not — the owner turned it off for her on the
    // People & logins screen. Both gates are real and neither replaces the other.
    h.capabilityDenied = Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    const { res, json } = await call();
    expect(res.status).toBe(403);
    expect(json.error).toBe("forbidden");
    expect(h.updateAppointment).not.toHaveBeenCalled();
    expect(h.insertMove).not.toHaveBeenCalled();
  });

  it("checks the capability BEFORE the kill switch and the write gate", async () => {
    // Ordering matters: a caller who may not act must not cause a toggle read, a
    // Dentally client build, or any other work on their behalf.
    h.capabilityDenied = Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    h.systemEnabled = false;
    h.writeEnabled = false;
    h.listThrows = true; // any read at all would throw and change the status
    const { res } = await call();
    expect(res.status).toBe(403);
  });

  it("stops at the owner's kill switch before any write", async () => {
    h.systemEnabled = false;
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(String(json.error)).toContain("no longer be moved");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("stops at the Dentally write gate with the standardised sentence, and touches nothing", async () => {
    h.writeEnabled = false;
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(json.error).toBe(
      "Booking into Dentally is not switched on yet. Ask your administrator to enable it.",
    );
    expect(h.updateAppointment).not.toHaveBeenCalled();
    expect(h.insertTouch).not.toHaveBeenCalled();
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("checks the write gate BEFORE reading anything through the agent client", async () => {
    // dentallyAgentClient FAILS OPEN and hands back a working client pointed at
    // the mock, so a gate checked after the client is built is not a gate.
    h.writeEnabled = false;
    h.listThrows = true; // any read at all would throw and change the status
    const { res } = await call();
    expect(res.status).toBe(503);
  });

  it("refuses an unknown site", async () => {
    const { res } = await call(body({ siteId: "site-nope" }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Nothing the client claims is trusted.
// ---------------------------------------------------------------------------

describe("server-side re-validation", () => {
  it("refuses a move to Unassigned", async () => {
    const { res, json } = await call(body({ practitionerId: null }));
    expect(res.status).toBe(400);
    expect(String(json.error)).toContain("cannot be moved to Unassigned");
  });

  it("404s an appointment belonging to another site, revealing nothing", async () => {
    h.book = new Map([[DAY, [row({ site_id: "uuid-site-rv" })]]]);
    const { res, json } = await call();
    expect(res.status).toBe(404);
    expect(json.error).toBe("not found");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("404s a row carrying no site at all, rather than assuming the caller's", async () => {
    h.book = new Map([[DAY, [row({ site_id: "" })]]]);
    const { res } = await call();
    expect(res.status).toBe(404);
  });

  it("409s when the appointment changed under the reader", async () => {
    h.book = new Map([[DAY, [row({ start_time: AT(11, 0), finish_time: AT(11, 30) })]]]);
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("changed while you were moving it");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("409s when the clinician changed under the reader", async () => {
    h.book = new Map([[DAY, [row({ practitioner_id: "prac-2" })]]]);
    const { res } = await call();
    expect(res.status).toBe(409);
  });

  it("404s a practitioner who is not on this site's own list (the only cross-site guard)", async () => {
    h.practitioners = { practitioners: [{ id: "prac-1", name: "Jin Kim" }], failed: false };
    const { res, json } = await call();
    expect(res.status).toBe(404);
    expect(json.error).toBe("not found");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("refuses rather than guessing when the clinician list could not be read", async () => {
    h.practitioners = { practitioners: [], failed: true };
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(String(json.error)).toContain("clinician list");
  });

  it("refuses a length Dentally will not accept", async () => {
    const { res, json } = await call(body({ finishTime: AT(14, 33) }));
    expect(res.status).toBe(400);
    expect(String(json.error)).toContain("five minute mark");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("refuses a day that does not agree with the start time", async () => {
    const { res, json } = await call(body({ day: "2026-08-04" }));
    expect(res.status).toBe(400);
    expect(String(json.error)).toContain("date and the time do not agree");
  });
});

// ---------------------------------------------------------------------------
// The six drop checks, re-run against inputs the server fetched itself.
// ---------------------------------------------------------------------------

describe("the drop checks, server side", () => {
  it("refuses a drop outside the clinician's working hours", async () => {
    h.availability = {
      rows: [{ practitioner_id: "prac-2", start_time: AT(8, 0), finish_time: AT(12, 0) }],
      failed: false,
    };
    // prac-1 keeps a window so the appointment's own column still reads as working.
    (h.availability.rows as unknown[]).push({
      practitioner_id: "prac-1",
      start_time: AT(8, 0),
      finish_time: AT(19, 0),
    });
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("outside Femi Osei's working hours");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("refuses a drop onto an occupied span", async () => {
    h.book = new Map([
      [
        DAY,
        [
          row(),
          row({ id: "appt-2", start_time: AT(14, 30), finish_time: AT(15, 0), practitioner_id: "prac-2" }),
        ],
      ],
    ]);
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("already has an appointment at 14:30");
  });

  it("a cancelled booking does NOT occupy: the slot is recoverable", async () => {
    h.book = new Map([
      [
        DAY,
        [
          row(),
          row({
            id: "appt-2",
            start_time: AT(14, 30),
            finish_time: AT(15, 0),
            practitioner_id: "prac-2",
            state: "cancelled",
          }),
        ],
      ],
    ]);
    const { res } = await call();
    expect(res.status).toBe(200);
  });

  it("refuses a drop onto a break", async () => {
    h.entries = {
      entries: [
        {
          id: "e-1",
          clientId: "vitality",
          siteId: "site-cc",
          practitionerId: "prac-2",
          day: DAY,
          startMin: 14 * 60,
          endMin: 15 * 60,
          kind: "break",
          title: "Lunch",
          body: null,
          authorName: "Team",
          createdAt: "",
          updatedAt: "",
        },
      ],
      failed: false,
    };
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("has a break booked at that time");
  });

  it("a NOTE does not block a drop", async () => {
    h.entries = {
      entries: [
        {
          id: "e-1",
          clientId: "vitality",
          siteId: "site-cc",
          practitionerId: "prac-2",
          day: DAY,
          startMin: 14 * 60,
          endMin: 15 * 60,
          kind: "note",
          title: "Shak working",
          body: null,
          authorName: "Team",
          createdAt: "",
          updatedAt: "",
        },
      ],
      failed: false,
    };
    const { res } = await call();
    expect(res.status).toBe(200);
  });

  it("refuses every move while availability could not be read: the diary goes read only", async () => {
    h.availability = { rows: [], failed: true };
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(String(json.error)).toContain("could not check the clinician's working hours");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("refuses a move onto a day that has already gone, as a rule and not an outage", async () => {
    // Dentally will not report working hours for a date that has passed, so there
    // is nothing to check the drop against. Checking it against the day's own
    // bookings alone would accept a patient into whatever gap happened to sit
    // between two appointments on a day nobody can verify.
    h.availability = { rows: [], failed: false, unanswerableDayKeys: [DAY] };
    const { res, json } = await call();
    // 409, not the 503 an outage gets: retrying cannot change a date.
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("passed");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("refuses a move onto TODAY when the hours we could ask about are already gone", async () => {
    // Dentally answers availability only from now forward, so a session that had
    // already closed is absent from the answer -- and nothing came back for the
    // rest of the day either. The grid hatches that column instead of greying it,
    // and this refusal is the same statement on the write side.
    h.availability = { rows: [], failed: false, answerableFromMin: { [DAY]: 15 * 60 + 2 } };
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("from now onwards");
    // NOT the past-day sentence: the date is today, and today has not passed.
    expect(String(json.error)).not.toContain("passed");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("still refuses an empty answer as plain 'outside working hours' when the day was answerable", async () => {
    // The contrast that proves the new refusal is doing work rather than
    // renaming the old one: with the whole day asked about, an empty answer
    // really does mean the clinician is not in.
    h.availability = { rows: [], failed: false };
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("outside");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("refuses every move while breaks and notes could not be read", async () => {
    h.entries = { entries: [], failed: true };
    const { res, json } = await call();
    expect(res.status).toBe(503);
    expect(String(json.error)).toContain("breaks and notes");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("treats a mostly untagged availability read as a failed one", async () => {
    h.availability = {
      rows: [
        { start_time: AT(8, 0), finish_time: AT(19, 0) },
        { start_time: AT(8, 0), finish_time: AT(19, 0) },
        { practitioner_id: "prac-2", start_time: AT(8, 0), finish_time: AT(19, 0) },
      ],
      failed: false,
    };
    const { res } = await call();
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// The payload.
// ---------------------------------------------------------------------------

describe("the payload sent to Dentally", () => {
  it("is built fresh: exactly start_time, finish_time and practitioner_id", async () => {
    await call();
    expect(h.updateAppointment).toHaveBeenCalledTimes(1);
    const [id, payload] = h.updateAppointment.mock.calls[0];
    expect(id).toBe(APPT_ID);
    expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
      "finish_time",
      "practitioner_id",
      "start_time",
    ]);
  });

  it("never sends `duration`, which Dentally is not proven to accept on a write", async () => {
    await call();
    expect(h.updateAppointment.mock.calls[0][1]).not.toHaveProperty("duration");
  });

  it("never forwards a smuggled field from the request body", async () => {
    await call(body({ state: "cancelled", patient_id: "someone-else", notes: "x" }));
    const payload = h.updateAppointment.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("state");
    expect(payload).not.toHaveProperty("patient_id");
    expect(payload).not.toHaveProperty("notes");
  });

  it("always carries finish_time, so a move can never silently change the length", async () => {
    await call();
    const payload = h.updateAppointment.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.finish_time).toBe(AT(15, 0));
  });
});

// ---------------------------------------------------------------------------
// The read-back.
// ---------------------------------------------------------------------------

describe("read-back confirmation", () => {
  it("confirms only when all three fields really changed", async () => {
    const { res, json } = await call();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.confirmed).toBe(true);
  });

  it("reports not_saved when the read-back still shows the old values", async () => {
    // The write reports success and changes nothing: exactly what a resolved
    // promise from updateAppointment cannot rule out.
    h.applyWrite = false;
    const { json } = await call();
    expect(json.ok).toBe(false);
    expect(json.confirmed).toBe(false);
    expect(json.reason).toBe("not_saved");
  });

  it("reports unknown, and claims nothing, when the read-back itself fails", async () => {
    h.readBackThrows = true;
    const { json } = await call();
    expect(json.confirmed).toBe(false);
    expect(json.reason).toBe("unknown");
    expect(String(json.error)).toContain("may or may not have saved");
  });

  it("answers from the READ even when the write threw, because a timeout may still have landed", async () => {
    const { DentallyError } = await import("@/lib/dentally/client");
    h.updateAppointment.mockImplementation(async (id: string, payload: Record<string, unknown>) => {
      const rows = h.book.get(DAY) ?? [];
      h.book.set(
        DAY,
        rows.map((r) =>
          r.id === id
            ? {
                ...r,
                start_time: payload.start_time,
                finish_time: payload.finish_time,
                practitioner_id: payload.practitioner_id,
              }
            : r,
        ),
      );
      throw new DentallyError(0, "request timed out after 15000ms");
    });
    const { json } = await call();
    expect(json.confirmed).toBe(true);
  });

  it("invalidates the appointment cache ONLY after a confirmed write", async () => {
    await call();
    expect(h.invalidate).toHaveBeenCalledWith(["site-cc"]);

    h.invalidate.mockClear();
    h.book = new Map([[DAY, [row()]]]);
    h.applyWrite = false;
    await call();
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The patient's text.
// ---------------------------------------------------------------------------

describe("the patient's text", () => {
  it("is not queued when no practice phone number is configured, and never with a placeholder", async () => {
    h.publicPhone = null;
    const { json } = await call();
    expect(json.confirmed).toBe(true);
    expect(json.notify).toEqual({ queued: false, reason: "no_phone" });
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("is queued through the shared drain's own tables when the time changed", async () => {
    h.publicPhone = "020 8888 1234";
    const { json } = await call();
    expect(json.notify).toEqual({ queued: true, reason: null });
    expect(h.insertTouch).toHaveBeenCalledTimes(1);
    expect(h.enqueueOutbox).toHaveBeenCalledTimes(1);
    const enqueued = h.enqueueOutbox.mock.calls[0][0] as Record<string, unknown>;
    expect(enqueued.toRef).toBe("patient:pat-9");
    expect(enqueued.siteId).toBe("site-cc");
    expect(typeof enqueued.notBeforeAt).toBe("string");
  });

  it("carries the exact patient copy: no NHS, no private, no vendor, no exclamation mark", async () => {
    h.publicPhone = "020 8888 1234";
    await call();
    const sent = String((h.insertTouch.mock.calls[0][0] as Record<string, unknown>).body);
    expect(sent).toContain("Hello Nadia");
    expect(sent).toContain("has been moved to");
    expect(sent).toContain("020 8888 1234");
    expect(sent).not.toMatch(/\bNHS\b/);
    expect(sent).not.toMatch(/\bprivate\b/i);
    expect(sent).not.toContain("!");
    expect(sent).not.toContain("—");
    expect(sent.length).toBeLessThanOrEqual(300);
  });

  it("sends NOTHING on a clinician-only reassignment at the same time", async () => {
    h.publicPhone = "020 8888 1234";
    const { json } = await call(
      body({ startTime: AT(9, 30), finishTime: AT(10, 0), practitionerId: "prac-2" }),
    );
    expect(json.confirmed).toBe(true);
    expect(json.notify).toEqual({ queued: false, reason: "time_unchanged" });
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("sends nothing when the reader did not ask for it", async () => {
    h.publicPhone = "020 8888 1234";
    const { json } = await call(body({ notifyPatient: false }));
    expect(json.notify).toEqual({ queued: false, reason: "not_requested" });
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("NEVER texts on a move that did not save", async () => {
    h.publicPhone = "020 8888 1234";
    h.applyWrite = false;
    const { json } = await call();
    expect(json.confirmed).toBe(false);
    expect(h.insertTouch).not.toHaveBeenCalled();
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("still reports a saved move when the text could not be queued", async () => {
    h.publicPhone = "020 8888 1234";
    h.enqueueOutbox.mockRejectedValueOnce(new Error("diary_outbox is missing"));
    const { json } = await call();
    expect(json.ok).toBe(true);
    expect(json.confirmed).toBe(true);
    expect(json.notify).toEqual({ queued: false, reason: "queue_failed" });
  });
});

// ---------------------------------------------------------------------------
// The audit.
// ---------------------------------------------------------------------------

describe("the audit", () => {
  it("records a saved move with the actor, the from and the to", async () => {
    await call();
    const rowWritten = h.insertMove.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(rowWritten.outcome).toBe("saved");
    expect(rowWritten.actorEmail).toBe("manager@example.com");
    expect(rowWritten.actorRole).toBe("client_coordinator");
    expect(rowWritten.fromStartAt).toBe(AT(9, 30));
    expect(rowWritten.fromPractitionerId).toBe("prac-1");
    expect(rowWritten.toStartAt).toBe(AT(14, 30));
    expect(rowWritten.toPractitionerId).toBe("prac-2");
  });

  it("records a REFUSED attempt too, so a rejected move is never invisible", async () => {
    h.entries = { entries: [], failed: true };
    await call();
    const rowWritten = h.insertMove.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(rowWritten.outcome).toBe("refused");
    expect(String(rowWritten.detail)).toContain("breaks and notes");
  });

  it("links an undo to the move it reverses", async () => {
    await call(body({ undoOf: "move-0" }));
    const rowWritten = h.insertMove.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(rowWritten.undoOf).toBe("move-0");
  });

  it("does not turn a saved move into a reported failure when the audit cannot be written", async () => {
    // Migration 0063 is checked in but NOT applied, so locally this genuinely
    // fails. Telling the practice manager a patient was not moved when they were
    // is the more dangerous of the two lies.
    h.insertMove.mockImplementation(async () => null);
    const { res, json } = await call();
    expect(res.status).toBe(200);
    expect(json.confirmed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Undo takes the identical path.
// ---------------------------------------------------------------------------

describe("undo", () => {
  it("is re-validated and read back exactly like any other move", async () => {
    await call();
    h.updateAppointment.mockClear();

    const { res, json } = await call(
      body({
        startTime: AT(9, 30),
        finishTime: AT(10, 0),
        practitionerId: "prac-1",
        expected: { startTime: AT(14, 30), finishTime: AT(15, 0), practitionerId: "prac-2" },
        undoOf: "move-1",
        notifyPatient: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(json.confirmed).toBe(true);
    expect(h.updateAppointment).toHaveBeenCalledTimes(1);
  });

  it("is refused by the write gate, like any other move", async () => {
    h.writeEnabled = false;
    const { res } = await call(body({ undoOf: "move-1" }));
    expect(res.status).toBe(503);
  });
});

describe("the request body", () => {
  it("400s on unreadable JSON rather than throwing", async () => {
    const res = await PATCH(
      new Request(`http://localhost/api/calendar/appointment/${APPT_ID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      { params: Promise.resolve({ id: APPT_ID }) },
    );
    expect(res.status).toBe(400);
  });

  it("400s on a missing expected block, so a blind overwrite is impossible", async () => {
    const b = body() as Record<string, unknown>;
    delete b.expected;
    const { res } = await call(b);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The three write-safety guards added after review.
// ---------------------------------------------------------------------------

describe("a cancelled or did-not-attend booking cannot be moved", () => {
  it("refuses a cancelled appointment, writes nothing and texts nobody", async () => {
    h.publicPhone = "020 0000 0000";
    h.book = new Map([[DAY, [row({ state: "cancelled" })]]]);
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("cancelled");
    expect(h.updateAppointment).not.toHaveBeenCalled();
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("refuses a did-not-attend appointment on the same reasoning", async () => {
    h.book = new Map([[DAY, [row({ state: "did_not_attend" })]]]);
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("did not attend");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("still records the refusal, so a rejected move is never invisible", async () => {
    h.book = new Map([[DAY, [row({ state: "cancelled" })]]]);
    await call();
    expect(h.insertMove).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "refused", appointmentId: APPT_ID }),
    );
  });
});

describe("the start time is the SERVER's instant, never the request's string", () => {
  it("rejects a start time with no zone at all, rather than resolving it locally", async () => {
    // Date.parse accepts this and resolves it in the SERVER's zone (UTC on
    // Vercel, London in the practice), so the instant validated here and the
    // instant Dentally stores would not be the same moment.
    const { res, json } = await call(body({ startTime: "2026-07-31T14:30", finishTime: AT(15, 0) }));
    expect(res.status).toBe(400);
    expect(String(json.error)).toContain("startTime");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("rejects a zone-less expected time too", async () => {
    const { res } = await call(
      body({ expected: { startTime: "2026-07-31 09:30:00", finishTime: AT(10, 0), practitionerId: "prac-1" } }),
    );
    expect(res.status).toBe(400);
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("sends a normalised UTC instant, so start and finish can never be in different forms", async () => {
    // The London wall clock 14:30 on a BST day: the same moment as AT(14, 30),
    // written the way live Dentally writes one.
    const { res } = await call(body({ startTime: "2026-07-31T14:30:00+01:00" }));
    expect(res.status).toBe(200);
    const payload = h.updateAppointment.mock.calls[0][1];
    expect(payload.start_time).toBe(AT(14, 30));
    expect(payload.finish_time).toBe(AT(15, 0));
    expect(String(payload.start_time)).toMatch(/Z$/);
    expect(String(payload.finish_time)).toMatch(/Z$/);
  });

  it("audits, and would text, the instant that was WRITTEN", async () => {
    h.publicPhone = "020 0000 0000";
    const { res } = await call(body({ startTime: "2026-07-31T14:30:00+01:00" }));
    expect(res.status).toBe(200);
    expect(h.insertMove).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "saved", toStartAt: AT(14, 30) }),
    );
  });
});

describe("the cross-site presence guard", () => {
  // Availability carries no site and takes no site parameter, so a clinician on
  // two of this client's practitioner lists is answered for whichever practice
  // they are actually at. Femi is on both lists below.
  beforeEach(() => {
    h.twoSites = true;
    h.otherSitePractitioners = { practitioners: [{ id: "prac-2", name: "Femi Osei" }], failed: false };
  });

  it("refuses a move onto a multi-site clinician with nothing booked here that day", async () => {
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("more than one practice");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("allows it once a booking at THIS site puts them in the building", async () => {
    h.book = new Map([
      [DAY, [row(), row({ id: "appt-2", practitioner_id: "prac-2", start_time: AT(11, 0), finish_time: AT(11, 30) })]],
    ]);
    const { res, json } = await call();
    expect(res.status).toBe(200);
    expect(json.confirmed).toBe(true);
  });

  it("does NOT take a cancelled booking as evidence that anybody was in", async () => {
    h.book = new Map([
      [
        DAY,
        [
          row(),
          row({
            id: "appt-2",
            practitioner_id: "prac-2",
            start_time: AT(11, 0),
            finish_time: AT(11, 30),
            state: "cancelled",
          }),
        ],
      ],
    ]);
    const { res } = await call();
    expect(res.status).toBe(409);
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("demands the same corroboration from everybody when the other list could not be read", async () => {
    // We cannot tell WHO is multi-site, so nobody is assumed to be single-site.
    h.otherSitePractitioners = { practitioners: [], failed: true };
    const { res, json } = await call();
    expect(res.status).toBe(409);
    expect(String(json.error)).toContain("more than one practice");
    expect(h.updateAppointment).not.toHaveBeenCalled();
  });

  it("leaves a single-site clinician entirely alone", async () => {
    h.otherSitePractitioners = { practitioners: [{ id: "prac-77", name: "Someone Else" }], failed: false };
    const { res, json } = await call();
    expect(res.status).toBe(200);
    expect(json.confirmed).toBe(true);
  });
});
