// GO-LIVE regression (finding #7): read.ts must PAGE every Dentally list endpoint, not
// stop at the first 100 rows. A real-size practice has well over 100 patients /
// appointments; a single unpaged call silently truncates and the reviews module 404s
// and the co-pilot diary omits most of the day. The DentallyClient is mocked with a
// pager so no network is touched.
import { describe, it, expect, vi, beforeEach } from "vitest";

const PER_PAGE = 100;

// A pager: returns PER_PAGE rows per page until `total` is exhausted, then a short page.
function makePager(total: number, key: "patients" | "appointments" | "treatment_plans") {
  const pagesSeen: number[] = [];
  const fn = (a: { page?: number }) => {
    const page = a.page ?? 1;
    pagesSeen.push(page);
    const start = (page - 1) * PER_PAGE;
    const end = Math.min(start + PER_PAGE, total);
    const rows = [];
    for (let i = start; i < end; i += 1) {
      rows.push({ id: `${key}-${i}`, patient_id: `pat-${i}`, site_id: "site-1", start_time: "2026-07-10T09:00:00Z", first_name: "A", last_name: `B${i}` });
    }
    return Promise.resolve({ [key]: rows });
  };
  return { fn, pagesSeen };
}

const state = vi.hoisted(() => ({
  listPatients: (_a: unknown): Promise<unknown> => Promise.resolve({ patients: [] }),
  listAppointments: (_a: unknown): Promise<unknown> => Promise.resolve({ appointments: [] }),
  listTreatmentPlans: (_a: unknown): Promise<unknown> => Promise.resolve({ treatment_plans: [] }),
}));

vi.mock("./client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listPatients(a: unknown) { return state.listPatients(a); }
    listAppointments(a: unknown) { return state.listAppointments(a); }
    listTreatmentPlans(a: unknown) { return state.listTreatmentPlans(a); }
  },
}));

import { listPatients, listAppointments, listOutstanding, dentallyReadKey } from "./read";

beforeEach(() => {
  vi.stubEnv("DENTALLY_API_KEY", "k");
});

describe("read.ts pagination (finding #7)", () => {
  it("pages listPatients past the first 100 rows (250 across 3 pages)", async () => {
    const pager = makePager(250, "patients");
    state.listPatients = pager.fn as never;
    const out = await listPatients(["site-1"]);
    expect(out).toHaveLength(250); // NOT truncated at 100
    expect(pager.pagesSeen).toEqual([1, 2, 3]); // looped until a short page
  });

  it("pages listAppointments past the first 100 rows (180 across 2 pages)", async () => {
    const pager = makePager(180, "appointments");
    state.listAppointments = pager.fn as never;
    const out = await listAppointments(["site-1"]);
    expect(out).toHaveLength(180);
    expect(pager.pagesSeen).toEqual([1, 2]);
  });

  it("stops after one page when the first page is already short (mock-size practice)", async () => {
    const pager = makePager(20, "patients");
    state.listPatients = pager.fn as never;
    const out = await listPatients(["site-1"]);
    expect(out).toHaveLength(20);
    expect(pager.pagesSeen).toEqual([1]); // no needless second page
  });
});

describe("dentallyReadKey (read-only key selection)", () => {
  it("prefers the dedicated read-only key when set", () => {
    vi.stubEnv("DENTALLY_API_KEY", "write-key");
    vi.stubEnv("DENTALLY_PROD_READONLY_API_KEY", "readonly-key");
    expect(dentallyReadKey()).toBe("readonly-key");
  });

  it("falls back to DENTALLY_API_KEY when the read-only key is unset", () => {
    vi.stubEnv("DENTALLY_API_KEY", "write-key");
    vi.stubEnv("DENTALLY_PROD_READONLY_API_KEY", "");
    expect(dentallyReadKey()).toBe("write-key");
  });

  it("returns empty string when neither is set (callers 503)", () => {
    vi.stubEnv("DENTALLY_API_KEY", "");
    vi.stubEnv("DENTALLY_PROD_READONLY_API_KEY", "");
    expect(dentallyReadKey()).toBe("");
  });
});

// listOutstanding scans treatment_plans ONCE (real Dentally ignores site_id and
// repeats the whole group per site), attributes each plan by its PATIENT's site
// (plans carry no site_id), and drops other-practice patients. Regression cover for
// the review-caught bug where an empty middle site aborted the whole scan.
describe("listOutstanding", () => {
  const plan = (id: string, patientId: string, outstanding: number | undefined, value = 500) => ({
    id,
    patient_id: patientId,
    nickname: `Plan ${id}`,
    private_treatment_value: String(value),
    start_date: "2026-01-01",
    ...(outstanding !== undefined ? { amount_outstanding: outstanding } : {}),
  });
  const patient = (id: string, site: string) => ({ id, first_name: "P", last_name: id, site_id: site });

  it("collects outstanding plans from ALL sites even when a middle site is empty", async () => {
    const bySite: Record<string, unknown[]> = {
      "site-1": [plan("a", "pat-1", 100)],
      "site-2": [], // legitimately empty — must NOT abort the scan
      "site-3": [plan("c", "pat-3", 200)],
    };
    state.listTreatmentPlans = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({ treatment_plans: (a.page ?? 1) === 1 ? bySite[a.siteId ?? ""] ?? [] : [] })) as never;
    const patBySite: Record<string, unknown[]> = {
      "site-1": [patient("pat-1", "site-1")],
      "site-2": [],
      "site-3": [patient("pat-3", "site-3")],
    };
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({ patients: (a.page ?? 1) === 1 ? patBySite[a.siteId ?? ""] ?? [] : [] })) as never;

    const out = await listOutstanding(["site-1", "site-2", "site-3"]);
    expect(out.map((o) => o.patientId).sort()).toEqual(["pat-1", "pat-3"]); // site-3 NOT skipped
  });

  it("dedups the ignored-filter repeat, drops other-practice plans, and stops early", async () => {
    // Every site returns the SAME group-wide list (real Dentally ignoring site_id).
    const group = [plan("x", "pat-vit", 300), plan("y", "pat-other", 400)];
    const calls: string[] = [];
    state.listTreatmentPlans = ((a: { siteId?: string; page?: number }) => {
      calls.push(`${a.siteId}:${a.page ?? 1}`);
      return Promise.resolve({ treatment_plans: (a.page ?? 1) === 1 ? group : [] });
    }) as never;
    // /v1/patients IS filtered server-side: only the Vitality patient comes back.
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({ patients: a.siteId === "site-1" && (a.page ?? 1) === 1 ? [patient("pat-vit", "site-1")] : [] })) as never;

    const out = await listOutstanding(["site-1", "site-2", "site-3"]);
    expect(out.map((o) => o.patientId)).toEqual(["pat-vit"]); // pat-other dropped (not in allowlist)
    expect(calls.some((c) => c.startsWith("site-3"))).toBe(false); // early-stopped after site-2
  });

  it("returns [] without scanning patients when nothing is outstanding (live data)", async () => {
    state.listTreatmentPlans = ((a: { page?: number }) =>
      Promise.resolve({ treatment_plans: (a.page ?? 1) === 1 ? [plan("a", "pat-1", undefined)] : [] })) as never;
    const spy = vi.fn(() => Promise.resolve({ patients: [] }));
    state.listPatients = spy as never;

    const out = await listOutstanding(["site-1", "site-2", "site-3"]);
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled(); // patient scan skipped on the no-outstanding path
  });
});
