import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// THE MINING SCAN'S HONESTY, DRIVEN THROUGH THE REAL ENGINE.
//
// Two defects from the wave-3 review live here, and they pull in OPPOSITE
// directions, which is why both need pinning at once:
//
//   1. THE SCAN CLAIMED DAYS IT HAD NEVER READ. The old run advanced its coverage
//      row whenever the PATIENT reads had all resolved, and never asked whether
//      the appointment pages had actually exhausted the window. A read that threw
//      or a window past its page budget both left coverage claiming a month the
//      scan had mostly not opened — and the screen printed that range as "Built
//      from appointments between D1 and D2".
//
//   2. THE SCAN COULD NEVER RECORD ANYTHING AT ALL. One unreadable patient, or
//      more matches in the window than the run's patient budget, and the single
//      call to recordScanRun never happened — while candidates had already been
//      written. The screen then said "This list has not been built yet. Nothing
//      has been read" above a table of named patients, for ever, because with no
//      coverage row the next window is always the same 30 days.
//
// THE INVARIANT THAT ANSWERS BOTH: a candidate is written only for a day that was
// fully read AND fully resolved, and that day's coverage is committed in the same
// breath. So a name on the screen always has a window printed beside it, and the
// window never names a day the scan did not finish.
//
// Only the boundaries are faked — Dentally and the two tables. The real day
// arithmetic, the real matcher, the real coverage rules and the real bounds run.
// ===========================================================================

const NOW = new Date("2026-09-04T12:00:00.000Z");
const DAY_MS = 86_400_000;

