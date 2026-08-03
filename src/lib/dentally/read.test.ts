// GO-LIVE regression (finding #7): read.ts must PAGE every Dentally list endpoint, not
// stop at the first 100 rows. A real-size practice has well over 100 patients /
// appointments; a single unpaged call silently truncates and the reviews module 404s
// and the co-pilot diary omits most of the day. The DentallyClient is mocked with a
// pager so no network is touched.
import { describe, it, expect, vi, beforeEach } from "vitest";

const PER_PAGE = 100;

// A pager: returns PER_PAGE rows per page until `total` is exhausted, then a short page.
function makePager(total: number, key: "patients" | "appointments" | "treatment_plans") {
  const pagesSeen: number[] = [];
  const fn = (a: { page?: number }) => {
    const page = a.page ?? 1;
    pagesSeen.push(page);
    const start = (page - 1) * PER_PAGE;
    const end = Math.min(start + PER_PAGE, total);
    const rows = [];
    for (let i = start; i < end; i += 1) {
      rows.push({ id: `${key}-${i}`, patient_id: `pat-${i}`, site_id: "site-1", start_time: "2026-07-10T09:00:00Z", first_name: "A", last_name: `B${i}` });
    }
    return Promise.resolve({ [key]: rows });
  };
  return { fn, pagesSeen };
}

/** The stubbed client surface. Declared as a type so the defaults below can be
 *  zero-argument arrows (nothing to name, nothing left unused) while tests are
 *  still free to reassign them with implementations that DO read the argument. */
interface ClientStubs {
  listPatients: (arg: unknown) => Promise<unknown>;
  listAppointments: (arg: unknown) => Promise<unknown>;
  listTreatmentPlans: (arg: unknown) => Promise<unknown>;
  listInvoices: (arg: unknown) => Promise<unknown>;
  countPatients: (siteId: unknown) => Promise<number | null>;
}

const state = vi.hoisted<ClientStubs>(() => ({
  listPatients: () => Promise.resolve({ patients: [] }),
  listAppointments: () => Promise.resolve({ appointments: [] }),
  listTreatmentPlans: () => Promise.resolve({ treatment_plans: [] }),
  listInvoices: () => Promise.resolve({ invoices: [] }),
  countPatients: () => Promise.resolve(null),
}));

vi.mock("./client", () => ({
  DentallyClient: class {
    constructor() {}
    listPatients(a: unknown) { return state.listPatients(a); }
    listAppointments(a: unknown) { return state.listAppointments(a); }
    listTreatmentPlans(a: unknown) { return state.listTreatmentPlans(a); }
    listInvoices(a: unknown) { return state.listInvoices(a); }
    countPatients(s: unknown) { return state.countPatients(s); }
  },
}));

import { listPatients, listAppointments, listAppointmentsSafe, listOutstanding, countPatients, dentallyReadKey } from "./read";

beforeEach(() => {
  vi.stubEnv("DENTALLY_API_KEY", "k");
});

describe("read.ts pagination (finding #7)", () => {
  it("pages listPatients past the first 100 rows (250 across 3 pages)", async () => {
    const pager = makePager(250, "patients");
    state.listPatients = pager.fn as never;
    const out = await listPatients(["site-1"]);
    expect(out).toHaveLength(250); // NOT truncated at 100
    expect(pager.pagesSeen).toEqual([1, 2, 3]); // looped until a short page
  });

  it("pages listAppointments past the first 100 rows (180 across 2 pages)", async () => {
    const pager = makePager(180, "appointments");
    state.listAppointments = pager.fn as never;
    const out = await listAppointments(["site-1"]);
    expect(out).toHaveLength(180);
    expect(pager.pagesSeen).toEqual([1, 2]);
  });

  it("stops after one page when the first page is already short (mock-size practice)", async () => {
    const pager = makePager(20, "patients");
    state.listPatients = pager.fn as never;
    const out = await listPatients(["site-1"]);
    expect(out).toHaveLength(20);
    expect(pager.pagesSeen).toEqual([1]); // no needless second page
  });
});

