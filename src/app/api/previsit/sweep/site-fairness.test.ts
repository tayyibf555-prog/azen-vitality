import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TriageTarget } from "@/lib/triage/types";

// ===========================================================================
// NO SITE STARVES ANOTHER IN PASS 1 (ruling W3/25, applied to the pre-visit
// sweep; charter section 0 item 5 for the reporting half).
//
// `maxExaminedPerRun` used to be ONE POT, spent in SITES order, with both the
// page guard and the row guard breaking out of the WHOLE loop when it emptied.
// N15 is first in that order and is the busiest, and the pot is exactly
// `MAX_PAGES_PER_SITE * PER_PAGE`, so one site could take the entire run on its
// own. Cancelled and did-not-attend rows are paged and counted before
// `upcoming()` discards them, and the appointment window is date-granular, so
// every tick re-read the same rows and reached the same wall — N17 and Romford
// Road would have been skipped deterministically, tick after tick, while the run
// report said only `examined: 400`. Patients at two of the practice's three
// sites would never have received a pre-visit link.
//
// This is the identical defect W3/25 closed in the sibling mining engine, and it
// takes the identical fix: an even share per mapped site, a site that spends ITS
// share stops that site rather than the run, and no roll-over.
//
// THREE SITES, which is what the practice actually has and what the single-site
// fixture in sweep.test.ts cannot express. Only the boundaries are faked: the
// real share arithmetic, the real paging and the real per-site accounting run.
// ===========================================================================

const NOW = new Date("2026-09-10T12:00:00.000Z");
const APPOINTMENT_AT = "2026-09-11T12:00:00.000Z";

function target(over: Partial<TriageTarget> = {}): TriageTarget {
  return {
    id: "site-a:appt-1",
    siteId: "site-a",
    dentallyPatientId: "p-1",
    appointmentId: "appt-1",
    patientName: "Alex Berry",
    fork: "full",
    appointmentAt: APPOINTMENT_AT,
    dueAt: "2026-09-10T12:00:00.000Z",
    status: "pending",
    stopReason: null,
    consentSms: true,
    linkToken: "AbCdEfGhIjKlMnOpQrStUv",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...over,
  };
}

