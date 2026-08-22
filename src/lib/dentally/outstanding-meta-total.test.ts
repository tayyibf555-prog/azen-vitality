// ---------------------------------------------------------------------------
// F1 — THE MONEY WALK THE CONSOLIDATION MISSED.
//
// Every scan behind the dashboard was migrated onto `pageAll` and measured against
// Dentally's own `meta.total`. The debtors scan — the one that produces the number
// on the Payments page, and the snapshot the collection sweep verifies against —
// was not. It hand-walked /v1/invoices?paid=false and called any short page the end
// of the book, on an index that /v1/invoices provably publishes a count for.
//
// A short page is not evidence. It is what a walk looks like when it finished AND
// what it looks like when the server handed back fewer rows than it said matched,
// and the difference between those two is the difference between "the practice is
// owed £41,900" and "the practice is owed at least £41,900". `truncated` already
// existed for exactly this — the Payments page presents a truncated total as a floor
// — and the walk simply never set it on this path.
//
// The check is bolted onto the existing loop: the dedup, the site-scoped requests
// and the ignored-filter early stop are untouched, because each of them is load
// bearing for a different live defect.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

interface ClientStubs {
  listPatients: (arg: unknown) => Promise<unknown>;
  listInvoices: (arg: unknown) => Promise<unknown>;
  getPatient: (id: unknown) => Promise<unknown>;
}

const state = vi.hoisted<ClientStubs>(() => ({
  listPatients: () => Promise.resolve({ patients: [] }),
  listInvoices: () => Promise.resolve({ invoices: [] }),
  getPatient: () => Promise.resolve({ patient: null }),
}));

// PARTIAL mock, like read.test.ts: the budget-refusal branch in read.ts is an
// `instanceof` against the REAL error class, and a class replaced by a mock is a
// different class.
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  DentallyClient: class {
    constructor() {}
    listPatients(a: unknown) {
      return state.listPatients(a);
    }
    listInvoices(a: unknown) {
      return state.listInvoices(a);
    }
    getPatient(id: unknown) {
      return state.getPatient(id);
    }
  },
}));

import { listOutstandingDetailed } from "./read";

const unpaid = (id: string, patientId: string, owed: number) => ({
  id,
  patient_id: patientId,
  amount: owed,
  amount_outstanding: owed,
  paid: false,
  status: "new",
});

const patient = (id: string, site: string) => ({
  id,
  first_name: "P",
  last_name: id,
  site_id: site,
});

/** Every warning this scan emitted, reset per test. A spy re-installed by spyOn on an
 *  already-spied method keeps its old calls, which would leak one test's warning into
 *  the next and make the last assertion below pass or fail for the wrong reason. */
let warnings: string[] = [];

beforeEach(() => {
  vi.stubEnv("DENTALLY_API_KEY", "k");
  vi.stubEnv("DENTALLY_BASE_URL", "http://dentally.invalid");
  state.listPatients = () => Promise.resolve({ patients: [] });
  state.listInvoices = () => Promise.resolve({ invoices: [] });
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(String(args[0]));
  });
});

/** One site, one page of rows, and whatever `meta` the source chooses to publish. */
function oneSite(rows: unknown[], meta: unknown) {
  state.listInvoices = ((a: { page?: number }) =>
    Promise.resolve(
      (a.page ?? 1) === 1 ? { invoices: rows, meta } : { invoices: [], meta },
    )) as never;
  state.listPatients = ((a: { siteId?: string; page?: number }) =>
    Promise.resolve({
      patients: (a.page ?? 1) === 1 ? [patient("pat-1", "site-1"), patient("pat-2", "site-1")] : [],
    })) as never;
}

describe("F1: the debtors scan measures its walk against meta.total", () => {
  it("reports TRUNCATED when the walk ends on a short page holding fewer rows than Dentally says match", async () => {
    // Dentally states five unpaid invoices match; the page hands back two and is
    // short, so the old walk called itself finished and the Payments page printed
    // £30 as the practice's whole unpaid book.
    oneSite([unpaid("a", "pat-1", 1000), unpaid("b", "pat-2", 2000)], {
      total: 5,
      current_page: 1,
    });

    const out = await listOutstandingDetailed(["site-1"]);

    expect(
      out.truncated,
      "a walk that fell short of Dentally's own count was reported as complete",
    ).toBe(true);
    // The rows it DID read are still handed back — the flag says the total is a
    // floor, it does not blank a panel that read something real.
    expect(out.rows.map((r) => r.patientId).sort()).toEqual(["pat-1", "pat-2"]);
  });

  it("CONTROL: a short page that reaches the published count is complete", async () => {
    oneSite([unpaid("a", "pat-1", 1000), unpaid("b", "pat-2", 2000)], {
      total: 2,
      current_page: 1,
    });

    const out = await listOutstandingDetailed(["site-1"]);
    expect(out.truncated).toBe(false);
    expect(out.rows).toHaveLength(2);
  });

  it("CONTROL: an envelope with no count falls back to the short-page stop, exactly as before", async () => {
    oneSite([unpaid("a", "pat-1", 1000)], undefined);

    const out = await listOutstandingDetailed(["site-1"]);
    expect(out.truncated).toBe(false);
    expect(out.rows).toHaveLength(1);
  });

  it("CONTROL: the ignored-site_id early stop is not mistaken for a truncation", async () => {
    // Real Dentally may ignore site_id and hand every site the whole group. The scan
    // detects that (a non-first site whose page adds nothing new) and stops — the
    // group is already covered. `meta.total` on that call describes the WHOLE index,
    // so comparing it against the one page this site fetched would manufacture a
    // truncation out of the workaround itself.
    const group = [unpaid("a", "pat-1", 1000), unpaid("b", "pat-2", 2000)];
    state.listInvoices = ((a: { page?: number }) =>
      Promise.resolve(
        (a.page ?? 1) === 1
          ? { invoices: group, meta: { total: 900, current_page: 1 } }
          : { invoices: [], meta: { total: 900, current_page: 2 } },
      )) as never;
    state.listPatients = ((a: { siteId?: string; page?: number }) =>
      Promise.resolve({
        patients:
          a.siteId === "site-1" && (a.page ?? 1) === 1
            ? [patient("pat-1", "site-1"), patient("pat-2", "site-1")]
            : [],
      })) as never;

    const out = await listOutstandingDetailed(["site-1", "site-2", "site-3"]);

    // Site 1's own walk DID fall short of 900 and says so; what this pins is that the
    // sites which early-stopped on the ignored-filter signature did not each add a
    // second, spurious warning about a total that was never theirs to reach.
    expect(out.rows.map((r) => r.patientId).sort()).toEqual(["pat-1", "pat-2"]);
    const warned = warnings.filter((m) => m.includes("ended on a short page"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("site-1");
  });
});
