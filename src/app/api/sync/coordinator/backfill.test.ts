// Coordinator sync: one-time historical backfill + safety guards. Dentally's
// /v1/patients has no sort, so the updated_after high-water mark strands
// older-updated patients on a from-scratch pass — backfill pages EVERY patient by
// page NUMBER (cursor in sync_state.backfill_page/backfill_done) until a short
// page, then switches to updated_after incremental. Also pins the two other
// go-live guards: inactive/archived patients are never chased (and their stored
// open opportunities are settled), and a TRUNCATED treatment-plans scan skips the
// retire step (a partial plan index would wrongly retire live opportunities).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CAP = 300; // MAX_PATIENTS_PER_RUN
const PER_PAGE = 100;

type StoredOpp = { id: string; dentallyPatientId: string; dentallyPlanId: string; status: string };

const store = vi.hoisted(() => ({
  cursor: { page: null as number | null, done: false },
  mainHwm: null as string | null,
  backfillSets: [] as Array<{ page: number | null; done: boolean; highWaterMark?: string }>,
  mainSets: [] as string[],
  patientTotal: 0,
  patientOverrides: {} as Record<number, Record<string, unknown>>,
  listCalls: [] as Array<{ page: number; updatedAfter: string | undefined }>,
  plans: [] as Array<Record<string, unknown>>,
  plansEndless: false, // serve FULL pages forever -> the bounded scan truncates
  planCalls: 0,
  stored: [] as Array<{ id: string; dentallyPatientId: string; dentallyPlanId: string; status: string }>,
  statusSets: [] as Array<{ id: string; status: string }>,
  upserts: [] as string[][], // per-run list of upserted opportunities' patient ids
}));

const dent = vi.hoisted(() => ({
  listTreatmentPlans: vi.fn(async (a: { page?: number }) => {
    const page = a?.page ?? 1;
    store.planCalls += 1;
    if (store.plansEndless) {
      const treatment_plans = [];
      for (let i = 0; i < PER_PAGE; i++) {
        treatment_plans.push({
          id: `noise-${page}-${i}`,
          patient_id: `nobody-${page}-${i}`,
          name: "Noise",
          amount_outstanding: 5,
          accepted_at: "2026-06-01T00:00:00Z",
        });
      }
      return { treatment_plans };
    }
    const start = (page - 1) * PER_PAGE;
    return { treatment_plans: store.plans.slice(start, start + PER_PAGE) };
  }),
  listPatients: vi.fn(async (a: { page?: number; updatedAfter?: string }) => {
    const page = a?.page ?? 1;
    store.listCalls.push({ page, updatedAfter: a?.updatedAfter });
    const start = (page - 1) * PER_PAGE;
    const end = Math.min(start + PER_PAGE, store.patientTotal);
    const patients = [];
    for (let i = start; i < end; i++) {
      patients.push({
        id: `pat-${i}`,
        first_name: "A",
        last_name: `B${i}`,
        updated_at: "2026-07-06T00:00:00Z",
        use_sms: true,
        ...(store.patientOverrides[i] ?? {}),
      });
    }
    return { patients };
  }),
}));

vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: vi.fn(async () => true), releaseCronLock: vi.fn(async () => {}) }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listTreatmentPlans(a: unknown) { return dent.listTreatmentPlans(a as { page?: number }); }
    listPatients(a: unknown) { return dent.listPatients(a as { page?: number; updatedAfter?: string }); }
  },
}));
vi.mock("@/lib/coordinator/repository", () => ({
  upsertOpportunities: (opps: Array<{ dentallyPatientId: string }>) => {
    store.upserts.push(opps.map((o) => o.dentallyPatientId));
    return Promise.resolve();
  },
  listOpportunities: () => Promise.resolve(store.stored),
  setOpportunityStatus: (id: string, status: string) => {
    store.statusSets.push({ id, status });
    return Promise.resolve();
  },
  getSyncState: () => Promise.resolve(store.mainHwm !== null ? { highWaterMark: store.mainHwm } : null),
  setSyncState: (_s: string, _r: string, v: string) => { store.mainHwm = v; store.mainSets.push(v); return Promise.resolve(); },
  getBackfillCursor: () => Promise.resolve({ page: store.cursor.page, done: store.cursor.done }),
  setBackfillCursor: (_s: string, _r: string, opts: { page: number | null; done: boolean; highWaterMark?: string }) => {
    store.cursor = { page: opts.page, done: opts.done };
    store.backfillSets.push(opts);
    if (opts.highWaterMark !== undefined) store.mainHwm = opts.highWaterMark;
    return Promise.resolve();
  },
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
  siteIdFromDentally: (id: string) => id,
}));

import { POST } from "./route";

function req(): Request {
  return new Request("http://localhost/api/sync/coordinator", { method: "POST", headers: { authorization: "Bearer bf-secret" } });
}
async function run() {
  const res = await POST(req());
  const body = (await res.json()) as {
    perSite: Array<{
      mode: string;
      backfillPage: number | null;
      processed: number;
      retired: number;
      excludedSettled: number;
      remaining: number;
    }>;
  };
  return body.perSite[0];
}

/** One open plan per patient (outstanding > 0), so every processed active patient maps to an opportunity. */
function seedPlans(count: number) {
  store.plans = [];
  for (let i = 0; i < count; i++) {
    store.plans.push({
      id: `plan-${i}`,
      patient_id: `pat-${i}`,
      name: "Crown",
      planned_private_treatment_value: 500,
      amount_outstanding: 100,
      accepted_at: "2026-06-01T00:00:00Z",
      status: "accepted",
    });
  }
}

