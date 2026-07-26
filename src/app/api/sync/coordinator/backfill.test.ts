// Coordinator sync: LIVE Dentally field mapping + one-time historical backfill +
// safety guards.
//
// Field mapping (verified 2026-07-26 against api.dentally.co): a real treatment
// plan carries `private_treatment_value` as a STRING ("80.0"), plus `nickname`,
// `completed` and `completed_at`. It has NO amount_outstanding / outstanding /
// balance, so the old mapping defaulted every plan to 0 and then discarded it: the
// module held zero rows on every run, silently.
//
// Backfill: Dentally's /v1/patients has no sort, so the updated_after high-water
// mark strands older-updated patients on a from-scratch pass — backfill pages EVERY
// patient by page NUMBER (cursor in sync_state.backfill_page/backfill_done) until a
// short page, then switches to updated_after incremental.
//
// Guards: inactive patients are never chased (and their stored open opportunities
// are settled); an unreadable plan value drops the plan without being mistaken for
// a settled one; and plans are read PER PATIENT so the retire step always has a
// complete picture, rather than depending on a practice-wide scan that could never
// finish.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CAP = 300; // MAX_PATIENTS_PER_RUN
const PER_PAGE = 100;

type StoredOpp = {
  id: string;
  dentallyPatientId: string;
  dentallyPlanId: string;
  status: string;
  patientName: string;
  consent: { sms: boolean; email: boolean; marketing: boolean };
  lastTouchAt: string | null;
  updatedFromDentallyAt: string;
};

const store = vi.hoisted(() => ({
  cursor: { page: null as number | null, done: false },
  mainHwm: null as string | null,
  backfillSets: [] as Array<{ page: number | null; done: boolean; highWaterMark?: string }>,
  mainSets: [] as string[],
  patientTotal: 0,
  patientOverrides: {} as Record<number, Record<string, unknown>>,
  listCalls: [] as Array<{ page: number; updatedAfter: string | undefined }>,
  /** Plans keyed by patient id, as the source would return them. */
  plansByPatient: {} as Record<string, Array<Record<string, unknown>>>,
  /** When true the source IGNORES patient_id and serves everything (the mock's behaviour). */
  ignorePatientFilter: false,
  planCalls: [] as string[],
  planFailFor: null as string | null,
  stored: [] as StoredOpp[],
  statusSets: [] as Array<{ id: string; status: string }>,
  upserts: [] as string[][], // per-run list of upserted opportunities' patient ids
  upsertRows: [] as Array<{ patientId: string; planId: string; amountOutstanding: number; treatment: string }>,
}));

