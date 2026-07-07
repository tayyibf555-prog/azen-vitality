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
  listInvoices: (_a: unknown): Promise<unknown> => Promise.resolve({ invoices: [] }),
}));

vi.mock("./client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listPatients(a: unknown) { return state.listPatients(a); }
    listAppointments(a: unknown) { return state.listAppointments(a); }
    listTreatmentPlans(a: unknown) { return state.listTreatmentPlans(a); }
    listInvoices(a: unknown) { return state.listInvoices(a); }
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

// listOutstanding scans the INVOICES index ONCE (real Dentally holds the balance on
// invoices, not plans, and may ignore site_id and repeat the whole group per site),
// reads the balance from `amount_outstanding`, aggregates per patient, attributes by the
// patient's site, and drops other-practice patients. Uses the REAL Dentally invoice shape
// (amount / amount_outstanding / boolean paid / status) so it guards the live path — the
// earlier mock shape (numeric total/paid) hid a bug that returned 0 for every real invoice.
describe("listOutstanding", () => {
  // amountOutstanding is Dentally's `amount_outstanding`; `paid` is a BOOLEAN live.
  const inv = (id: string, patientId: string, amount: number, amountOutstanding: number, extra: Record<string, unknown> = {}) => ({
    id, patient_id: patientId, amount, amount_outstanding: amountOutstanding, paid: amountOutstanding === 0, status: "new", ...extra,
  });
  const patient = (id: string, site: string) => ({ id, first_name: "P", last_name: id, site_id: site });

  it("collects outstanding invoices from ALL sites even when a middle site is empty", async () => {
    const bySite: Record<string, unknown[]> = {
      "site-1": [inv("a", "pat-1", 500, 400)], // 400 owed
      "site-2": [], // legitimately empty — must NOT abort the scan
      "site-3": [inv("c", "pat-3", 300, 300)], // 300 owed
    };
    state.listInvoices = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({ invoices: (a.page ?? 1) === 1 ? bySite[a.siteId ?? ""] ?? [] : [] })) as never;
    const patBySite: Record<string, unknown[]> = {
      "site-1": [patient("pat-1", "site-1")],
      "site-2": [],
      "site-3": [patient("pat-3", "site-3")],
    };
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({ patients: (a.page ?? 1) === 1 ? patBySite[a.siteId ?? ""] ?? [] : [] })) as never;

    const out = await listOutstanding(["site-1", "site-2", "site-3"]);
    expect(out.map((o) => o.patientId).sort()).toEqual(["pat-1", "pat-3"]); // site-3 NOT skipped
    expect(out.find((o) => o.patientId === "pat-1")?.outstanding).toBe(400);
  });

  it("aggregates several unpaid invoices per patient and ranks by amount owed", async () => {
    const group = [
      inv("x1", "pat-a", 1000, 1000), // 1000
      inv("x2", "pat-a", 500, 300), // 300 -> pat-a owes 1300
      inv("y1", "pat-b", 800, 800), // 800
    ];
    state.listInvoices = ((a: { page?: number }) =>
      Promise.resolve({ invoices: (a.page ?? 1) === 1 ? group : [] })) as never;
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({
        patients:
          a.siteId === "site-1" && (a.page ?? 1) === 1
            ? [patient("pat-a", "site-1"), patient("pat-b", "site-1")]
            : [],
      })) as never;

    const out = await listOutstanding(["site-1"]);
    expect(out.map((o) => [o.patientId, o.outstanding])).toEqual([["pat-a", 1300], ["pat-b", 800]]);
    expect(out[0].planName).toBe("2 outstanding invoices");
  });

  it("handles the live shape: boolean `paid` with no explicit balance falls back to gross", async () => {
    // Guards the review-caught bug: real Dentally `paid` is a BOOLEAN, not a number. An
    // unpaid invoice with no amount_outstanding must owe its gross, a paid one must owe 0.
    state.listInvoices = ((a: { page?: number }) =>
      Promise.resolve({
        invoices:
          (a.page ?? 1) === 1
            ? [
                { id: "f1", patient_id: "pat-1", amount: 700, paid: false, status: "new" }, // owes 700
                { id: "f2", patient_id: "pat-2", amount: 400, paid: true, status: "paid" }, // owes 0
              ]
            : [],
      })) as never;
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({
        patients:
          a.siteId === "site-1" && (a.page ?? 1) === 1
            ? [patient("pat-1", "site-1"), patient("pat-2", "site-1")]
            : [],
      })) as never;

    const out = await listOutstanding(["site-1"]);
    expect(out.map((o) => [o.patientId, o.outstanding])).toEqual([["pat-1", 700]]);
  });

  it("dedups the ignored-filter repeat, drops other-practice patients, and stops early", async () => {
    // Every site returns the SAME group-wide list (real Dentally ignoring site_id).
    const group = [inv("x", "pat-vit", 300, 300), inv("y", "pat-other", 400, 400)];
    const calls: string[] = [];
    state.listInvoices = ((a: { siteId?: string; page?: number }) => {
      calls.push(`${a.siteId}:${a.page ?? 1}`);
      return Promise.resolve({ invoices: (a.page ?? 1) === 1 ? group : [] });
    }) as never;
    // /v1/patients IS filtered server-side: only the Vitality patient comes back.
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({ patients: a.siteId === "site-1" && (a.page ?? 1) === 1 ? [patient("pat-vit", "site-1")] : [] })) as never;

    const out = await listOutstanding(["site-1", "site-2", "site-3"]);
    expect(out.map((o) => o.patientId)).toEqual(["pat-vit"]); // pat-other dropped (not in allowlist)
    expect(calls.some((c) => c.startsWith("site-3"))).toBe(false); // early-stopped after site-2
  });

  it("ignores settled, draft, cancelled and written-off invoices and skips the patient scan when nothing is owed", async () => {
    state.listInvoices = ((a: { page?: number }) =>
      Promise.resolve({
        invoices:
          (a.page ?? 1) === 1
            ? [
                inv("s", "pat-1", 500, 0), // settled (amount_outstanding 0, paid true)
                inv("d", "pat-2", 900, 900, { status: "draft" }),
                inv("c", "pat-3", 900, 900, { status: "cancelled" }),
                inv("w", "pat-4", 900, 900, { status: "written_off" }),
              ]
            : [],
      })) as never;
    const spy = vi.fn(() => Promise.resolve({ patients: [] }));
    state.listPatients = spy as never;

    const out = await listOutstanding(["site-1", "site-2", "site-3"]);
    expect(out).toEqual([]);
    expect(spy).not.toHaveBeenCalled(); // patient scan skipped on the no-outstanding path
  });
});
