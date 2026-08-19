// Reactivation had the identical defect to recall: the enrol action exists but no
// screen calls it, so thousands of dormant targets never got a cadence and
// switching the module on sent nothing. The sync now auto-enrols. This pins the
// guards that make that safe: the kill switch, the owner's daily contact limit,
// the per-run ceiling, consent, the admin exclusion list, the one-year lapse
// ceiling, recall's ownership of a patient, and never enrolling twice.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MAX_ENROLMENTS_PER_RUN = 25; // must match the route constant
const DAY = 86_400_000;

const store = vi.hoisted(() => ({
  dormant: [] as Array<Record<string, unknown>>,
  cadences: [] as Array<{ targetId: string }>,
  dueCadences: [] as unknown[],
  dailyLimit: 25,
  usedToday: 0,
  maxLapseMonths: Number.POSITIVE_INFINITY,
  systemEnabled: true,
  excluded: new Set<string>(),
  openRecall: new Set<string>(),
  created: [] as Array<{ targetId: string; nextDueAt: string }>,
  statusSets: [] as Array<{ id: string; status: string }>,
  listTargetsCalls: [] as Array<{ limit: number | undefined }>,
}));

vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: vi.fn(async () => true), releaseCronLock: vi.fn(async () => {}) }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => "k" }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    // No patients pulled: the enrol pass works off STORED targets, so the sync's
    // classification half is deliberately empty here.
    listTreatmentPlans() { return Promise.resolve({ treatment_plans: [] as unknown[] }); }
    listPatients() { return Promise.resolve({ patients: [] as unknown[] }); }
    getPatientAppointments() { return Promise.resolve({ appointments: [] as unknown[] }); }
    getPatientInvoices() { return Promise.resolve({ invoices: [] as unknown[] }); }
  },
}));
vi.mock("@/lib/reactivation/repository", () => ({
  upsertTargets: vi.fn(async () => {}),
  // Honours `limit` exactly as the real repository does (it issues a .limit() on
  // the query). A double that ignored it would let the enrol pass appear to work
  // while silently pulling the WHOLE dormant book — tens of thousands of rows —
  // into a 300s function to pick at most 25, and no test would notice.
  listTargets: vi.fn(async (q: { statuses?: string[]; limit?: number }) => {
    if (!(q.statuses?.length === 1 && q.statuses[0] === "dormant")) return [];
    store.listTargetsCalls.push({ limit: q.limit });
    const limit = q.limit;
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? store.dormant.slice(0, Math.floor(limit))
      : store.dormant;
  }),
  setTargetStatus: vi.fn(async (id: string, status: string) => { store.statusSets.push({ id, status }); }),
  getCadenceByTarget: vi.fn(async () => null),
  createCadence: vi.fn(async (i: { targetId: string; nextDueAt: string }) => {
    store.created.push({ targetId: i.targetId, nextDueAt: i.nextDueAt });
    return { id: `cad-${i.targetId}` };
  }),
  listCadences: vi.fn(async () => store.cadences),
  listDueCadences: vi.fn(async () => store.dueCadences),
  updateCadence: vi.fn(async () => {}),
  getSyncState: vi.fn(async () => null),
  setSyncState: vi.fn(async () => {}),
  getBackfillCursor: vi.fn(async () => ({ page: 5, done: true })),
  setBackfillCursor: vi.fn(async () => {}),
}));
vi.mock("@/lib/reactivation/settings", () => ({
  getDailyContactLimit: async () => store.dailyLimit,
  countContactedToday: async () => store.usedToday,
  getMaxLapseMonths: async () => store.maxLapseMonths,
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => store.systemEnabled }));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: async () => store.excluded,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}:${patientId}`,
}));
vi.mock("@/lib/recall/repository", () => ({ listOpenRecallPatientKeys: async () => store.openRecall }));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

/** A dormant reactivation target whose last visit is six months ago. */
function target(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `site-1:${id}`,
    siteId: "site-1",
    dentallyPatientId: id,
    patientName: "Test Patient",
    reason: "lapsed",
    lastVisitAt: new Date(Date.now() - 180 * DAY).toISOString(),
    recoverableValue: 180,
    status: "dormant",
    priorAttempts: 0,
    consent: { sms: true, email: true, marketing: false },
    ...over,
  };
}

async function run() {
  const res = await POST(
    new Request("http://localhost/api/sync/reactivation", { method: "POST", headers: { authorization: "Bearer rx-secret" } }),
  );
  return (await res.json()) as {
    ok: boolean;
    enrolBudget: number;
    perSite: Array<{ enrolled: number }>;
  };
}

beforeEach(() => {
  store.dormant = [];
  store.cadences = [];
  store.dueCadences = [];
  store.dailyLimit = 25;
  store.usedToday = 0;
  store.maxLapseMonths = Number.POSITIVE_INFINITY;
  store.systemEnabled = true;
  store.excluded = new Set();
  store.openRecall = new Set();
  store.created = [];
  store.statusSets = [];
  store.listTargetsCalls = [];
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "rx-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("reactivation sync auto-enrolment", () => {
  it("starts a cadence for a dormant, consented target and moves it in_cadence", async () => {
    store.dormant = [target("p-1")];
    const out = await run();

    expect(out.perSite[0].enrolled).toBe(1);
    expect(store.created.map((c) => c.targetId)).toEqual(["site-1:p-1"]);
    expect(store.statusSets).toContainEqual({ id: "site-1:p-1", status: "in_cadence" });
  });

  it("never enrols more than the per-run ceiling in one sweep", async () => {
    store.dormant = Array.from({ length: 200 }, (_, i) => target(`p-${i}`));
    store.dailyLimit = 500;
    const out = await run();

    expect(out.perSite[0].enrolled).toBe(MAX_ENROLMENTS_PER_RUN);
  });

  it("stops at what is left of the owner's daily contact limit", async () => {
    store.dormant = Array.from({ length: 50 }, (_, i) => target(`p-${i}`));
    store.dailyLimit = 10;
    store.usedToday = 4;
    store.dueCadences = [{ id: "c-1" }, { id: "c-2" }];
    const out = await run();

    expect(out.enrolBudget).toBe(4);
    expect(out.perSite[0].enrolled).toBe(4);
  });

  it("enrols nobody while the owner has reactivation switched off", async () => {
    store.dormant = Array.from({ length: 10 }, (_, i) => target(`p-${i}`));
    store.systemEnabled = false;
    const out = await run();

    expect(out.enrolBudget).toBe(0);
    expect(store.created).toHaveLength(0);
  });

  it("never enrols a patient the sweep would refuse to message", async () => {
    store.dormant = [
      target("p-nosms", { consent: { sms: false, email: true, marketing: false } }),
      // No visit on record: still refused. Removing the one year cap opened the
      // window, it did not remove the requirement to prove the patient attended.
      target("p-novisit", { lastVisitAt: null }),
      target("p-excluded"),
      target("p-recall"),
      target("p-enrolled"),
      target("p-ok"),
    ];
    store.excluded = new Set(["site-1:p-excluded"]);
    // Recall owns this patient until it hands off; never chase them twice.
    store.openRecall = new Set(["site-1:p-recall"]);
    store.cadences = [{ targetId: "site-1:p-enrolled" }];
    const out = await run();

    expect(out.perSite[0].enrolled).toBe(1);
    expect(store.created.map((c) => c.targetId)).toEqual(["site-1:p-ok"]);
  });

  // The old assertion here was that a target lapsed 400 days was refused. That was
  // the one year cap the practice has now asked us to drop: every lapsed patient is
  // reachable, so a five year lapse enrols like any other.
  it("enrols a patient lapsed five years, with no upper bound configured", async () => {
    store.dormant = [target("p-5yr", { lastVisitAt: new Date(Date.now() - 1825 * DAY).toISOString() })];
    const out = await run();

    expect(out.perSite[0].enrolled).toBe(1);
    expect(store.created.map((c) => c.targetId)).toEqual(["site-1:p-5yr"]);
  });

  it("refuses beyond the maximum lapse once the practice sets one", async () => {
    store.maxLapseMonths = 24;
    store.dormant = [
      target("p-5yr", { lastVisitAt: new Date(Date.now() - 1825 * DAY).toISOString() }),
      target("p-13mo", { lastVisitAt: new Date(Date.now() - 400 * DAY).toISOString() }),
    ];
    const out = await run();

    expect(out.perSite[0].enrolled).toBe(1);
    expect(store.created.map((c) => c.targetId)).toEqual(["site-1:p-13mo"]);
  });

  it("reads a BOUNDED window of the dormant book, never the whole thing", async () => {
    // The per-run ceiling bounds how many cadences are CREATED; this bounds how
    // many rows are READ to find them. Without it the enrol pass pulls every
    // dormant row for the site — ~30k on the live base, with no upper lapse bound
    // configured — into a 300s function in order to pick at most 25, on every
    // tick, for every site. The other tests cannot see this: they all pass a pool
    // smaller than the window.
    store.dormant = Array.from({ length: 30_000 }, (_, i) => target(`p-${i}`));
    await run();

    expect(store.listTargetsCalls).toHaveLength(1);
    const limit = store.listTargetsCalls[0]?.limit;
    expect(typeof limit).toBe("number");
    // A window, and one that is comfortably wider than the ceiling it feeds, so
    // consent and exclusion skips inside it are absorbed rather than starving the run.
    expect(limit).toBeGreaterThanOrEqual(MAX_ENROLMENTS_PER_RUN * 4);
    expect(limit).toBeLessThan(30_000);
  });

  it("holds every bound with a pool the size of the whole lapsed book", async () => {
    // ~30k active patients have no appointment in the last 12 months. One sweep must
    // still start at most the per-run ceiling of cadences, and no more than what is
    // left of the day's contact budget.
    store.dormant = Array.from({ length: 30_000 }, (_, i) => target(`p-${i}`));
    store.dailyLimit = 500;
    expect((await run()).perSite[0].enrolled).toBe(MAX_ENROLMENTS_PER_RUN);

    store.created = [];
    store.dailyLimit = 12;
    store.usedToday = 9;
    expect((await run()).perSite[0].enrolled).toBe(3);
  });
});
