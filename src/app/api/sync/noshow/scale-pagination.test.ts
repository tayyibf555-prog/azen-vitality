// LOAD/SCALE: the no-show sync must page the appointment window, not pull it in
// one unpaged call. The real Dentally API caps a page, so a single call would
// silently drop a busy practice's later appointments (never defended). It must
// also stop paging once MAX_APPOINTMENTS_PER_RUN (300) is reached, so a huge day
// cannot burn the 300s function limit. The client, repository, lock and site
// list are mocked; no network or database is touched.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PER_PAGE = 100;
const CAP = 300; // MAX_APPOINTMENTS_PER_RUN in the route

// A page-serving fake for listAppointments: returns PER_PAGE rows per page until
// `total` is exhausted, then a short final page. Records how many pages were
// requested so the test can assert the loop terminates (bounded), not runs away.
function makeApptPager(total: number) {
  const pagesRequested: number[] = [];
  const listAppointments = vi.fn(async (...args: unknown[]) => {
      const a = (args[0] ?? {}) as {
        siteId: string;
        fromDate?: string;
        toDate?: string;
        page?: number;
        perPage?: number;
      };
      const page = a.page ?? 1;
      pagesRequested.push(page);
      const start = (page - 1) * PER_PAGE;
      const end = Math.min(start + PER_PAGE, total);
      const appointments: unknown[] = [];
      for (let i = start; i < end; i++) {
        appointments.push({
          id: `appt-${i}`,
          patient_id: `pat-${i}`,
          // A day inside the default 14-day lead window, in the future.
          start_time: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          state: "booked",
          duration: 30,
        });
      }
      return { appointments };
    },
  );
  return { listAppointments, pagesRequested };
}

// Serves pat-0..pat-(total-1) with consent across pages, so the sync's per-site
// consent map (built once from paged listPatients, replacing getPatient-per-row)
// covers every appointment's patient.
function patientPagerImpl(total: number) {
  return async (...args: unknown[]) => {
    const a = (args[0] ?? {}) as { page?: number; perPage?: number };
    const page = a.page ?? 1;
    const start = (page - 1) * PER_PAGE;
    const end = Math.min(start + PER_PAGE, total);
    const patients: unknown[] = [];
    for (let i = start; i < end; i++) {
      patients.push({ id: `pat-${i}`, first_name: "A", last_name: "B", use_sms: true, use_email: true });
    }
    return { patients };
  };
}

