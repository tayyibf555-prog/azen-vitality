import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ===========================================================================
// NO SITE STARVES ANOTHER IN PASS 1 (ruling W3/25, applied to the post-op
// sweep; charter section 0 item 5 for the reporting half).
//
// `maxExaminedPerRun` used to be ONE POT, spent in SITES order, with both the
// page guard and the row guard breaking out of the WHOLE loop when it emptied.
// The default pot is 500 and one site can page MAX_PAGES_PER_SITE * PER_PAGE =
// 300, so two busy sites empty it between them; N15 is first in that order and
// is the busiest, and the window is a date-granular last-two-days read, so every
// hourly tick re-read the same rows and reached the same wall. Romford Road's
// post-op patients would have been flagged never, and the run report said only
// `examined: 500` — the same figure a healthy run prints.
//
// This is the identical defect W3/25 closed in the mining engine and the
// pre-visit sweep, and it takes the identical fix: an even share per mapped
// site, a site that spends ITS share stops that site rather than the run, and no
// roll-over.
//
// THE SECOND HALF IS THE MEMO. `patientFacts` was called for every flagged row
// before `upsertTargetIfNew`, with no memo at all — so a procedure sitting in
// the two-day window cost one Dentally patient read on each of the up-to-48
// ticks that could still see it, every one of which was thrown away by the
// idempotent upsert. Asking our own worklist first is the whole saving.
//
// THREE SITES, which is what the practice actually has and what the single-site
// fixture in src/lib/postop/sweep.test.ts cannot express. Only the boundaries
// are faked: the real share arithmetic, the real paging, the real memo and the
// real per-site accounting run.
// ===========================================================================

const NOW = new Date("2026-08-19T10:00:00.000Z");
/** Inside the two-day read window, and attended, so every seeded row flags. */
const PROCEDURE_AT = "2026-08-18T09:00:00.000Z";

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
    // returned the whole fixture to page 1 would make the page cap — the other
    // half of the budget — untestable.
    listAppointments: vi.fn(async (args: { siteId: string; page: number; perPage: number }) => {
      const all = state.rowsBySite[args.siteId] ?? [];
      const start = (args.page - 1) * args.perPage;
      return { appointments: all.slice(start, start + args.perPage) };
    }),
    getPatient: vi.fn(async () => ({
      patient: { first_name: "Sarah", last_name: "Lindqvist", use_sms: true, use_email: false },
    })),
    listTargets: vi.fn(async () => []),
    insertDraft: vi.fn(async () => ({ id: "t-1" })),
    stopTarget: vi.fn(async () => {}),
    upsertTargetIfNew: vi.fn(async (input: Record<string, unknown>) => {
      state.upserted.push(input);
      const id = `${String(input.siteId)}:${String(input.appointmentId)}`;
      if (state.targetIds.has(id)) return null;
      state.targetIds.add(id);
      return { id, ...input };
    }),
    getTarget: vi.fn(async (id: string) => (state.targetIds.has(id) ? { id } : null)),
  };
});

vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => true }));
vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: async () => true, releaseCronLock: async () => {} }));
vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => "key" }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    listAppointments = h.listAppointments;
    getPatient = h.getPatient;
  },
  DentallyError: class extends Error {},
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
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}::${patientId}`,
  isExclusionsUnavailable: () => false,
}));
vi.mock("@/lib/postop/repository", () => ({
  upsertTargetIfNew: h.upsertTargetIfNew,
  listTargets: h.listTargets,
  insertDraft: h.insertDraft,
  stopTarget: h.stopTarget,
  getTarget: h.getTarget,
  postopTargetId: (siteId: string, appointmentId: string) => `${siteId}:${appointmentId}`,
}));

import { POST } from "./route";

interface RunReport {
  examined: number;
  flagged: number;
  alreadyFlagged: number;
  sites: Array<{ siteId: string; examined: number; flagged: number; exhausted: boolean }>;
}

function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/postop/sweep", { method: "POST" }));
}

/** `n` attended, procedure-bearing appointments for one Dentally site. */
function seed(dentallyId: string, n: number, prefix: string) {
  h.state.rowsBySite[dentallyId] = Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    patient_id: `${prefix}-p-${i}`,
    start_time: "2026-08-18T08:00:00.000Z",
    finish_time: PROCEDURE_AT,
    state: "Completed",
    reason: "Extraction UR6",
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.state.rowsBySite = {};
  h.state.upserted = [];
  h.state.targetIds = new Set();
  process.env.DENTALLY_API_KEY = "key";
  // 30 rows a run, three mapped sites -> an even share of 10 each. Small enough
  // that the arithmetic below is checkable by eye and the fixtures stay readable.
  process.env.POSTOP_MAX_EXAMINED_PER_RUN = "30";
});

afterEach(() => {
  vi.useRealTimers();
  // An env var left set is the quietest way to make a later test in this file —
  // or in another file sharing this worker — prove something else.
  delete process.env.POSTOP_MAX_EXAMINED_PER_RUN;
});

describe("the examination budget is split evenly between the mapped sites", () => {
  it("postop-sweep-a-busy-first-site-does-not-starve-the-others", async () => {
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

  it("postop-sweep-reports-which-site-was-truncated", async () => {
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
    // Rolling the remainder on would restore the starvation by the back door: a
    // quiet first site would hand its neighbour a share big enough to consume the
    // third site's. A quiet run finishing under its ceiling is the correct trade
    // for a worklist that grows everywhere.
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

describe("an appointment already on the worklist costs no Dentally read", () => {
  it("postop-sweep-does-not-re-read-a-patient-it-has-already-flagged", async () => {
    // THE COST THIS CLOSES. The window is two days wide and the sweep is hourly,
    // so the same completed extraction is re-read up to 48 times; before the memo
    // each of those cost a `getPatient` whose answer the idempotent upsert threw
    // away. The practice's Dentally quota is shared with production traffic
    // (charter section 0 item 4).
    seed("d-a", 3, "a");

    const first = (await (await run()).json()) as unknown as RunReport;
    expect(first.flagged).toBe(3);
    expect(first.alreadyFlagged).toBe(0);
    expect(h.getPatient).toHaveBeenCalledTimes(3);

    h.getPatient.mockClear();
    h.upsertTargetIfNew.mockClear();

    const second = (await (await run()).json()) as unknown as RunReport;
    expect(second.examined, "the second tick read the same book").toBe(3);
    expect(second.alreadyFlagged, "the memo did not recognise its own rows").toBe(3);
    expect(h.getPatient, "a patient already on the worklist was read again").not.toHaveBeenCalled();
    expect(h.upsertTargetIfNew, "the upsert was still asked to decide").not.toHaveBeenCalled();
  });

  it("a worklist read that FAILS falls through to the patient read, never skips the row", async () => {
    // The memo is a COST optimisation, not a safety guard. Its fail-closed
    // direction would be to assume the appointment is already flagged and never
    // flag it, which would silently drop a patient's check-in for the sake of one
    // Dentally read. The idempotent upsert is what actually decides.
    seed("d-a", 2, "a");
    h.getTarget.mockRejectedValue(new Error("worklist unreadable"));

    const report = (await (await run()).json()) as unknown as RunReport;
    expect(report.flagged, "a database blip dropped a post-op check-in").toBe(2);
    expect(report.alreadyFlagged).toBe(0);
    expect(h.getPatient).toHaveBeenCalledTimes(2);
  });

  it("one patient with two procedures in the window costs ONE patient read", async () => {
    // The per-run memo, which is the other half. Two appointments for the same
    // person inside a two-day window is ordinary — an extraction and a review —
    // and the facts taken are the patient's, not the appointment's.
    h.state.rowsBySite["d-a"] = [
      {
        id: "appt-1",
        patient_id: "shared-p",
        start_time: "2026-08-18T08:00:00.000Z",
        finish_time: PROCEDURE_AT,
        state: "Completed",
        reason: "Extraction UR6",
      },
      {
        id: "appt-2",
        patient_id: "shared-p",
        start_time: "2026-08-18T11:00:00.000Z",
        finish_time: "2026-08-18T12:00:00.000Z",
        state: "Completed",
        reason: "Extraction UL6",
      },
    ];

    const report = (await (await run()).json()) as unknown as RunReport;
    expect(report.flagged).toBe(2);
    expect(h.getPatient, "the same patient was read twice in one run").toHaveBeenCalledTimes(1);
  });
});
