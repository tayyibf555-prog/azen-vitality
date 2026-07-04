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

import { listPatients, listAppointments, dentallyReadKey } from "./read";

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