const fakes = vi.hoisted(() => ({
  acquireCronLock: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  releaseCronLock: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  listAppointments: vi.fn<(...a: unknown[]) => Promise<{ appointments: unknown[] }>>(),
  listPatients: vi.fn<(...a: unknown[]) => Promise<{ patients: unknown[] }>>(async () => ({ patients: [] })),
  getPatientAppointments: vi.fn<(...a: unknown[]) => Promise<{ appointments: unknown[] }>>(async () => ({
    appointments: [],
  })),
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: (...a: unknown[]) => fakes.acquireCronLock(...a),
  releaseCronLock: (...a: unknown[]) => fakes.releaseCronLock(...a),
}));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient {
    constructor(_opts: unknown) {}
    listAppointments(a: unknown) {
      return fakes.listAppointments(a);
    }
    listPatients(a: unknown) {
      return fakes.listPatients(a);
    }
    getPatientAppointments(id: unknown) {
      return fakes.getPatientAppointments(id);
    }
  },
}));
vi.mock("@/lib/noshow/repository", () => ({
  upsertTargets: vi.fn(async () => {}),
  listTargets: vi.fn(async () => []),
  getCadenceByTarget: vi.fn(async () => null),
  getCadencesByTargets: vi.fn(async () => new Map()),
  createCadence: vi.fn(async () => {}),
  setTargetStatus: vi.fn(async () => {}),
  getSyncState: vi.fn(async () => null),
  setSyncState: vi.fn(async () => {}),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

function syncRequest(auth = "Bearer scale-test-secret"): Request {
  return new Request("http://localhost/api/sync/noshow", {
    method: "POST",
    headers: { authorization: auth },
  });
}

beforeEach(() => {
  fakes.acquireCronLock.mockClear();
  fakes.releaseCronLock.mockClear();
  fakes.listAppointments.mockReset();
  // Consent map covers every appointment's patient (pat-0..pat-999 across the tests).
  fakes.listPatients.mockReset();
  fakes.listPatients.mockImplementation(patientPagerImpl(1000));
  fakes.getPatientAppointments.mockClear();
  vi.stubEnv("CRON_SECRET", "scale-test-secret");
  vi.stubEnv("DENTALLY_API_KEY", "scale-test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("no-show sync appointment pagination (load/scale)", () => {
  it("pages beyond the first page instead of dropping later appointments", async () => {
    // 250 appointments across 3 pages (100 + 100 + 50). A single unpaged call
    // would only ever see the first 100.
    const pager = makeApptPager(250);
    fakes.listAppointments.mockImplementation(pager.listAppointments);

    const res = await POST(syncRequest());
    const body = (await res.json()) as { ok: boolean; perSite: Array<{ pulled?: number; processed?: number }> };

    expect(body.ok).toBe(true);
    // Must have requested more than one page (proves it does not stop at page 1).
    expect(pager.pagesRequested).toEqual([1, 2, 3]);
    // All 250 rows pulled and processed (under the 300 cap).
    expect(body.perSite[0].pulled).toBe(250);
    expect(body.perSite[0].processed).toBe(250);
  });

  it("stops paging at the per-run cap on a huge backlog (bounded, not unbounded)", async () => {
    // 1,000 appointments would be 10 full pages if paged to exhaustion. The cap
    // (300) is reached partway through page 4 (rows 300..349 of that page are
    // over the cap), so the loop must break at page 4 and NOT fetch pages 5-10.
    const pager = makeApptPager(1000);
    fakes.listAppointments.mockImplementation(pager.listAppointments);

    const res = await POST(syncRequest());
    const body = (await res.json()) as {
      ok: boolean;
      perSite: Array<{ processed?: number; remaining?: number }>;
    };

    expect(body.ok).toBe(true);
    // Processing is capped at MAX_APPOINTMENTS_PER_RUN: a huge backlog cannot do
    // unbounded per-row work (getPatient + getPatientAppointments) in one run.
    expect(body.perSite[0].processed).toBe(CAP);
    // Crucially: it did NOT page the whole 10-page backlog. The cap is reached by
    // the end of page 3, so at most 4 pages are ever fetched (bounded per run) —
    // NOT all 10. This is the load-safety property under test.
    expect(pager.pagesRequested.length).toBeLessThanOrEqual(4);
    expect(Math.max(...pager.pagesRequested)).toBeLessThanOrEqual(4);
  });

  it("terminates on an exact-page-boundary backlog without fetching extra pages", async () => {
    // Exactly 300 rows = 3 full pages and the cap lands on the page boundary.
    // The loop must break after page 3 (cap reached) and never fetch page 4.
    const pager = makeApptPager(300);
    fakes.listAppointments.mockImplementation(pager.listAppointments);

    const res = await POST(syncRequest());
    const body = (await res.json()) as {
      ok: boolean;
      perSite: Array<{ processed?: number }>;
    };

    expect(body.ok).toBe(true);
    expect(body.perSite[0].processed).toBe(CAP);
    expect(Math.max(...pager.pagesRequested)).toBe(3);
  });

  it("terminates on a misbehaving API that returns full pages of unmappable rows", async () => {
    // A hostile/broken upstream that always returns a full page (never a short
    // final page) of rows that cannot be mapped (no id/patient_id/start). Without
    // a hard page-count guard the loop would page forever (processed never rises
    // to the cap). It must still terminate in a bounded number of pages.
    let pagesRequested = 0;
    fakes.listAppointments.mockImplementation(async () => {
      pagesRequested++;
      // Always a full page of junk (missing required fields -> mapAppointment null).
      return { appointments: Array.from({ length: PER_PAGE }, () => ({ junk: true })) };
    });

    const res = await POST(syncRequest());
    const body = (await res.json()) as { ok: boolean; perSite: Array<{ processed?: number }> };

    expect(body.ok).toBe(true);
    expect(body.perSite[0].processed).toBe(0); // nothing mappable
    // Bounded: guard is ceil(300/100)+2 = 5 pages.
    expect(pagesRequested).toBeLessThanOrEqual(5);
  });
});
