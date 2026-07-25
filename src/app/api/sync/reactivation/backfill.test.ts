// Reactivation one-time historical backfill: Dentally's /v1/patients has no sort, so
// the updated_after high-water-mark strands older-updated patients on a from-scratch
// pass. Backfill pages EVERY patient by page NUMBER (cursor in the sync_state row's
// backfill_page/backfill_done columns) until a short page, then switches to
// updated_after incremental. This pins the state machine: start -> resume -> complete
// -> incremental, plus the two review-caught failure guards.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CAP = 300; // MAX_PATIENTS_PER_RUN
const PER_PAGE = 100;

const store = vi.hoisted(() => ({
  cursor: { page: null as number | null, done: false },
  mainHwm: null as string | null,
  backfillSets: [] as Array<{ page: number | null; done: boolean; highWaterMark?: string }>,
  mainSets: [] as string[],
  patientTotal: 0,
  listCalls: [] as Array<{ page: number; updatedAfter: string | undefined }>,
  failPatientId: null as string | null,
}));

const dent = vi.hoisted(() => ({
  listTreatmentPlans: vi.fn(async (_a?: unknown) => ({ treatment_plans: [] as unknown[] })),
  listPatients: vi.fn(async (a: { page?: number; updatedAfter?: string }) => {
    const page = a?.page ?? 1;
    store.listCalls.push({ page, updatedAfter: a?.updatedAfter });
    const start = (page - 1) * PER_PAGE;
    const end = Math.min(start + PER_PAGE, store.patientTotal);
    const patients = [];
    for (let i = start; i < end; i++) patients.push({ id: `pat-${i}`, first_name: "A", last_name: `B${i}`, updated_at: "2026-07-06T00:00:00Z" });
    return { patients };
  }),
  getPatientAppointments: vi.fn(async (id: string) => {
    if (id === store.failPatientId) throw new Error("appointments 500");
    return { appointments: [] as unknown[] };
  }),
  getPatientInvoices: vi.fn(async () => ({ invoices: [] as unknown[] })),
}));

const repo = vi.hoisted(() => ({
  upsertTargets: vi.fn(async () => {}),
  listTargets: vi.fn(async () => [] as unknown[]),
  getCadenceByTarget: vi.fn(async () => null),
  updateCadence: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
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

vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: vi.fn(async () => true), releaseCronLock: vi.fn(async () => {}) }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listTreatmentPlans(a: unknown) { return dent.listTreatmentPlans(a as never); }
    listPatients(a: unknown) { return dent.listPatients(a as { page?: number; updatedAfter?: string }); }
    getPatientAppointments(id: unknown) { return dent.getPatientAppointments(id as string); }
    getPatientInvoices() { return dent.getPatientInvoices(); }
  },
}));
vi.mock("@/lib/reactivation/repository", () => ({
  upsertTargets: () => repo.upsertTargets(),
  listTargets: () => repo.listTargets(),
  getCadenceByTarget: () => repo.getCadenceByTarget(),
  updateCadence: () => repo.updateCadence(),
  setTargetStatus: () => repo.setTargetStatus(),
  getSyncState: (s: string, r: string) => repo.getSyncState(),
  setSyncState: (s: string, r: string, v: string) => repo.setSyncState(s, r, v),
  getBackfillCursor: (s: string, r: string) => repo.getBackfillCursor(),
  setBackfillCursor: (s: string, r: string, o: { page: number | null; done: boolean; highWaterMark?: string }) => repo.setBackfillCursor(s, r, o),
  // Auto-enrolment reads. listTargets returns nothing here, so nothing is enrolled.
  createCadence: async () => ({ id: "cad-new" }),
  listCadences: async () => [],
  listDueCadences: async () => [],
}));
vi.mock("@/lib/reactivation/settings", () => ({
  getDailyContactLimit: async () => 25,
  countContactedToday: async () => 0,
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => true }));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: async () => new Set<string>(),
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}:${patientId}`,
}));
vi.mock("@/lib/recall/repository", () => ({ listOpenRecallPatientKeys: async () => new Set<string>() }));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

function req(): Request {
  return new Request("http://localhost/api/sync/reactivation", { method: "POST", headers: { authorization: "Bearer bf-secret" } });
}
async function run() {
  const res = await POST(req());
  const body = (await res.json()) as { perSite: Array<{ mode: string; backfillPage: number | null; processed: number }> };
  return body.perSite[0];
}

beforeEach(() => {
  store.cursor = { page: null, done: false };
  store.mainHwm = null;
  store.backfillSets = [];
  store.mainSets = [];
  store.listCalls = [];
  store.patientTotal = 0;
  store.failPatientId = null;
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "bf-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
});
afterEach(() => vi.unstubAllEnvs());

describe("reactivation historical backfill (page cursor)", () => {
  it("first run pages EVERY patient (no updated_after) and stores the page cursor", async () => {
    store.patientTotal = 350; // more than the 300 cap -> stops at a page boundary
    const site = await run();

    expect(site.mode).toBe("backfill");
    expect(site.processed).toBe(CAP); // 3 whole pages
    expect(site.backfillPage).toBe(3);
    expect(store.backfillSets).toContainEqual({ page: 3, done: false });
    expect(store.mainSets).toHaveLength(0); // incremental mark NOT seeded mid-backfill
    // Backfill pages ignore updated_after (they must see ALL patients).
    expect(store.listCalls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(store.listCalls.every((c) => c.updatedAfter === undefined)).toBe(true);
  });

  it("resumes from the cursor and completes on a short page, seeding the incremental mark atomically", async () => {
    store.cursor = { page: 3, done: false };
    store.patientTotal = 350;
    const site = await run();

    expect(site.mode).toBe("backfill-done");
    expect(store.listCalls[0].page).toBe(4); // resumed AFTER the cursor page
    // Single atomic write sets done=true AND seeds the incremental mark (ISO timestamp).
    const doneWrite = store.backfillSets.find((s) => s.done);
    expect(doneWrite).toBeTruthy();
    expect(Number.isNaN(Date.parse(doneWrite!.highWaterMark ?? ""))).toBe(false);
  });

  it("after backfill is done, runs incrementally with updated_after", async () => {
    store.cursor = { page: 4, done: true };
    store.mainHwm = "2026-07-06T12:00:00Z";
    store.patientTotal = 2; // short first page -> ends immediately
    const site = await run();

    expect(site.mode).toBe("incremental");
    expect(site.backfillPage).toBeNull();
    expect(store.listCalls[0].updatedAfter).toBe("2026-07-06T12:00:00Z");
  });

  it("does NOT advance the cursor past a page with a failed patient read (no silent skip)", async () => {
    store.patientTotal = 350;
    store.failPatientId = "pat-150"; // on page 2 (indices 100-199)
    const site = await run();

    expect(site.mode).toBe("backfill");
    // Page 2 failed -> cursor rewinds to just before it (page 1), so the failed
    // patient's page is re-paged next run rather than skipped forever.
    expect(site.backfillPage).toBe(1);
    expect(store.backfillSets).toContainEqual({ page: 1, done: false });
  });

  it("does NOT mark backfill done if the final page had a failed patient", async () => {
    store.cursor = { page: 3, done: false };
    store.patientTotal = 350;
    store.failPatientId = "pat-320"; // on the final short page 4 (300-349)
    const site = await run();

    expect(site.mode).toBe("backfill"); // NOT backfill-done
    expect(store.backfillSets.some((s) => s.done)).toBe(false);
    expect(store.mainSets).toHaveLength(0); // incremental mark NOT seeded while a patient is unclassified
    expect(store.backfillSets).toContainEqual({ page: 3, done: false });
  });
});