const h = vi.hoisted(() => {
  const sites = [
    { id: "site-a", clientId: "vitality", name: "N15 Vitality Dental", dentallyId: "d-a" },
    { id: "site-b", clientId: "vitality", name: "N17", dentallyId: "d-b" },
    { id: "site-c", clientId: "vitality", name: "Romford Road", dentallyId: "d-c" },
  ];
  const state = {
    /** Appointment rows per DENTALLY site id, paged by the fake below. */
    rowsBySite: {} as Record<string, unknown[]>,
    upserted: [] as Array<Record<string, unknown>>,
    targetIds: new Set<string>(),
  };
  return {
    state,
    sites,
    // PAGES HONESTLY. The route asks page by page at `perPage`, and a fake that
    // returned the whole fixture to page 1 would make the page guard — the other
    // half of the budget — untestable.
    listAppointments: vi.fn(async (args: { siteId: string; page: number; perPage: number }) => {
      const all = state.rowsBySite[args.siteId] ?? [];
      const start = (args.page - 1) * args.perPage;
      return { appointments: all.slice(start, start + args.perPage) };
    }),
    getPatient: vi.fn(async () => ({
      patient: { first_name: "Alex", last_name: "Berry", use_sms: true, payment_plan_id: 2 },
    })),
    listTargets: vi.fn(async () => []),
    upsertTargetIfNew: vi.fn(async (input: Record<string, unknown>) => {
      state.upserted.push(input);
      const id = `${String(input.siteId)}:${String(input.appointmentId)}`;
      if (state.targetIds.has(id)) return null;
      state.targetIds.add(id);
      return { ...target(), ...input, id };
    }),
    getTarget: vi.fn(async (id: string) => (state.targetIds.has(id) ? target({ id }) : null)),
    enqueueSend: vi.fn(async () => ({ touchId: "t", outboxId: "o" })),
    stopTarget: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledForSend: async () => true,
}));
vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: async () => true, releaseCronLock: async () => {} }));
vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => "key" }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    listAppointments = h.listAppointments;
    getPatient = h.getPatient;
  },
}));
vi.mock("@/lib/dentally/budget", () => ({
  dentallyScopeRefused: () => false,
  runWithDentallyPriority: async (_p: string, fn: () => Promise<Response>) => fn(),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: h.sites,
  getSite: (id: string) => h.sites.find((s) => s.id === id),
  dentallySiteId: (id: string) => h.sites.find((s) => s.id === id)?.dentallyId ?? id,
}));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: async () => false }));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: async () => new Set<string>(),
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}:${patientId}`,
  isExclusionsUnavailable: () => false,
}));
vi.mock("@/lib/triage/repository", () => ({
  listTargets: h.listTargets,
  upsertTargetIfNew: h.upsertTargetIfNew,
  enqueueSend: h.enqueueSend,
  stopTarget: h.stopTarget,
  getTarget: h.getTarget,
  triageTargetId: (siteId: string, appointmentId: string) => `${siteId}:${appointmentId}`,
}));

import { POST } from "./route";

interface RunReport {
  examined: number;
  flagged: number;
  sites: Array<{ siteId: string; examined: number; flagged: number; exhausted: boolean }>;
}

function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/previsit/sweep", { method: "POST" }));
}

/** `n` live, future appointments for one Dentally site. */
function seed(dentallyId: string, n: number, prefix: string) {
  h.state.rowsBySite[dentallyId] = Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    patient_id: `${prefix}-p-${i}`,
    start_time: APPOINTMENT_AT,
    state: "booked",
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.state.rowsBySite = {};
  h.state.upserted = [];
  h.state.targetIds = new Set();
  process.env.PUBLIC_BASE_URL = "https://azen-vitality.vercel.app";
  // 30 rows a run, three mapped sites -> an even share of 10 each. Small enough
  // that the arithmetic below is checkable by eye and the fixtures stay readable.
  process.env.PREVISIT_MAX_EXAMINED = "30";
});

afterEach(() => {
  // An env var left set is the quietest way to make a later test in this file —
  // or in another file sharing this worker — prove something else.
  delete process.env.PREVISIT_MAX_EXAMINED;
});

describe("the examination budget is split evenly between the mapped sites", () => {
  it("previsit-sweep-a-busy-first-site-does-not-starve-the-others", async () => {
    // N15 alone holds more than the WHOLE run's budget, which under the old
    // run-wide pot meant the other two sites were never opened.
    seed("d-a", 60, "a");
    seed("d-b", 4, "b");
    seed("d-c", 4, "c");

    const report = (await (await run()).json()) as unknown as RunReport;

    const bySite = new Map(report.sites.map((s) => [s.siteId, s]));
    expect(bySite.get("site-a")?.examined, "the flagship took more than its share").toBe(10);
    expect(bySite.get("site-b")?.examined, "N17 was never opened").toBe(4);
    expect(bySite.get("site-c")?.examined, "Romford Road was never opened").toBe(4);

    // Every one of the smaller sites' patients is flagged, which is the whole
    // point: they were previously flagged never.
    const flaggedSites = new Set(h.state.upserted.map((u) => String(u.siteId)));
    expect([...flaggedSites].sort()).toEqual(["site-a", "site-b", "site-c"]);
  });

  it("previsit-sweep-reports-which-site-was-truncated", async () => {
    // Charter section 0 item 5: a truncated read never wears a complete read's
    // clothes. Without the flag an operator cannot tell a quiet site from one
    // whose share ran out before its book was opened.
    seed("d-a", 60, "a");
    seed("d-b", 4, "b");
    seed("d-c", 4, "c");

    const report = (await (await run()).json()) as unknown as RunReport;
    const bySite = new Map(report.sites.map((s) => [s.siteId, s]));
    expect(bySite.get("site-a")?.exhausted, "the truncated site printed a complete-looking figure").toBe(true);
    expect(bySite.get("site-b")?.exhausted).toBe(false);
    expect(bySite.get("site-c")?.exhausted).toBe(false);
  });

  it("an unused share does NOT roll over to a later site", async () => {
    // Rolling the remainder on would restore the starvation by the back door:
    // a quiet first site would hand the flagship's neighbour a share big enough
    // to consume the third site's. A quiet run finishing under its ceiling is
    // the correct trade for a list that grows everywhere.
    seed("d-a", 1, "a");
    seed("d-b", 60, "b");
    seed("d-c", 5, "c");

    const report = (await (await run()).json()) as unknown as RunReport;
    const bySite = new Map(report.sites.map((s) => [s.siteId, s]));
    expect(bySite.get("site-a")?.examined).toBe(1);
    expect(bySite.get("site-b")?.examined, "site B inherited site A's unspent share").toBe(10);
    expect(bySite.get("site-c")?.examined).toBe(5);
    expect(report.examined, "the run spent more than the three shares").toBe(16);
  });

  it("a site truncated by the PAGE cap is reported as exhausted too", async () => {
    // The budget is not the only bound. `MAX_PAGES_PER_SITE` (4 x 100) stops a
    // mis-filtered query walking the whole book, and with the run budget raised
    // above its reach the page cap is what truncates — the per-site line has to
    // say so, or an operator reads a floor as a total.
    process.env.PREVISIT_MAX_EXAMINED = "3000";
    seed("d-a", 500, "a");

    const report = (await (await run()).json()) as unknown as RunReport;
    const bySite = new Map(report.sites.map((s) => [s.siteId, s]));
    expect(bySite.get("site-a")?.examined, "the page cap is 4 pages of 100").toBe(400);
    expect(bySite.get("site-a")?.exhausted, "a page-capped read printed a complete-looking figure").toBe(true);
    // A site whose book ENDED inside the cap is not flagged: the other direction.
    expect(bySite.get("site-b")?.exhausted).toBe(false);
  });

  it("the run's own ceiling still holds", async () => {
    // The shares are cut from the same pot, so three busy sites spend the run's
    // number and not three times it.
    seed("d-a", 60, "a");
    seed("d-b", 60, "b");
    seed("d-c", 60, "c");

    const report = (await (await run()).json()) as unknown as RunReport;
    expect(report.examined).toBe(30);
    expect(report.sites.every((s) => s.exhausted)).toBe(true);
  });
});
