import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// NO SITE STARVES ANOTHER (ruling W3/25, 5 Sep 2026).
//
// The run's 120 patient reads used to be ONE POT, spent in SITES order, and the
// site loop broke out the moment a site hit it. The flagship is first in that
// order and is the busiest: on any night its window held 120 patients-worth of
// extractions, it consumed the whole run and the other two sites were never
// opened at all — no reads, no coverage row, no entry in the report. Night after
// night, the two smaller practices would have sat at "This list has not been
// built yet. Nothing has been read" while the screen said nothing about why.
//
// The fix is an even share per mapped site, and a site that spends ITS share
// stops that site rather than the run. This file drives the real engine with
// THREE sites, which is what the practice actually has and what the single-site
// fixture in _mining.test.ts cannot express.
//
// Only the boundaries are faked. The real day arithmetic, the real matcher, the
// real bounds and the real share arithmetic run.
// ===========================================================================

const NOW = new Date("2026-09-04T12:00:00.000Z");
const DAY_MS = 86_400_000;

function key(offset: number): string {
  return new Date(NOW.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
}

// A ONE-DAY window per site, so each site's whole allowance is spent on a single
// day and the arithmetic is checkable by eye. nextWindow walks back from
// `coveredFrom` but never past the three-year horizon, so seeding coverage one
// day inside it leaves exactly the horizon day to read.
const ONLY_DAY = key(-1095); // the horizon itself
const COVERED_FROM = key(-1094);

const h = vi.hoisted(() => {
  const sites = [
    { id: "site-a", clientId: "vitality", name: "N15 Vitality Dental", dentallyId: "d-a" },
    { id: "site-b", clientId: "vitality", name: "N17", dentallyId: "d-b" },
    { id: "site-c", clientId: "vitality", name: "Romford Road", dentallyId: "d-c" },
  ];
  const state = {
    /** Extraction appointments per Dentally site id, all on the one day read. */
    rowsBySite: {} as Record<string, unknown[]>,
    patientCalls: [] as string[],
    candidates: [] as Array<Record<string, unknown>>,
    scans: [] as Array<Record<string, unknown>>,
  };
  class FakeDentallyError extends Error {
    status: number;
    constructor(status: number) {
      super(`dentally ${status}`);
      this.name = "DentallyError";
      this.status = status;
    }
  }
  return { state, sites, FakeDentallyError };
});

vi.mock("@/lib/dentally/budget", () => ({ dentallyScopeRefused: () => false }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyError: h.FakeDentallyError,
  DentallyClient: class {
    async listAppointments(a: { siteId: string; page: number }) {
      // Everything on page one; page two is empty, which is how the engine learns
      // the day is exhausted.
      return { appointments: a.page === 1 ? h.state.rowsBySite[a.siteId] ?? [] : [] };
    }
    async getPatient(id: string) {
      h.state.patientCalls.push(id);
      return { patient: { first_name: "Alex", last_name: "Berry", date_of_birth: "1980-04-02" } };
    }
  },
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: h.sites,
  dentallySiteId: (id: string) => h.sites.find((s) => s.id === id)?.dentallyId ?? id,
}));
vi.mock("@/lib/triage/mining-repository", () => ({
  getCoverage: vi.fn(async (siteId: string) => ({
    siteId,
    coveredFrom: COVERED_FROM,
    coveredTo: key(0),
    examined: 0,
    candidates: 0,
    excludedNoDob: 0,
    excludedUnderAge: 0,
    lastRunAt: NOW.toISOString(),
    moreToRead: true,
  })),
  recordScanRun: vi.fn(async (input: Record<string, unknown>) => {
    h.state.scans.push(input);
  }),
  upsertCandidate: vi.fn(async (input: Record<string, unknown>) => {
    h.state.candidates.push(input);
    return true;
  }),
}));

import { runMiningSweep } from "./_mining";
import { MINING_MAX_PATIENT_READS_PER_RUN } from "@/lib/triage/mining";
import { DentallyClient } from "@/lib/dentally/client";

/** The even share each of the three sites gets. */
const SHARE = Math.floor(MINING_MAX_PATIENT_READS_PER_RUN / 3); // 40