const dent = vi.hoisted(() => ({
  listTreatmentPlans: vi.fn(async (a: { patientId?: string; page?: number }) => {
    const patientId = a?.patientId ?? "";
    const page = a?.page ?? 1;
    store.planCalls.push(patientId);
    if (store.planFailFor === patientId) throw new Error("dentally 500");
    const rows = store.ignorePatientFilter
      ? Object.values(store.plansByPatient).flat()
      : (store.plansByPatient[patientId] ?? []);
    const start = (page - 1) * PER_PAGE;
    return { treatment_plans: rows.slice(start, start + PER_PAGE) };
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
    listTreatmentPlans(a: unknown) { return dent.listTreatmentPlans(a as { patientId?: string; page?: number }); }
    listPatients(a: unknown) { return dent.listPatients(a as { page?: number; updatedAfter?: string }); }
  },
}));
vi.mock("@/lib/coordinator/repository", () => ({
  upsertOpportunities: (
    opps: Array<{ dentallyPatientId: string; dentallyPlanId: string; amountOutstanding: number; treatment: string }>,
  ) => {
    store.upserts.push(opps.map((o) => o.dentallyPatientId));
    for (const o of opps) {
      store.upsertRows.push({
        patientId: o.dentallyPatientId,
        planId: o.dentallyPlanId,
        amountOutstanding: o.amountOutstanding,
        treatment: o.treatment,
      });
    }
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
interface SiteBody {
  mode: string;
  backfillPage: number | null;
  processed: number;
  retired: number;
  excludedSettled: number;
  remaining: number;
  planReadFailures: number;
  unreadablePlans: number;
  rechecked: number;
  planFilterIgnored: boolean;
}
async function run() {
  const res = await POST(req());
  const body = (await res.json()) as { ok: boolean; failedSites: string[]; perSite: SiteBody[] };
  return body.perSite[0];
}

/** A live-shaped plan: string private_treatment_value, nickname, completed. */
function livePlan(patientId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `plan-${patientId}`,
    patient_id: patientId,
    nickname: "Crown",
    private_treatment_value: "500.0",
    completed: false,
    completed_at: null,
    start_date: "2026-06-01T00:00:00Z",
    ...over,
  };
}

/** One live-shaped open plan per patient. */
function seedPlans(count: number) {
  store.plansByPatient = {};
  for (let i = 0; i < count; i++) store.plansByPatient[`pat-${i}`] = [livePlan(`pat-${i}`)];
}

function storedOpp(over: Partial<StoredOpp> & Pick<StoredOpp, "id" | "dentallyPatientId" | "dentallyPlanId">): StoredOpp {
  return {
    status: "accepted",
    patientName: "A B",
    consent: { sms: true, email: true, marketing: false },
    lastTouchAt: null,
    updatedFromDentallyAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  store.cursor = { page: null, done: false };
  store.mainHwm = null;
  store.backfillSets = [];
  store.mainSets = [];
  store.patientTotal = 0;
  store.patientOverrides = {};
  store.listCalls = [];
  store.plansByPatient = {};
  store.ignorePatientFilter = false;
  store.planCalls = [];
  store.planFailFor = null;
  store.stored = [];
  store.statusSets = [];
  store.upserts = [];
  store.upsertRows = [];
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "bf-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
});
afterEach(() => vi.unstubAllEnvs());

describe("coordinator live Dentally plan mapping", () => {
  it("maps a real plan (string private_treatment_value, nickname) into an opportunity", async () => {
    store.patientTotal = 1;
    store.plansByPatient = { "pat-0": [livePlan("pat-0", { private_treatment_value: "80.0", nickname: "Filling" })] };

    const site = await run();

    // The regression this whole cluster is about: the old mapping read
    // amount_outstanding (absent live), defaulted to 0, and discarded every plan.
    expect(store.upsertRows).toEqual([
      { patientId: "pat-0", planId: "plan-pat-0", amountOutstanding: 80, treatment: "Filling" },
    ]);
    expect(site.unreadablePlans).toBe(0);
  });

  it("never treats a completed plan as an opportunity", async () => {
    store.patientTotal = 1;
    store.plansByPatient = {
      "pat-0": [livePlan("pat-0", { completed: true, completed_at: "2026-07-01T00:00:00Z" })],
    };

    await run();
    expect(store.upsertRows).toEqual([]);
  });

  it("drops a plan whose value is malformed WITHOUT treating it as settled", async () => {
    store.patientTotal = 1;
    store.plansByPatient = { "pat-0": [livePlan("pat-0", { private_treatment_value: "not a number" })] };
    store.stored = [storedOpp({ id: "opp-0", dentallyPatientId: "pat-0", dentallyPlanId: "plan-pat-0" })];

    const site = await run();

    expect(store.upsertRows).toEqual([]);   // no opportunity built on an unreadable value
    expect(site.unreadablePlans).toBe(1);
    expect(store.statusSets).toEqual([]);   // and crucially NOT retired as if it were paid
    expect(site.retired).toBe(0);
  });

  it("still honours an explicit outstanding figure when the source carries one", async () => {
    // The local mock (and the earlier calibration) put amount_outstanding on the plan.
    store.patientTotal = 1;
    store.plansByPatient = {
      "pat-0": [livePlan("pat-0", { private_treatment_value: "500.0", amount_outstanding: 120 })],
    };

    await run();
    expect(store.upsertRows[0].amountOutstanding).toBe(120);
  });

  it("picks the highest-value open plan when a patient has several", async () => {
    store.patientTotal = 1;
    store.plansByPatient = {
      "pat-0": [
        livePlan("pat-0", { id: "plan-small", private_treatment_value: "50.0" }),
        livePlan("pat-0", { id: "plan-big", private_treatment_value: "900.0" }),
        livePlan("pat-0", { id: "plan-done", private_treatment_value: "9000.0", completed: true }),
      ],
    };

    await run();
    expect(store.upsertRows).toEqual([
      { patientId: "pat-0", planId: "plan-big", amountOutstanding: 900, treatment: "Crown" },
    ]);
  });
});

describe("coordinator plan reads are per patient and site-scoped", () => {
  it("reads plans once per active patient, and never for an inactive one", async () => {
    store.patientTotal = 3;
    seedPlans(3);
    store.patientOverrides = { 1: { active: false } };

    await run();
    expect(store.planCalls.sort()).toEqual(["pat-0", "pat-2"]);
  });

  it("suppresses retirement entirely when the source ignores the patient_id filter", async () => {
    // A source that serves the practice-wide index regardless of patient_id would
    // otherwise let one patient's plans decide another patient's fate.
    store.ignorePatientFilter = true;
    store.patientTotal = 1;
    store.plansByPatient = { "pat-0": [livePlan("pat-0")], "pat-99": [livePlan("pat-99")] };
    store.stored = [storedOpp({ id: "opp-gone", dentallyPatientId: "pat-0", dentallyPlanId: "plan-vanished" })];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const site = await run();

    expect(site.planFilterIgnored).toBe(true);
    expect(site.retired).toBe(0);
    expect(store.statusSets).toEqual([]);
    // pat-99's plan was never attributed to pat-0.
    expect(store.upsertRows.map((r) => r.planId)).toEqual(["plan-pat-0"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("a failed plan read leaves that patient's stored opportunity alone", async () => {
    store.patientTotal = 2;
    seedPlans(2);
    store.planFailFor = "pat-1";
    store.stored = [storedOpp({ id: "opp-1", dentallyPatientId: "pat-1", dentallyPlanId: "plan-pat-1" })];

    const site = await run();

    expect(site.planReadFailures).toBe(1);
    expect(store.statusSets).toEqual([]); // never retired on an unread record
    expect(store.upserts.flat()).toEqual(["pat-0"]);
  });
});

describe("coordinator retire + re-check", () => {
  it("retires an opportunity whose plan is now completed", async () => {
    store.patientTotal = 1;
    store.plansByPatient = { "pat-0": [livePlan("pat-0", { completed: true })] };
    store.stored = [storedOpp({ id: "opp-paid", dentallyPatientId: "pat-0", dentallyPlanId: "plan-pat-0" })];

    const site = await run();
    expect(store.statusSets).toEqual([{ id: "opp-paid", status: "completed" }]);
    expect(site.retired).toBe(1);
  });

  it("retires an opportunity whose plan has vanished from the patient's plan set", async () => {
    store.patientTotal = 1;
    store.plansByPatient = { "pat-0": [] };
    store.stored = [storedOpp({ id: "opp-gone", dentallyPatientId: "pat-0", dentallyPlanId: "plan-gone" })];

    const site = await run();
    expect(store.statusSets).toEqual([{ id: "opp-gone", status: "completed" }]);
    expect(site.retired).toBe(1);
  });

  it("re-checks stored opportunities for patients OUTSIDE this run's window", async () => {
    // Incremental mode with nothing changed: the old code could never notice that a
    // stored opportunity's plan had since been completed, because completing a plan
    // need not touch the patient record.
    store.cursor = { page: 9, done: true };
    store.mainHwm = "2026-07-20T00:00:00Z";
    store.patientTotal = 0; // no patient changed
    store.plansByPatient = { "pat-77": [livePlan("pat-77", { completed: true })] };
    store.stored = [storedOpp({ id: "opp-77", dentallyPatientId: "pat-77", dentallyPlanId: "plan-pat-77" })];

    const site = await run();

    expect(site.mode).toBe("incremental");
    expect(site.rechecked).toBe(1);
    expect(store.planCalls).toEqual(["pat-77"]);
    expect(store.statusSets).toEqual([{ id: "opp-77", status: "completed" }]);
  });

  it("a re-checked but still-open opportunity is refreshed, not retired", async () => {
    store.cursor = { page: 9, done: true };
    store.mainHwm = "2026-07-20T00:00:00Z";
    store.patientTotal = 0;
    store.plansByPatient = { "pat-77": [livePlan("pat-77", { private_treatment_value: "640.0" })] };
    store.stored = [
      storedOpp({
        id: "opp-77",
        dentallyPatientId: "pat-77",
        dentallyPlanId: "plan-pat-77",
        patientName: "Ada Lovelace",
      }),
    ];

    await run();

    expect(store.statusSets).toEqual([]);
    expect(store.upsertRows).toEqual([
      { patientId: "pat-77", planId: "plan-pat-77", amountOutstanding: 640, treatment: "Crown" },
    ]);
  });
});

describe("coordinator inactive-patient exclusion", () => {
  it("never maps an inactive patient and settles their stored open opportunity", async () => {
    store.patientTotal = 2;
    seedPlans(2);
    store.patientOverrides = { 1: { active: false } };
    store.stored = [storedOpp({ id: "opp-inactive", dentallyPatientId: "pat-1", dentallyPlanId: "plan-pat-1", status: "in_progress" })];

    const site = await run();

    expect(store.upserts.flat()).toEqual(["pat-0"]);
    // Settled via the EXCLUSION path, not retire: their plan is still open.
    expect(store.statusSets).toEqual([{ id: "opp-inactive", status: "completed" }]);
    expect(site.excludedSettled).toBe(1);
    expect(site.retired).toBe(0);
  });

  it("does NOT exclude a patient who merely carries archived_reason", async () => {
    // The live patient record has no `archived` field at all, only `archived_reason`,
    // so the old `archived === true` test was dead code. Removing it must not change
    // who is excluded: `active === false` is, and remains, the only exclusion.
    store.patientTotal = 2;
    seedPlans(2);
    store.patientOverrides = { 1: { archived_reason: "lapsed", active: true } };

    const site = await run();

    expect(store.upserts.flat().sort()).toEqual(["pat-0", "pat-1"]);
    expect(site.excludedSettled).toBe(0);
  });
});

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

  it("does NOT advance the backfill cursor past a page holding a failed plan read", async () => {
    // The patient feed is unordered, so a cursor that steps over a patient whose plan
    // read failed loses them until Dentally re-stamps the record, which for a
    // treatment plan may be never. Recall protects against this; so must this sync.
    store.patientTotal = 250;
    seedPlans(250);
    store.planFailFor = "pat-150"; // page 2 (patients 100-199)

    const site = await run();

    expect(site.planReadFailures).toBe(1);
    expect(site.backfillPage).toBe(1); // rewound to just before the failed page
    expect(store.backfillSets).toEqual([{ page: 1, done: false }]);
    expect(store.backfillSets.some((s) => s.done)).toBe(false); // never "done" with work outstanding
  });

  it("does NOT advance the incremental mark past a patient whose plan read failed", async () => {
    store.cursor = { page: 9, done: true };
    store.mainHwm = "2026-07-01T00:00:00Z";
    store.patientTotal = 2;
    seedPlans(2);
    store.patientOverrides = {
      0: { updated_at: "2026-07-05T00:00:00Z" },
      1: { updated_at: "2026-07-09T00:00:00Z" },
    };
    store.planFailFor = "pat-0"; // the OLDER of the two

    await run();

    // Capped just below pat-0's stamp, so the next run re-pulls them.
    expect(store.mainSets).toHaveLength(1);
    expect(new Date(store.mainSets[0]).getTime()).toBeLessThan(
      new Date("2026-07-05T00:00:00Z").getTime(),
    );
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
});

describe("coordinator run reports a failed site", () => {
  it("answers ok:false and names the site when one fails, instead of a green ok:true", async () => {
    store.patientTotal = 1;
    seedPlans(1);
    dent.listPatients.mockRejectedValueOnce(new Error("dentally down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req());
    const body = (await res.json()) as { ok: boolean; failedSites: string[]; perSite: Array<{ error?: string }> };

    // Still HTTP 200 (pg_cron's trigger_app_cron fires http_get and never sees the
    // status), but unmistakably not ok.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.failedSites).toEqual(["site-1"]);
    expect(body.perSite[0].error).toContain("dentally down");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("answers ok:true with an empty failedSites list on a clean run", async () => {
    store.patientTotal = 1;
    seedPlans(1);

    const res = await POST(req());
    const body = (await res.json()) as { ok: boolean; failedSites: string[] };
    expect(body.ok).toBe(true);
    expect(body.failedSites).toEqual([]);
  });
});
