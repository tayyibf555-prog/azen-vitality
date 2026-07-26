// The no-show consent map decides which appointments get defended at all: a patient
// missing from it has their appointment SKIPPED, silently, with no log and no error.
//
// It used to be bounded at 200 pages of 100 = 20,000 patients. N15 really holds
// 27,565, so roughly 7,565 of that site's patients (27.4%) fell off the end of the
// map on EVERY run and their appointments went undefended, while the run still
// reported success. These tests pin the two properties that fix it: the map now
// covers a site far bigger than any of the practice's three, and every way it can
// come back short is COUNTED and LOGGED rather than passing for full coverage.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PER_PAGE = 100;

const store = vi.hoisted(() => ({
  /** How many patients the site's listPatients feed serves. */
  patientTotal: 0,
  /** meta.total the source reports, or null for a source with no total (the mock). */
  reportedTotal: null as number | null,
  /** Pages that should throw, simulating a rate limit part-way through the scan. */
  failPatientPages: new Set<number>(),
  patientPages: [] as number[],
  appointments: [] as unknown[],
  /** Force the site's run to blow up, to exercise the per-site failure contract. */
  listTargetsThrows: false,
}));

const dent = vi.hoisted(() => ({
  countPatients: vi.fn(async () => store.reportedTotal),
  listPatients: vi.fn(async (a: { page?: number }) => {
    const page = a?.page ?? 1;
    store.patientPages.push(page);
    if (store.failPatientPages.has(page)) throw new Error("Dentally 429: rate limit");
    const start = (page - 1) * PER_PAGE;
    const end = Math.min(start + PER_PAGE, store.patientTotal);
    const patients = [];
    for (let i = start; i < end; i++) {
      patients.push({ id: `pat-${i}`, first_name: "A", last_name: `B${i}`, use_sms: true, use_email: true });
    }
    return { patients };
  }),
  listAppointments: vi.fn(async (a: { page?: number }) => ({
    appointments: (a?.page ?? 1) === 1 ? store.appointments : [],
  })),
  getPatientAppointments: vi.fn(async () => ({ appointments: [] as unknown[] })),
}));

vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: vi.fn(async () => true), releaseCronLock: vi.fn(async () => {}) }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    countPatients(_id: unknown) { return dent.countPatients(); }
    listPatients(a: unknown) { return dent.listPatients(a as { page?: number }); }
    listAppointments(a: unknown) { return dent.listAppointments(a as { page?: number }); }
    getPatientAppointments(_id: unknown) { return dent.getPatientAppointments(); }
  },
}));
vi.mock("@/lib/noshow/repository", () => ({
  upsertTargets: vi.fn(async () => {}),
  listTargets: vi.fn(async () => {
    if (store.listTargetsThrows) throw new Error("supabase down");
    return [];
  }),
  getCadenceByTarget: vi.fn(async () => null),
  getCadencesByTargets: vi.fn(async () => new Map()),
  createCadence: vi.fn(async () => {}),
  updateCadence: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
  getSyncState: vi.fn(async () => null),
  setSyncState: vi.fn(async () => {}),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

interface SiteBody {
  siteId: string;
  consentMapped: number;
  consentExpected: number | null;
  consentIncomplete: boolean;
  consentMisses: number;
  upserted: number;
}

async function run() {
  const res = await POST(
    new Request("http://localhost/api/sync/noshow", { method: "POST", headers: { authorization: "Bearer ns-secret" } }),
  );
  const body = (await res.json()) as { ok: boolean; failedSites: string[]; perSite: SiteBody[] };
  return { status: res.status, body };
}

/** A live, in-window appointment for the given patient. */
function appt(i: number, patientId: string) {
  return {
    id: `appt-${i}`,
    patient_id: patientId,
    start_time: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    state: "booked",
    duration: 30,
  };
}

beforeEach(() => {
  store.patientTotal = 0;
  store.reportedTotal = null;
  store.failPatientPages = new Set();
  store.patientPages = [];
  store.appointments = [];
  store.listTargetsThrows = false;
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "ns-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("no-show consent map coverage", () => {
  it("covers a site far larger than the old 20,000-patient bound", async () => {
    // 25,000 patients = 250 pages, comfortably past the old 200-page (20,000) bound
    // that was silently dropping ~7,565 of N15's real patients every run.
    store.patientTotal = 25_000;
    store.reportedTotal = 25_000;
    // An appointment for a patient who used to fall off the end of the map.
    store.appointments = [appt(0, "pat-24999")];

    const { body } = await run();
    const site = body.perSite[0];

    expect(site.consentMapped).toBe(25_000);
    expect(site.consentIncomplete).toBe(false);
    expect(site.consentMisses).toBe(0);
    expect(site.upserted).toBe(1); // the late-page patient IS defended now
  });

  it("counts and logs the appointments it skips for an unmapped patient", async () => {
    store.patientTotal = 1;           // only pat-0 is known
    store.reportedTotal = 1;
    store.appointments = [appt(0, "pat-0"), appt(1, "pat-unknown"), appt(2, "pat-also-unknown")];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { body } = await run();
    const site = body.perSite[0];

    // The number skipped is visible, not implied by a missing row.
    expect(site.consentMisses).toBe(2);
    expect(site.upserted).toBe(1);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("UNDEFENDED");
  });

  it("flags the map as incomplete and shouts when a page read fails part-way", async () => {
    store.patientTotal = 1_000;
    store.reportedTotal = 1_000;
    store.failPatientPages = new Set([5]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const { body } = await run();
    const site = body.perSite[0];

    expect(site.consentIncomplete).toBe(true);
    expect(site.consentExpected).toBe(1_000);
    // A failed page is a HOLE, not the end of the book: only that page's 100
    // patients are lost, not the 500 that sit after it.
    expect(site.consentMapped).toBe(900);
    expect(errors).toHaveBeenCalled();
    expect(String(errors.mock.calls[0][0])).toContain("INCOMPLETE");
  });

  it("does not claim a shortfall when the source reports no total", async () => {
    // The local mock exposes no meta.total; a null must not be read as "0 expected"
    // nor as a coverage failure.
    store.patientTotal = 250;
    store.reportedTotal = null;

    const { body } = await run();
    const site = body.perSite[0];

    expect(site.consentExpected).toBeNull();
    expect(site.consentMapped).toBe(250);
    expect(site.consentIncomplete).toBe(false);
  });
});

describe("no-show run reports a failed site", () => {
  it("answers ok:false and names the site when one fails, instead of a green ok:true", async () => {
    store.patientTotal = 10;
    store.reportedTotal = 10;
    store.listTargetsThrows = true; // the site's run blows up part-way
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const { status, body } = await run();

    // Still HTTP 200 (pg_cron's trigger_app_cron fires http_get and never sees the
    // status), but unmistakably not ok. A site failing every tick used to leave the
    // cron history looking perfectly green.
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.failedSites).toEqual(["site-1"]);
    expect(String((body.perSite[0] as unknown as { error: string }).error)).toContain("supabase down");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("answers ok:true with an empty failedSites list on a clean run", async () => {
    store.patientTotal = 10;
    store.reportedTotal = 10;

    const { body } = await run();
    expect(body.ok).toBe(true);
    expect(body.failedSites).toEqual([]);
  });
});