describe("dentallyReadKey (read-only key selection)", () => {
  it("prefers the dedicated read-only key when set", () => {
    vi.stubEnv("DENTALLY_API_KEY", "write-key");
    vi.stubEnv("DENTALLY_PROD_READONLY_API_KEY", "readonly-key");
    expect(dentallyReadKey()).toBe("readonly-key");
  });

  it("falls back to DENTALLY_API_KEY when the read-only key is unset", () => {
    vi.stubEnv("DENTALLY_API_KEY", "write-key");
    vi.stubEnv("DENTALLY_PROD_READONLY_API_KEY", "");
    expect(dentallyReadKey()).toBe("write-key");
  });

  it("returns empty string when neither is set (callers 503)", () => {
    vi.stubEnv("DENTALLY_API_KEY", "");
    vi.stubEnv("DENTALLY_PROD_READONLY_API_KEY", "");
    expect(dentallyReadKey()).toBe("");
  });
});

// listOutstanding scans the INVOICES index ONCE (real Dentally holds the balance on
// invoices, not plans, and may ignore site_id and repeat the whole group per site),
// reads the balance from `amount_outstanding`, aggregates per patient, attributes by the
// patient's site, and drops other-practice patients. Uses the REAL Dentally invoice shape
// (amount / amount_outstanding / boolean paid / status) so it guards the live path — the
// earlier mock shape (numeric total/paid) hid a bug that returned 0 for every real invoice.
describe("listOutstanding", () => {
  // amountOutstanding is Dentally's `amount_outstanding`; `paid` is a BOOLEAN live.
  const inv = (id: string, patientId: string, amount: number, amountOutstanding: number, extra: Record<string, unknown> = {}) => ({
    id, patient_id: patientId, amount, amount_outstanding: amountOutstanding, paid: amountOutstanding === 0, status: "new", ...extra,
  });
  const patient = (id: string, site: string) => ({ id, first_name: "P", last_name: id, site_id: site });

  it("collects outstanding invoices from ALL sites even when a middle site is empty", async () => {
    const bySite: Record<string, unknown[]> = {
      "site-1": [inv("a", "pat-1", 500, 400)], // 400 owed
      "site-2": [], // legitimately empty — must NOT abort the scan
      "site-3": [inv("c", "pat-3", 300, 300)], // 300 owed
    };
    state.listInvoices = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({ invoices: (a.page ?? 1) === 1 ? bySite[a.siteId ?? ""] ?? [] : [] })) as never;
    const patBySite: Record<string, unknown[]> = {
      "site-1": [patient("pat-1", "site-1")],
      "site-2": [],
      "site-3": [patient("pat-3", "site-3")],
    };
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({ patients: (a.page ?? 1) === 1 ? patBySite[a.siteId ?? ""] ?? [] : [] })) as never;

    const out = await listOutstanding(["site-1", "site-2", "site-3"]);
    expect(out.map((o) => o.patientId).sort()).toEqual(["pat-1", "pat-3"]); // site-3 NOT skipped
    expect(out.find((o) => o.patientId === "pat-1")?.outstanding).toBe(400);
  });

  it("aggregates several unpaid invoices per patient and ranks by amount owed", async () => {
    const group = [
      inv("x1", "pat-a", 1000, 1000), // 1000
      inv("x2", "pat-a", 500, 300), // 300 -> pat-a owes 1300
      inv("y1", "pat-b", 800, 800), // 800
    ];
    state.listInvoices = ((a: { page?: number }) =>
      Promise.resolve({ invoices: (a.page ?? 1) === 1 ? group : [] })) as never;
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({
        patients:
          a.siteId === "site-1" && (a.page ?? 1) === 1
            ? [patient("pat-a", "site-1"), patient("pat-b", "site-1")]
            : [],
      })) as never;

    const out = await listOutstanding(["site-1"]);
    expect(out.map((o) => [o.patientId, o.outstanding])).toEqual([["pat-a", 1300], ["pat-b", 800]]);
    expect(out[0].planName).toBe("2 outstanding invoices");
  });

  it("handles the live shape: boolean `paid` with no explicit balance falls back to gross", async () => {
    // Guards the review-caught bug: real Dentally `paid` is a BOOLEAN, not a number. An
    // unpaid invoice with no amount_outstanding must owe its gross, a paid one must owe 0.
    state.listInvoices = ((a: { page?: number }) =>
      Promise.resolve({
        invoices:
          (a.page ?? 1) === 1
            ? [
                { id: "f1", patient_id: "pat-1", amount: 700, paid: false, status: "new" }, // owes 700
                { id: "f2", patient_id: "pat-2", amount: 400, paid: true, status: "paid" }, // owes 0
              ]
            : [],
      })) as never;
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({
        patients:
          a.siteId === "site-1" && (a.page ?? 1) === 1
            ? [patient("pat-1", "site-1"), patient("pat-2", "site-1")]
            : [],
      })) as never;

    const out = await listOutstanding(["site-1"]);
    expect(out.map((o) => [o.patientId, o.outstanding])).toEqual([["pat-1", 700]]);
  });

  it("dedups the ignored-filter repeat, drops other-practice patients, and stops early", async () => {
    // Every site returns the SAME group-wide list (real Dentally ignoring site_id).
    const group = [inv("x", "pat-vit", 300, 300), inv("y", "pat-other", 400, 400)];
    const calls: string[] = [];
    state.listInvoices = ((a: { siteId?: string; page?: number }) => {
      calls.push(`${a.siteId}:${a.page ?? 1}`);
      return Promise.resolve({ invoices: (a.page ?? 1) === 1 ? group : [] });
    }) as never;
    // /v1/patients IS filtered server-side: only the Vitality patient comes back.
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({ patients: a.siteId === "site-1" && (a.page ?? 1) === 1 ? [patient("pat-vit", "site-1")] : [] })) as never;

    const out = await listOutstanding(["site-1", "site-2", "site-3"]);
    expect(out.map((o) => o.patientId)).toEqual(["pat-vit"]); // pat-other dropped (not in allowlist)
    expect(calls.some((c) => c.startsWith("site-3"))).toBe(false); // early-stopped after site-2
  });

  it("ignores settled, draft, cancelled and written-off invoices and skips the patient scan when nothing is owed", async () => {
    state.listInvoices = ((a: { page?: number }) =>
      Promise.resolve({
        invoices:
          (a.page ?? 1) === 1
            ? [
                inv("s", "pat-1", 500, 0), // settled (amount_outstanding 0, paid true)
                inv("d", "pat-2", 900, 900, { status: "draft" }),
                inv("c", "pat-3", 900, 900, { status: "cancelled" }),
                inv("w", "pat-4", 900, 900, { status: "written_off" }),
              ]
            : [],
      })) as never;
    const spy = vi.fn(() => Promise.resolve({ patients: [] }));
    state.listPatients = spy as never;

    const out = await listOutstanding(["site-1", "site-2", "site-3"]);
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled(); // patient scan skipped on the no-outstanding path
  });
});