/** A YYYY-MM-DD key `offset` days from NOW. */
function key(offset: number): string {
  return new Date(NOW.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

// A THREE-DAY WINDOW, on purpose. nextWindow walks back MINING_DAYS_PER_RUN days
// but never past the three-year horizon, so seeding coverage three days inside the
// horizon gives a window of exactly three days: the assertions can then name every
// day by hand instead of arithmetic nobody can check by eye.
const HORIZON = key(-1095);
const OLDEST = HORIZON;        // window.from
const MIDDLE = key(-1094);
const NEWEST = key(-1093);     // window.to
const COVERED_FROM = key(-1092); // where the last run stopped

const h = vi.hoisted(() => {
  const state = {
    budgetRefused: false,
    /** Appointment rows per day key; a function may be used to throw or to page. */
    days: {} as Record<string, unknown[] | ((page: number) => unknown[])>,
    /** Patient payloads by id; a number stands for an HTTP status to throw. */
    patients: {} as Record<string, unknown>,
    coverage: null as unknown,
    /** Every repository call, in order, so ordering can be asserted. */
    events: [] as string[],
    scans: [] as Array<Record<string, unknown>>,
    candidates: [] as Array<Record<string, unknown>>,
    appointmentCalls: [] as Array<Record<string, unknown>>,
    patientCalls: [] as string[],
  };
  class FakeDentallyError extends Error {
    status: number;
    constructor(status: number) {
      super(`dentally ${status}`);
      this.name = "DentallyError";
      this.status = status;
    }
  }
  return { state, FakeDentallyError };
});

vi.mock("@/lib/dentally/budget", () => ({
  dentallyScopeRefused: () => h.state.budgetRefused,
}));
vi.mock("@/lib/dentally/client", () => ({
  DentallyError: h.FakeDentallyError,
  DentallyClient: class {
    async listAppointments(a: { fromDate: string; toDate: string; page: number }) {
      h.state.appointmentCalls.push({ fromDate: a.fromDate, toDate: a.toDate, page: a.page });
      const day = h.state.days[a.fromDate] ?? [];
      const rows = typeof day === "function" ? day(a.page) : a.page === 1 ? day : [];
      return { appointments: rows };
    }
    async getPatient(id: string) {
      h.state.patientCalls.push(id);
      const p = h.state.patients[id];
      if (typeof p === "number") throw new h.FakeDentallyError(p);
      return { patient: p };
    }
  },
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental", dentallyId: "d-cc" }],
  dentallySiteId: () => "d-cc",
}));
vi.mock("@/lib/triage/mining-repository", () => ({
  getCoverage: vi.fn(async () => h.state.coverage),
  recordScanRun: vi.fn(async (input: Record<string, unknown>) => {
    h.state.events.push(`scan:${String(input.coveredFrom)}`);
    h.state.scans.push(input);
  }),
  upsertCandidate: vi.fn(async (input: Record<string, unknown>) => {
    h.state.events.push(`candidate:${String(input.dentallyPatientId)}`);
    h.state.candidates.push(input);
    return true;
  }),
}));

import { runMiningSweep } from "./_mining";
import { MINING_MAX_PAGES_PER_WINDOW, MINING_MAX_PATIENT_READS_PER_RUN } from "@/lib/triage/mining";
import { DentallyClient } from "@/lib/dentally/client";

/** One attended extraction appointment for `patientId` on `day`. */
function extraction(patientId: string, day: string): Record<string, unknown> {
  return {
    id: `a-${patientId}-${day}`,
    patient_id: patientId,
    start_time: `${day}T09:00:00.000Z`,
    state: "Completed",
    reason: "Extraction UR6",
  };
}

/** An adult patient record. */
function adult(name = "Alex Berry"): Record<string, unknown> {
  const [first, last] = name.split(" ");
  return { first_name: first, last_name: last, date_of_birth: "1980-04-02" };
}

async function run() {
  return runMiningSweep({
    clientId: "vitality",
    client: new DentallyClient({ apiKey: "k", baseUrl: "http://mock", readOnly: true }),
    now: NOW,
  });
}

/** The days this run recorded as covered, oldest claim last. */
function claims(): string[] {
  return h.state.scans.map((s) => String(s.coveredFrom));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.budgetRefused = false;
  h.state.days = {};
  h.state.patients = {};
  h.state.coverage = {
    siteId: "site-cc",
    coveredFrom: COVERED_FROM,
    coveredTo: key(0),
    examined: 0,
    candidates: 0,
    excludedNoDob: 0,
    excludedUnderAge: 0,
    lastRunAt: NOW.toISOString(),
    moreToRead: true,
  };
  h.state.events = [];
  h.state.scans = [];
  h.state.candidates = [];
  h.state.appointmentCalls = [];
  h.state.patientCalls = [];
});

describe("what the scan may claim to have read", () => {
  it("CONTROL: a window it reads end to end is claimed to its oldest day", async () => {
    h.state.days = { [NEWEST]: [extraction("p1", NEWEST)], [MIDDLE]: [], [OLDEST]: [] };
    h.state.patients = { p1: adult() };

    const report = await run();

    expect(report.sites[0].stoppedBy).toBe("complete");
    expect(report.sites[0].daysCovered).toBe(3);
    expect(claims().at(-1)).toBe(OLDEST);
    expect(h.state.candidates.map((c) => c.dentallyPatientId)).toEqual(["p1"]);
  });

  it("a day whose appointment read FAILS is never claimed, and neither is anything behind it", async () => {
    // The old shape advanced coverage over the whole window here, because the
    // patients it DID find had all resolved. The screen then named a range it had
    // not read.
    h.state.days = {
      [NEWEST]: [extraction("p1", NEWEST)],
      [MIDDLE]: () => {
        throw new Error("Dentally 502");
      },
      [OLDEST]: [extraction("p9", OLDEST)],
    };
    h.state.patients = { p1: adult(), p9: adult("Sam Reed") };

    const report = await run();

    expect(report.sites[0].stoppedBy).toBe("appointment-read-failed");
    expect(claims(), "the scan claimed a day it could not read").toEqual([NEWEST]);
    expect(claims()).not.toContain(MIDDLE);
    expect(claims()).not.toContain(OLDEST);
    // ...and it never even looked behind the day it could not read, so nothing
    // from there is on the list either.
    expect(h.state.candidates.map((c) => c.dentallyPatientId)).toEqual(["p1"]);
  });

  it("a day too big for its page budget is not claimed either", async () => {
    // 1,200 appointments in one day at one site. The old shape read twelve pages
    // of a THIRTY-DAY window, stopped, and advanced coverage over the whole month
    // regardless — which any site averaging more than forty appointments a day hit
    // every single night.
    const full = (day: string) =>
      Array.from({ length: 100 }, (_, i) => extraction(`x${day}-${i}`, day));
    h.state.days = {
      [NEWEST]: [],
      [MIDDLE]: () => full(MIDDLE),
      [OLDEST]: [extraction("p9", OLDEST)],
    };
    h.state.patients = { p9: adult() };

    const report = await run();

    expect(report.sites[0].stoppedBy).toBe("day-too-large");
    expect(claims()).toEqual([NEWEST]);
    // It stopped at the page budget rather than paging for ever.
    const pagesForMiddle = h.state.appointmentCalls.filter((c) => c.fromDate === MIDDLE).length;
    expect(pagesForMiddle).toBe(MINING_MAX_PAGES_PER_WINDOW);
    // And nobody from the unreadable day is on the list, however many matched.
    expect(h.state.candidates).toEqual([]);
  });

  it("reads each day EXACTLY, never as a padded range", async () => {
    // fromDate === toDate makes the client send `on=`. The range form pads both
    // edges by a day, so a claimed window would contain appointments from outside
    // it — a coverage sentence that is quietly false at both ends.
    h.state.days = { [NEWEST]: [], [MIDDLE]: [], [OLDEST]: [] };
    await run();
    expect(h.state.appointmentCalls.length).toBe(3);
    for (const call of h.state.appointmentCalls) expect(call.fromDate).toBe(call.toDate);
    expect(h.state.appointmentCalls.map((c) => c.fromDate)).toEqual([NEWEST, MIDDLE, OLDEST]);
  });

  it("stops at the horizon rather than reading for ever", async () => {
    h.state.coverage = { ...(h.state.coverage as Record<string, unknown>), coveredFrom: HORIZON };
    const report = await run();
    expect(report.sites[0].stoppedBy).toBe("horizon");
    expect(h.state.appointmentCalls).toEqual([]);
    expect(h.state.scans).toEqual([]);
  });
});

describe("a name on the screen always has a window printed beside it", () => {
  it("every candidate written is followed by the coverage that explains it", async () => {
    // THE INVARIANT. coverageSentence(null) says "Nothing has been read, so this
    // is not a finding that no patient has had an extraction" — a sentence that
    // must never appear above a populated list.
    h.state.days = {
      [NEWEST]: [extraction("p1", NEWEST)],
      [MIDDLE]: [extraction("p2", MIDDLE)],
      [OLDEST]: () => {
        throw new Error("Dentally 502");
      },
    };
    h.state.patients = { p1: adult(), p2: adult("Sam Reed") };

    await run();

    expect(h.state.candidates.length).toBe(2);
    // Read the event log: after each candidate write there is a scan record, and
    // the run never ends on an unexplained name.
    for (let i = 0; i < h.state.events.length; i += 1) {
      if (h.state.events[i].startsWith("candidate:")) {
        const rest = h.state.events.slice(i + 1);
        expect(rest.some((e) => e.startsWith("scan:")), `${h.state.events[i]} was never covered`).toBe(true);
      }
    }
    expect(h.state.events.at(-1)?.startsWith("scan:")).toBe(true);
  });

  it("a run that finds nobody still records what it read", async () => {
    h.state.days = { [NEWEST]: [], [MIDDLE]: [], [OLDEST]: [] };
    await run();
    expect(h.state.candidates).toEqual([]);
    expect(claims()).toEqual([OLDEST]);
    expect(h.state.scans[0].examined).toBe(0);
  });
});

describe("a patient the scan cannot read", () => {
  it("is counted and moved past when the record is GONE, so the scan is not stuck for ever", async () => {
    // A merged or deleted patient fails identically every night. Blocking the
    // window on it froze the whole list at its first thirty days.
    h.state.days = { [NEWEST]: [extraction("gone", NEWEST), extraction("p1", NEWEST)], [MIDDLE]: [], [OLDEST]: [] };
    h.state.patients = { gone: 404, p1: adult() };

    const report = await run();

    expect(report.sites[0].unreadable).toBe(1);
    // NOT counted as "no date of birth": a patient we could not READ is not a
    // patient with no date of birth, and the screen says different things about
    // them.
    expect(report.sites[0].excludedNoDob).toBe(0);
    expect(h.state.scans.at(-1)?.excludedNoDob).toBe(0);
    expect(claims().at(-1), "one gone patient stopped the scan advancing").toBe(OLDEST);
    expect(h.state.candidates.map((c) => c.dentallyPatientId)).toEqual(["p1"]);
  });

  it("leaves the day for the next run when the failure could be transient", async () => {
    // A 500 or a timeout is worth another night, so the day is not claimed and
    // nobody from it is written.
    h.state.days = { [NEWEST]: [], [MIDDLE]: [extraction("flaky", MIDDLE)], [OLDEST]: [] };
    h.state.patients = { flaky: 500 };

    const report = await run();

    expect(report.sites[0].stoppedBy).toBe("patient-read-failed");
    expect(claims()).toEqual([NEWEST]);
    expect(h.state.candidates).toEqual([]);
  });

  it("counts a record with no usable name apart from a missing date of birth", async () => {
    h.state.days = { [NEWEST]: [extraction("nameless", NEWEST)], [MIDDLE]: [], [OLDEST]: [] };
    h.state.patients = { nameless: { first_name: "", last_name: "", date_of_birth: "1980-04-02" } };

    const report = await run();

    expect(report.sites[0].unreadable).toBe(1);
    expect(report.sites[0].excludedNoDob).toBe(0);
    expect(claims().at(-1)).toBe(OLDEST);
  });

  it("still counts a READ patient whose date of birth is missing as such", async () => {
    h.state.days = { [NEWEST]: [extraction("nodob", NEWEST)], [MIDDLE]: [], [OLDEST]: [] };
    h.state.patients = { nodob: { first_name: "Alex", last_name: "Berry", date_of_birth: null } };

    const report = await run();

    expect(report.sites[0].excludedNoDob).toBe(1);
    expect(report.sites[0].unreadable).toBe(0);
    expect(h.state.scans.at(-1)?.excludedNoDob).toBe(1);
  });

  it("REACHES THE COVERAGE ROW, so the screen can say so (handoff H40, 0101)", async () => {
    // The figure has been in the run report since wave 1 and stopped there: it
    // was in the response body and the logs, and on no screen, because
    // previsit_mining_scan had no column for it. It travels with the claim now,
    // exactly like the other two exclusion counters — counted per day, committed
    // with the day, so a patient on a day that was never claimed is counted when
    // that day is re-read rather than twice.
    h.state.days = {
      [NEWEST]: [extraction("gone", NEWEST), extraction("p1", NEWEST)],
      [MIDDLE]: [extraction("nameless", MIDDLE)],
      [OLDEST]: [],
    };
    h.state.patients = {
      gone: 404,
      p1: adult(),
      nameless: { first_name: "", last_name: "", date_of_birth: "1980-04-02" },
    };

    const report = await run();

    expect(report.sites[0].unreadable).toBe(2);
    const banked = h.state.scans.reduce((n, s) => n + Number(s.excludedUnreadable ?? 0), 0);
    expect(banked, "the run report knew, and the coverage row was never told").toBe(2);
  });
});

describe("the run's bounds, and what survives them", () => {
  it("keeps the days it finished when the patient budget runs out mid-window", async () => {
    // The old shape lost the whole window here AND re-read the same first 120
    // patients every night, so a busy month could never be finished at all.
    const many = (day: string, n: number) =>
      Array.from({ length: n }, (_, i) => extraction(`${day}-${i}`, day));
    h.state.days = {
      [NEWEST]: many(NEWEST, MINING_MAX_PATIENT_READS_PER_RUN - 10),
      [MIDDLE]: many(MIDDLE, 30),
      [OLDEST]: [],
    };
    for (const day of [NEWEST, MIDDLE]) {
      for (let i = 0; i < MINING_MAX_PATIENT_READS_PER_RUN; i += 1) h.state.patients[`${day}-${i}`] = adult();
    }

    const report = await run();

    expect(report.sites[0].stoppedBy).toBe("patient-budget");
    expect(h.state.patientCalls.length).toBe(MINING_MAX_PATIENT_READS_PER_RUN);
    // The finished day is kept, so the NEXT run starts behind it rather than
    // re-reading the same patients for ever.
    expect(claims()).toEqual([NEWEST]);
    expect(h.state.candidates.length).toBe(MINING_MAX_PATIENT_READS_PER_RUN - 10);
    for (const c of h.state.candidates) expect(String(c.dentallyPatientId).startsWith(NEWEST)).toBe(true);
  });

  it("reads a patient with two extractions in the window ONCE, and lists them once", async () => {
    h.state.days = {
      [NEWEST]: [extraction("p1", NEWEST)],
      [MIDDLE]: [extraction("p1", MIDDLE)],
      [OLDEST]: [],
    };
    h.state.patients = { p1: adult() };

    await run();

    expect(h.state.patientCalls).toEqual(["p1"]);
    expect(h.state.candidates.length).toBe(1);
    // The MOST RECENT extraction, because the scan walks backwards.
    expect(h.state.candidates[0].lastExtractionAt).toBe(`${NEWEST}T09:00:00.000Z`);
  });

  it("stops the moment the shared Dentally budget refuses, claiming nothing further", async () => {
    h.state.days = {
      [NEWEST]: [],
      [MIDDLE]: () => {
        h.state.budgetRefused = true;
        return [];
      },
      [OLDEST]: [extraction("p9", OLDEST)],
    };
    h.state.patients = { p9: adult() };

    const report = await run();

    expect(report.budgetRefused).toBe(true);
    expect(report.sites[0].stoppedBy).toBe("dentally-budget");
    // The middle day was genuinely read before the budget went, so it is claimed;
    // the day BEHIND it was never opened and is not.
    expect(claims()).toEqual([MIDDLE]);
    expect(h.state.appointmentCalls.map((c) => c.fromDate)).toEqual([NEWEST, MIDDLE]);
    expect(h.state.candidates).toEqual([]);
  });

  it("does not put a cancelled or did-not-attend extraction on the list", async () => {
    h.state.days = {
      [NEWEST]: [{ ...extraction("p1", NEWEST), state: "Cancelled" }],
      [MIDDLE]: [{ ...extraction("p2", MIDDLE), state: "Did not attend" }],
      [OLDEST]: [],
    };
    h.state.patients = { p1: adult(), p2: adult() };

    await run();

    expect(h.state.patientCalls).toEqual([]);
    expect(h.state.candidates).toEqual([]);
    expect(claims()).toEqual([OLDEST]);
  });
});