beforeEach(() => {
  store.cursor = { page: null, done: false };
  store.mainHwm = null;
  store.backfillSets = [];
  store.mainSets = [];
  store.patientTotal = 0;
  store.patientOverrides = {};
  store.listCalls = [];
  store.plans = [];
  store.plansEndless = false;
  store.planCalls = 0;
  store.stored = [];
  store.statusSets = [];
  store.upserts = [];
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "bf-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
});
afterEach(() => vi.unstubAllEnvs());

describe("coordinator historical backfill (page cursor)", () => {
  it("from-scratch backfill pages the WHOLE base by page number and sets done=true only after the short page", async () => {
    store.patientTotal = 350; // more than the 300 cap -> stops at a page boundary
    seedPlans(350);

    const first = await run();
    expect(first.mode).toBe("backfill");
    expect(first.processed).toBe(CAP); // 3 whole pages
    expect(first.backfillPage).toBe(3);
    expect(store.backfillSets).toEqual([{ page: 3, done: false }]); // done NOT set mid-base
    expect(store.mainSets).toHaveLength(0); // incremental mark NOT seeded mid-backfill
    // Backfill pages by page NUMBER and ignores updated_after (it must see ALL patients).
    expect(store.listCalls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(store.listCalls.every((c) => c.updatedAfter === undefined)).toBe(true);

    store.listCalls = [];
    const second = await run();
    expect(second.mode).toBe("backfill-done");
    expect(store.listCalls.map((c) => c.page)).toEqual([4]); // resumed AFTER the cursor page
    // done=true only after the short page, with the incremental mark seeded atomically.
    const doneWrite = store.backfillSets.find((s) => s.done);
    expect(doneWrite).toBeTruthy();
    expect(Number.isNaN(Date.parse(doneWrite!.highWaterMark ?? ""))).toBe(false);
    // The WHOLE base was processed: all 350 patients (each with an open plan) became
    // opportunities across the two runs — nothing stranded past the first run's cap.
    const seen = new Set(store.upserts.flat());
    expect(seen.size).toBe(350);
  });

  it("a capped backfill run resumes from the cursor next run with no patient skipped", async () => {
    store.patientTotal = 350;
    seedPlans(350);
    store.cursor = { page: 3, done: false }; // a prior capped run completed pages 1-3

    const site = await run();
    expect(site.mode).toBe("backfill-done");
    expect(store.listCalls.map((c) => c.page)).toEqual([4]); // resumes at cursor+1
    // Exactly patients 300-349 picked up: nothing skipped, nothing re-pulled.
    const seen = store.upserts.flat();
    expect(seen).toHaveLength(50);
    expect(new Set(seen)).toEqual(new Set(Array.from({ length: 50 }, (_, i) => `pat-${300 + i}`)));
  });

  it("never maps an inactive/archived patient to an opportunity and settles their stored open opportunity", async () => {
    store.patientTotal = 3;
    seedPlans(3); // ALL three have an open plan (outstanding > 0)
    store.patientOverrides = { 1: { active: false }, 2: { archived: true } };
    store.stored = [
      { id: "opp-inactive", dentallyPatientId: "pat-1", dentallyPlanId: "plan-1", status: "accepted" },
      { id: "opp-archived", dentallyPatientId: "pat-2", dentallyPlanId: "plan-2", status: "in_progress" },
    ] satisfies StoredOpp[];

    const site = await run();
    // Only the active patient became an opportunity.
    expect(store.upserts.flat()).toEqual(["pat-0"]);
    // Both stored open opportunities were settled 'completed' — via the EXCLUSION
    // path, not retire: their plans are still open, so retire would have kept them.
    expect(store.statusSets).toHaveLength(2);
    expect(store.statusSets).toContainEqual({ id: "opp-inactive", status: "completed" });
    expect(store.statusSets).toContainEqual({ id: "opp-archived", status: "completed" });
    expect(site.excludedSettled).toBe(2);
    expect(site.retired).toBe(0); // not double-settled by the retire step
  });

  it("skips the retire step when the plans scan is truncated, but still retires a paid plan after a clean scan", async () => {
    // Truncated: full pages forever -> the page cap is hit without a short page. The
    // stale opportunity's plan is outside the scanned window; without the guard it
    // would be wrongly retired as 'completed'.
    store.plansEndless = true;
    store.patientTotal = 1;
    seedPlans(0);
    store.stored = [
      { id: "opp-stale", dentallyPatientId: "pat-999", dentallyPlanId: "plan-gone", status: "accepted" },
    ] satisfies StoredOpp[];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const truncated = await run();
    expect(store.planCalls).toBe(100); // scan bounded at MAX_PLAN_PAGES
    expect(store.statusSets).toEqual([]); // setOpportunityStatus never called
    expect(truncated.retired).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("plans scan");
    warn.mockRestore();

    // Clean scan (short page): a paid plan (outstanding 0) still retires its opportunity.
    store.plansEndless = false;
    store.plans = [
      { id: "plan-paid", patient_id: "pat-0", name: "Crown", amount_outstanding: 0, accepted_at: "2026-06-01T00:00:00Z" },
    ];
    store.stored = [
      { id: "opp-paid", dentallyPatientId: "pat-0", dentallyPlanId: "plan-paid", status: "accepted" },
    ] satisfies StoredOpp[];
    store.statusSets = [];
    const complete = await run();
    expect(store.statusSets).toEqual([{ id: "opp-paid", status: "completed" }]);
    expect(complete.retired).toBe(1);
  });
});