// listAppointmentsSafe (calendar go-live defect B3): the calendar must be able to
// tell a genuine Dentally read failure apart from a day that is genuinely free,
// and a failed read must never poison the cache with an empty result.
describe("listAppointmentsSafe (B3: distinct failure signal, never cached)", () => {
  it("reports success with the real rows when every site loads fine", async () => {
    state.listAppointments = (async () => ({
      appointments: [{ id: "a1", patient_id: "p1", site_id: "site-1", start_time: "2026-07-10T09:00:00Z", first_name: "A", last_name: "B" }],
    })) as never;
    const out = await listAppointmentsSafe(["site-1"]);
    expect(out.failed).toBe(false);
    expect(out.appointments).toHaveLength(1);
  });

  it("reports failed=true (and an empty list) when the only site throws", async () => {
    state.listAppointments = (async () => {
      throw new Error("dentally 500");
    }) as never;
    const out = await listAppointmentsSafe(["site-1"]);
    expect(out.failed).toBe(true);
    expect(out.appointments).toEqual([]);
  });

  it("reports failed=true when one of two sites throws and nothing at all came back", async () => {
    state.listAppointments = ((a: { siteId?: string }) => {
      if (a.siteId === "site-bad") throw new Error("dentally 500");
      return Promise.resolve({ appointments: [] }); // site-2 genuinely has none today
    }) as never;
    const out = await listAppointmentsSafe(["site-bad", "site-2"]);
    expect(out.failed).toBe(true);
    expect(out.appointments).toEqual([]);
  });

  it("does NOT report failed when a failing site is offset by real data from another site", async () => {
    state.listAppointments = ((a: { siteId?: string }) => {
      if (a.siteId === "site-bad") throw new Error("dentally 500");
      return Promise.resolve({
        appointments: [{ id: "a1", patient_id: "p1", site_id: "site-ok", start_time: "2026-07-10T09:00:00Z", first_name: "A", last_name: "B" }],
      });
    }) as never;
    const out = await listAppointmentsSafe(["site-bad", "site-ok"]);
    expect(out.failed).toBe(false);
    expect(out.appointments).toHaveLength(1);
  });

  // The diary loads every scoped site in ONE call and slices it down to one
  // practice client-side, so the whole-request verdict above is not enough: with
  // one practice failing and another returning rows, `failed` is false and the
  // site switcher would draw a confident empty day for the failed practice.
  it("names the sites that actually threw, even when another site returned rows", async () => {
    state.listAppointments = ((a: { siteId?: string }) => {
      if (a.siteId === "site-part-bad") throw new Error("dentally 500");
      return Promise.resolve({
        appointments: [{ id: "a1", patient_id: "p1", site_id: "site-part-ok", start_time: "2026-07-10T09:00:00Z", first_name: "A", last_name: "B" }],
      });
    }) as never;
    const out = await listAppointmentsSafe(["site-part-bad", "site-part-ok"]);
    expect(out.failed).toBe(false);
    expect(out.failedSiteIds).toEqual(["site-part-bad"]);
  });

  it("reports no failed sites at all on a clean read", async () => {
    state.listAppointments = (async () => ({ appointments: [] })) as never;
    const out = await listAppointmentsSafe(["site-clean"]);
    expect(out.failedSiteIds).toEqual([]);
  });
});

