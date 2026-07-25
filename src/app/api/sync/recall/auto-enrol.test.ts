// Nothing in the product ever created a recall cadence: the enrol action exists
// but no screen calls it, so thousands of classified targets sat on the worklist
// with no cadence and switching recall on sent nothing at all. The sync now
// auto-enrols. This pins the guards that make that safe against a real 51k
// patient base: the kill switch, the daily contact cap, the per-run ceiling,
// consent, the admin exclusion list, and never enrolling twice.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MAX_ENROLMENTS_PER_RUN = 25; // must match the route constant

const store = vi.hoisted(() => ({
  due: [] as Array<Record<string, unknown>>,
  cadences: [] as Array<{ targetId: string }>,
  dueCadences: [] as unknown[],
  usedToday: 0,
  systemEnabled: true,
  excluded: new Set<string>(),
  created: [] as Array<{ targetId: string; nextDueAt: string }>,
  statusSets: [] as Array<{ id: string; status: string }>,
  graduated: [] as string[],
}));

vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: vi.fn(async () => true), releaseCronLock: vi.fn(async () => {}) }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => "k" }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    // No patients pulled: the enrol pass works off STORED targets, so the sync's
    // classification half is deliberately empty here.
    listPatients() { return Promise.resolve({ patients: [] as unknown[] }); }
    getPatientAppointments() { return Promise.resolve({ appointments: [] as unknown[] }); }
  },
}));
vi.mock("@/lib/recall/repository", () => ({
  upsertTargets: vi.fn(async () => {}),
  listTargets: vi.fn(async (q: { statuses?: string[] }) =>
    q.statuses?.length === 1 && q.statuses[0] === "due" ? store.due : [],
  ),
  markGraduated: vi.fn(async (id: string) => { store.graduated.push(id); }),
  setTargetStatus: vi.fn(async (id: string, status: string) => { store.statusSets.push({ id, status }); }),
  getCadenceByTarget: vi.fn(async () => null),
  createCadence: vi.fn(async (i: { targetId: string; nextDueAt: string }) => {
    store.created.push({ targetId: i.targetId, nextDueAt: i.nextDueAt });
    return { id: `cad-${i.targetId}` };
  }),
  listCadences: vi.fn(async () => store.cadences),
  listDueCadences: vi.fn(async () => store.dueCadences),
  countContactedToday: vi.fn(async () => store.usedToday),
  updateCadence: vi.fn(async () => {}),
  getSyncState: vi.fn(async () => null),
  setSyncState: vi.fn(async () => {}),
  getBackfillCursor: vi.fn(async () => ({ page: 5, done: true })),
  setBackfillCursor: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => store.systemEnabled }));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: async () => store.excluded,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}:${patientId}`,
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

/** A classified, un-enrolled recall target that is overdue by `overdueDays`. */
function target(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: `site-1:${id}:dentist`,
    siteId: "site-1",
    dentallyPatientId: id,
    patientName: "Test Patient",
    recallType: "dentist",
    dueAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    overdueDays: 3,
    lastVisitAt: null,
    priorAttempts: 0,
    status: "due",
    consent: { sms: true, email: true, marketing: false },
    updatedFromDentallyAt: new Date().toISOString(),
    ...over,
  };
}

async function run() {
  const res = await POST(
    new Request("http://localhost/api/sync/recall", { method: "POST", headers: { authorization: "Bearer rc-secret" } }),
  );
  return (await res.json()) as {
    ok: boolean;
    enrolBudget: number;
    perSite: Array<{ enrolled: number }>;
  };
}

beforeEach(() => {
  store.due = [];
  store.cadences = [];
  store.dueCadences = [];
  store.usedToday = 0;
  store.systemEnabled = true;
  store.excluded = new Set();
  store.created = [];
  store.statusSets = [];
  store.graduated = [];
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "rc-secret");
});
afterEach(() => vi.unstubAllEnvs());

describe("recall sync auto-enrolment", () => {
  it("starts a cadence for a due, consented target and moves it in_cadence", async () => {
    store.due = [target("p-1")];
    const out = await run();

    expect(out.perSite[0].enrolled).toBe(1);
    expect(store.created).toHaveLength(1);
    expect(store.created[0].targetId).toBe("site-1:p-1:dentist");
    expect(store.statusSets).toContainEqual({ id: "site-1:p-1:dentist", status: "in_cadence" });
  });

  it("anchors step 1 on the due date, or now when that has passed", async () => {
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    store.due = [target("p-soon", { dueAt: future, overdueDays: -10 }), target("p-late")];
    await run();

    const soon = store.created.find((c) => c.targetId === "site-1:p-soon:dentist");
    const late = store.created.find((c) => c.targetId === "site-1:p-late:dentist");
    // Due in ten days: reached ON the due date, not today.
    expect(soon?.nextDueAt).toBe(future);
    // Already overdue: reached now, never back-dated into the past.
    expect(new Date(late?.nextDueAt ?? 0).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("never enrols more than the per-run ceiling in one sweep", async () => {
    store.due = Array.from({ length: 200 }, (_, i) => target(`p-${i}`));
    // A generous daily cap, so only the per-run ceiling can be doing the work.
    vi.stubEnv("RECALL_DAILY_CONTACT_LIMIT", "500");
    const out = await run();

    expect(out.perSite[0].enrolled).toBe(MAX_ENROLMENTS_PER_RUN);
    expect(store.created).toHaveLength(MAX_ENROLMENTS_PER_RUN);
  });

  it("stops at what is left of the day's contact cap", async () => {
    store.due = Array.from({ length: 50 }, (_, i) => target(`p-${i}`));
    vi.stubEnv("RECALL_DAILY_CONTACT_LIMIT", "10");
    store.usedToday = 7;
    const out = await run();

    expect(out.enrolBudget).toBe(3);
    expect(out.perSite[0].enrolled).toBe(3);
  });

  it("counts the cadences already waiting to send against the budget", async () => {
    store.due = Array.from({ length: 50 }, (_, i) => target(`p-${i}`));
    vi.stubEnv("RECALL_DAILY_CONTACT_LIMIT", "10");
    store.usedToday = 2;
    store.dueCadences = Array.from({ length: 6 }, (_, i) => ({ id: `c-${i}` }));
    const out = await run();

    expect(out.perSite[0].enrolled).toBe(2);
  });

  it("enrols nobody while the owner has recall switched off", async () => {
    store.due = Array.from({ length: 10 }, (_, i) => target(`p-${i}`));
    store.systemEnabled = false;
    const out = await run();

    expect(out.enrolBudget).toBe(0);
    expect(out.perSite[0].enrolled).toBe(0);
    expect(store.created).toHaveLength(0);
  });

  it("never enrols a patient the sweep would refuse to message", async () => {
    store.due = [
      target("p-nosms", { consent: { sms: false, email: true, marketing: false } }),
      target("p-excluded"),
      target("p-enrolled"),
      target("p-ok"),
    ];
    store.excluded = new Set(["site-1:p-excluded"]);
    store.cadences = [{ targetId: "site-1:p-enrolled:dentist" }];
    const out = await run();

    expect(out.perSite[0].enrolled).toBe(1);
    expect(store.created.map((c) => c.targetId)).toEqual(["site-1:p-ok:dentist"]);
  });

  it("does not enrol a target it has just handed to reactivation", async () => {
    // Past the 60 day grace boundary: the reconcile pass graduates it, and a
    // graduated recall must never then be started on a cadence.
    const longOverdue = new Date(Date.now() - 400 * 86_400_000).toISOString();
    store.due = [target("p-graduating", { dueAt: longOverdue, overdueDays: 400 })];
    const out = await run();

    expect(store.graduated).toEqual(["site-1:p-graduating:dentist"]);
    expect(out.perSite[0].enrolled).toBe(0);
    expect(store.created).toHaveLength(0);
  });
});