/** `n` attended extractions at `dentallyId`, each for its own patient. */
function seed(dentallyId: string, prefix: string, n: number): void {
  h.state.rowsBySite[dentallyId] = Array.from({ length: n }, (_, i) => ({
    id: `a-${prefix}-${i}`,
    patient_id: `${prefix}-${i}`,
    start_time: `${ONLY_DAY}T09:00:00.000Z`,
    state: "Completed",
    reason: "Extraction UR6",
  }));
}

/** How many patient reads went to one site's patients. */
function readsFor(prefix: string): number {
  return h.state.patientCalls.filter((id) => id.startsWith(`${prefix}-`)).length;
}

async function run() {
  return runMiningSweep({
    clientId: "vitality",
    client: new DentallyClient({ apiKey: "k", baseUrl: "http://mock", readOnly: true }),
    now: NOW,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.rowsBySite = {};
  h.state.patientCalls = [];
  h.state.candidates = [];
  h.state.scans = [];
});

describe("the run's patient reads are split evenly between the mapped sites", () => {
  it("a busy first site spends ITS share and the other two are still read", async () => {
    // The exact shape of the defect: the flagship's window holds more extractions
    // than the WHOLE run's budget. Before the split it took all 120 and broke the
    // site loop; sites B and C were never opened.
    seed("d-a", "a", MINING_MAX_PATIENT_READS_PER_RUN + 10);
    seed("d-b", "b", 5);
    seed("d-c", "c", 5);

    const report = await run();

    expect(readsFor("a"), "the busy site did not stop at its own share").toBe(SHARE);
    expect(readsFor("b"), "the second site was starved by the first").toBe(5);
    expect(readsFor("c"), "the third site was starved by the first").toBe(5);
    // Every site is in the report, so the screen can say what happened at each.
    expect(report.sites.map((s) => s.siteId)).toEqual(["site-a", "site-b", "site-c"]);
    expect(report.sites[0].stoppedBy).toBe("patient-budget");
    // ...and the two quiet sites finished their day and grew the list.
    expect(report.sites[1]).toMatchObject({ daysCovered: 1, candidates: 5, stoppedBy: "complete" });
    expect(report.sites[2]).toMatchObject({ daysCovered: 1, candidates: 5, stoppedBy: "complete" });
    expect(report.patientReads).toBe(SHARE + 10);
  });

  it("an UNUSED share is not handed on, so the next site cannot eat the one after it", async () => {
    // The starvation would come straight back if leftovers rolled forward: a quiet
    // first site would hand a busy second site the run.
    seed("d-a", "a", 5);
    seed("d-b", "b", MINING_MAX_PATIENT_READS_PER_RUN);
    seed("d-c", "c", 5);

    const report = await run();

    expect(readsFor("a")).toBe(5);
    expect(readsFor("b"), "the second site spent more than its own share").toBe(SHARE);
    expect(readsFor("c"), "the third site was starved by the second").toBe(5);
    expect(report.sites[1].stoppedBy).toBe("patient-budget");
    expect(report.sites[2]).toMatchObject({ daysCovered: 1, candidates: 5 });
  });

  it("NEVER spends more than the run's own ceiling", async () => {
    // The shares are cut from the same 120: three busy sites must not add up to
    // more than one run's worth of reads.
    seed("d-a", "a", 100);
    seed("d-b", "b", 100);
    seed("d-c", "c", 100);

    const report = await run();

    expect(h.state.patientCalls.length).toBeLessThanOrEqual(MINING_MAX_PATIENT_READS_PER_RUN);
    expect(report.patientReads).toBe(SHARE * 3);
    for (const site of report.sites) expect(site.stoppedBy).toBe("patient-budget");
  });

  it("a site that finds nobody costs nothing and does not deny the others their share", async () => {
    seed("d-a", "a", 0);
    seed("d-b", "b", 30);
    seed("d-c", "c", 30);

    const report = await run();

    expect(readsFor("b")).toBe(30);
    expect(readsFor("c")).toBe(30);
    expect(report.sites.every((s) => s.stoppedBy === "complete")).toBe(true);
  });
});