// Practitioner ids arrive as NUMBERS from real Dentally and as strings only from
// the local mock (see lib/booking/slots.ts and write.ts, which both branch on
// it). The diary joins appointments to columns on this id, and the practitioner
// LIST id is built with String(), so a number dropped to null here sent every
// live appointment into "Unassigned" and left every clinician column reading
// "Nothing booked" on a fully booked day.
describe("toAppointment practitioner id (live sends a number, the mock a string)", () => {
  it("keeps a NUMERIC practitioner id, as its decimal string", async () => {
    state.listAppointments = (async () => ({
      appointments: [
        { id: "a1", patient_id: "p1", site_id: "site-pid-1", start_time: "2026-08-03T09:00:00+01:00", practitioner_id: 77 },
      ],
    })) as never;
    const out = await listAppointmentsSafe(["site-pid-1"]);
    expect(out.appointments[0].practitionerId).toBe("77");
  });

  it("keeps a STRING practitioner id unchanged (the mock's shape)", async () => {
    state.listAppointments = (async () => ({
      appointments: [
        { id: "a1", patient_id: "p1", site_id: "site-pid-2", start_time: "2026-08-03T09:00:00+01:00", practitioner_id: "prac-1" },
      ],
    })) as never;
    const out = await listAppointmentsSafe(["site-pid-2"]);
    expect(out.appointments[0].practitionerId).toBe("prac-1");
  });

  it("stays null when there is genuinely no practitioner, so the Unassigned column is honest", async () => {
    state.listAppointments = (async () => ({
      appointments: [
        { id: "a1", patient_id: "p1", site_id: "site-pid-3", start_time: "2026-08-03T09:00:00+01:00" },
        { id: "a2", patient_id: "p2", site_id: "site-pid-3", start_time: "2026-08-03T10:00:00+01:00", practitioner_id: null },
        { id: "a3", patient_id: "p3", site_id: "site-pid-3", start_time: "2026-08-03T11:00:00+01:00", practitioner_id: "" },
      ],
    })) as never;
    const out = await listAppointmentsSafe(["site-pid-3"]);
    expect(out.appointments.map((a) => a.practitionerId)).toEqual([null, null, null]);
  });
});

describe("countPatients (exact site totals from meta.total)", () => {
  it("sums the per-site totals from the index metadata", async () => {
    state.countPatients = async (siteId: unknown) =>
      siteId === "count-a" ? 27_531 : siteId === "count-b" ? 6_400 : null;
    // Distinct site ids per test: the 5-minute cache keys on the site list.
    expect(await countPatients(["count-a", "count-b"])).toBe(33_931);
  });

  it("returns null when NO site exposes a total (the local mock), so callers fall back", async () => {
    state.countPatients = async () => null;
    expect(await countPatients(["count-c"])).toBeNull();
  });

  it("a single failing site contributes 0 but the rest still count", async () => {
    state.countPatients = async (siteId: unknown) => {
      if (siteId === "count-err") throw new Error("dentally 500");
      return 1_200;
    };
    expect(await countPatients(["count-d", "count-err"])).toBe(1_200);
  });
});

