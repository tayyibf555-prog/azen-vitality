// Reactivation one-time historical backfill: Dentally's /v1/patients has no sort, so
// the updated_after high-water-mark strands older-updated patients on a from-scratch
// pass. Backfill pages EVERY patient by page NUMBER (cursor in a dedicated sync_state
// row) until a short page, then switches to updated_after incremental. This pins the
// state machine: start -> resume from cursor -> complete -> incremental.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CAP = 300; // MAX_PATIENTS_PER_RUN
const PER_PAGE = 100;

const store = vi.hoisted(() => ({
  syncState: new Map<string, string>(), // resource -> highWaterMark
  setCalls: [] as Array<{ resource: string; value: string }>,
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
  getSyncState: (_s: string, resource: string) =>
    Promise.resolve(store.syncState.has(resource) ? { highWaterMark: store.syncState.get(resource)! } : null),
  setSyncState: (_s: string, resource: string, value: string) => {
    store.syncState.set(resource, value);
    store.setCalls.push({ resource, value });
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
  getSyncState: (s: string, r: string) => repo.getSyncState(s, r),
  setSyncState: (s: string, r: string, v: string) => repo.setSyncState(s, r, v),
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
  store.syncState = new Map();
  store.setCalls = [];
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
    // Cursor stored, main resource NOT stamped yet (backfill not finished).
    expect(store.setCalls).toContainEqual({ resource: "reactivation:backfill", value: "3" });
    expect(store.setCalls.some((c) => c.resource === "reactivation")).toBe(false);
    // Backfill pages ignore updated_after (they must see ALL patients).
    expect(store.listCalls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(store.listCalls.every((c) => c.updatedAfter === undefined)).toBe(true);
  });

  it("resumes from the cursor and completes on a short page, seeding the incremental mark", async () => {
    store.syncState.set("reactivation:backfill", "3");
    store.patientTotal = 350;
    const site = await run();

    expect(site.mode).toBe("backfill-done");
    expect(store.listCalls[0].page).toBe(4); // resumed AFTER the cursor page
    expect(site.processed).toBe(50); // remaining 50 on the short final page
    // Cursor marked done AND the incremental watermark seeded (an ISO timestamp).
    expect(store.setCalls).toContainEqual({ resource: "reactivation:backfill", value: "done" });
    const mainSet = store.setCalls.find((c) => c.resource === "reactivation");
    expect(mainSet).toBeTruthy();
    expect(Number.isNaN(Date.parse(mainSet!.value))).toBe(false);
  });

  it("does NOT advance the cursor past a page with a failed patient read (no silent skip)", async () => {
    store.patientTotal = 350;
    store.failPatientId = "pat-150"; // on page 2 (indices 100-199)
    const site = await run();

    expect(site.mode).toBe("backfill");
    // Page 2 had an enrichment failure -> cursor rewinds to just before it (page 1),
    // so the failed patient's page is re-paged next run rather than skipped forever.
    expect(site.backfillPage).toBe(1);
    expect(store.setCalls).toContainEqual({ resource: "reactivation:backfill", value: "1" });
  });

  it("does NOT mark backfill done if the final page had a failed patient", async () => {
    store.syncState.set("reactivation:backfill", "3");
    store.patientTotal = 350;
    store.failPatientId = "pat-320"; // on the final short page 4 (300-349)
    const site = await run();

    expect(site.mode).toBe("backfill"); // NOT backfill-done
    expect(store.setCalls.some((c) => c.resource === "reactivation:backfill" && c.value === "done")).toBe(false);
    // The main incremental mark must NOT be seeded while a patient is still unclassified.
    expect(store.setCalls.some((c) => c.resource === "reactivation")).toBe(false);
    expect(store.setCalls).toContainEqual({ resource: "reactivation:backfill", value: "3" });
  });

  it("after backfill is done, runs incrementally with updated_after", async () => {
    store.syncState.set("reactivation:backfill", "done");
    store.syncState.set("reactivation", "2026-07-06T12:00:00Z");
    store.patientTotal = 2; // short first page -> ends immediately
    const site = await run();

    expect(site.mode).toBe("incremental");
    expect(site.backfillPage).toBeNull();
    // Incremental passes the stored high-water mark as updated_after.
    expect(store.listCalls[0].updatedAfter).toBe("2026-07-06T12:00:00Z");
  });
});