// ===========================================================================
// THE DNA MARKER MUST BE ABLE TO EXIST.
//
// Dentally draws a small figure on a did-not-attend and the diary reproduces it
// (hatched fill, "DNA" corner letter); a cancellation is drawn as the one
// spineless, dashed, white block on the grid. Neither mark can EVER appear if
// the rows never reach the feed, and both Dentally and the mock exclude
// Cancelled / Did-not-attend from an appointment list unless `cancelled=true` is
// asked for.
//
// client.listAppointments already sends it (pinned by client.test.ts) and the
// per-patient record already opts in (read.ts, getPatientDetail). What was NOT
// pinned anywhere is the seam BETWEEN them: that read.ts, which shapes every row
// the diary draws, hands those two states through untouched rather than
// normalising, defaulting or filtering them away.
//
// The three properties below are one chain, and every one of them has to hold or
// the practice manager is lied to:
//   1. a cancelled and a did-not-attend row REACH the feed,
//   2. neither is counted as BOOKED (a cancellation is not attendance),
//   3. a cancelled slot is FREE capacity (its time is recoverable).
// ===========================================================================

import { dayCounts } from "@/components/client/calendar/diary-view";
import { columnCapacity } from "@/lib/calendar/capacity";

/** The rule every diary consumer applies: cancelled and DNA consume no time. */
function occupies(state: string): boolean {
  return state !== "cancelled" && state !== "did_not_attend";
}

describe("cancelled and did-not-attend reach the diary feed", () => {
  // Real Dentally's own Title Case wire values, not our canonical ones, so this
  // exercises the normalisation seam as well as the pass-through.
  const wireRows = [
    { id: "a1", patient_id: "p1", site_id: "site-dna", start_time: "2026-07-28T09:00:00+01:00", duration: 30, state: "Completed", practitioner_id: 7 },
    { id: "a2", patient_id: "p2", site_id: "site-dna", start_time: "2026-07-28T10:00:00+01:00", duration: 60, state: "Cancelled", practitioner_id: 7 },
    { id: "a3", patient_id: "p3", site_id: "site-dna", start_time: "2026-07-28T11:00:00+01:00", duration: 30, state: "Did not attend", practitioner_id: 7 },
  ];

  it("hands both states through, canonicalised, rather than dropping them", async () => {
    state.listAppointments = (async () => ({ appointments: wireRows })) as never;
    const out = await listAppointmentsSafe(["site-dna"]);
    expect(out.appointments.map((a) => a.state)).toEqual([
      "completed",
      "cancelled",
      "did_not_attend",
    ]);
    // The whole point: without these two rows the hatch and the dashed block are
    // unreachable code, however correctly they are drawn.
    expect(out.appointments.filter((a) => !occupies(a.state))).toHaveLength(2);
  });

  it("does NOT let a cancellation or a no-show inflate the booked count", async () => {
    state.listAppointments = (async () => ({ appointments: wireRows })) as never;
    const out = await listAppointmentsSafe(["site-dna"]);
    const counts = dayCounts(out.appointments);
    expect(counts.booked).toBe(1); // the completed one, and only that one
    expect(counts.cancelled).toBe(1);
    expect(counts.noShow).toBe(1);
  });

  it("counts a cancelled slot as FREE time, never as booked time", async () => {
    state.listAppointments = (async () => ({ appointments: wireRows })) as never;
    const out = await listAppointmentsSafe(["site-dna"]);

    // 09:00-12:00 London, one clinician. Spans in minutes past London midnight.
    const bounds = { startMin: 9 * 60, endMin: 12 * 60 };
    const spanOf = (a: { start: string; durationMin: number }) => {
      const startMin = Number(a.start.slice(11, 13)) * 60 + Number(a.start.slice(14, 16));
      return { startMin, endMin: startMin + a.durationMin };
    };
    const occupied = out.appointments.filter((a) => occupies(a.state)).map(spanOf);

    const cap = columnCapacity({
      working: [bounds],
      occupied,
      breaks: [],
      bounds,
    });

    // 180 minutes of clinical time, of which ONLY the 30 minute completed
    // appointment is consumed. The cancelled hour and the missed half hour are
    // both recoverable, so 150 minutes are free and the longest single run is
    // the 09:30-12:00 stretch that starts the moment the completed one ends.
    expect(cap.workingMin).toBe(180);
    expect(cap.bookedMin).toBe(30);
    expect(cap.freeMin).toBe(150);
    expect(cap.longestFreeMin).toBe(150);
    expect(cap.longestStartMin).toBe(9 * 60 + 30);
  });
});
