// ---------------------------------------------------------------------------
// F6 — THE UNPAGED READ SITTING THREE LINES UNDER A PAGED ONE.
//
// The per-patient enrichment reads two things from Dentally: appointments and
// invoices. The appointment read was paged, with the reason written above it — an
// unpaged call caps at ~100 rows, so a long-standing patient's FUTURE booking could
// sit past page one and be missed, and the sync would chase somebody who is already
// in the diary next week.
//
// The invoice read, three lines below it, was a single unpaged call feeding
// deriveHistoricSpend. Same endpoint family, same cap, same silence: no truncation
// signal of any kind. Historic spend becomes `recoverableValue` on the target, which
// is what ranks who gets chased and what they are worth chasing, so a patient of
// fifteen years was ranked on whichever ~100 invoices Dentally happened to return
// first — and, because the index is ordered by id rather than by date, not
// necessarily the recent ones.
//
// It is paged now, on the same stop, and measured against the same `meta.total` the
// debtors scan and the collection sweep are (live read-only probe, 2026-08-22: the
// total honours `patient_id`). A read that comes up short leaves the patient
// UNENRICHED — exactly what this route already does with a failed secondary read —
// so they are skipped and neither cursor advances past them. Nobody is scored on a
// spend history we know has holes in it.
//
// These cases all run in BACKFILL mode (the cursor below is `done: false`), so what
// they pin is the page-cursor rewind. The INCREMENTAL path's equivalent — the
// high-water mark being held back below the unread patient rather than being carried
// past them by a peer — is a different mechanism and is pinned separately, in
// watermark-holdback.test.ts. It also carries the caveat this shortfall needs: unlike
// the transient errors the degradation was modelled on, a `meta.total` shortfall is
// DETERMINISTIC for a given patient, so "the next run tries again" is bounded, not
// forever.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const PER_PAGE = 100;
/** Two years ago: a lapsed patient with a real, parseable last visit. */
const LAST_VISIT = new Date(Date.now() - 730 * 86_400_000).toISOString();

const store = vi.hoisted(() => ({
  /** Every (patientId, page) the route asked /v1/invoices for. */
  invoiceCalls: [] as Array<{ id: string; page: number }>,
  /** How many invoices each patient really has, and what the envelope claims. */
  invoiceCount: 0,
  invoiceTotal: null as number | null,
  upserted: [] as Array<{ dentallyPatientId: string; recoverableValue: number }>,
  cursor: { page: null as number | null, done: false },
  backfillSets: [] as Array<{ page: number | null; done: boolean; highWaterMark?: string }>,
}));

const dent = vi.hoisted(() => ({
  listTreatmentPlans: vi.fn(async () => ({ treatment_plans: [] as unknown[] })),
  listPatients: vi.fn(async (a: { page?: number }) => ({
    patients:
      (a?.page ?? 1) === 1
        ? [{ id: "pat-1", first_name: "A", last_name: "B", updated_at: "2026-07-06T00:00:00Z" }]
        : [],
  })),
  getPatientAppointments: vi.fn(async (_id: string, page?: number) => ({
    appointments: (page ?? 1) === 1 ? [{ id: "ap-1", start_time: LAST_VISIT, state: "completed" }] : [],
  })),
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listTreatmentPlans() {
      return dent.listTreatmentPlans();
    }
    listPatients(a: unknown) {
      return dent.listPatients(a as { page?: number });
    }
    getPatientAppointments(id: unknown, page?: number) {
      return dent.getPatientAppointments(id as string, page);
    }
    getPatientInvoices(id: unknown, page = 1, perPage = PER_PAGE) {
      store.invoiceCalls.push({ id: String(id), page });
      const start = (page - 1) * perPage;
      const rows = Array.from(
        { length: Math.max(0, Math.min(perPage, store.invoiceCount - start)) },
        (_, i) => ({ id: `inv-${start + i}`, paid: 10 }),
      );
      return Promise.resolve({
        invoices: rows,
        meta: store.invoiceTotal === null ? undefined : { total: store.invoiceTotal, current_page: page },
      });
    }
  },
}));
vi.mock("@/lib/reactivation/repository", () => ({
  upsertTargets: (targets: unknown[]) => {
    store.upserted.push(...(targets as Array<{ dentallyPatientId: string; recoverableValue: number }>));
    return Promise.resolve();
  },
  listTargets: async () => [],
  getCadenceByTarget: async () => null,
  updateCadence: async () => {},
  setTargetStatus: async () => {},
  getSyncState: async () => null,
  setSyncState: async () => {},
  getBackfillCursor: async () => ({ page: store.cursor.page, done: store.cursor.done }),
  setBackfillCursor: (
    _s: string,
    _r: string,
    o: { page: number | null; done: boolean; highWaterMark?: string },
  ) => {
    store.backfillSets.push(o);
    return Promise.resolve();
  },
  createCadence: async () => ({ id: "cad-new" }),
  listCadences: async () => [],
  listDueCadences: async () => [],
}));
vi.mock("@/lib/reactivation/settings", () => ({
  getDailyContactLimit: async () => 25,
  countContactedToday: async () => 0,
  getMaxLapseMonths: async () => Number.POSITIVE_INFINITY,
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => true ,
  // Ruling W1-B/1: the sweep now reads isSystemEnabledForSend (fail-closed once
  // messaging is live), and liveSwitch re-reads it every ten rows. Same verdict as
  // isSystemEnabled above, so these cases keep meaning exactly what they meant.
  isSystemEnabledForSend: async () => true}));
vi.mock("@/lib/patient-status/repository", () => ({
  loadExcludedTargetKeys: async () => new Set<string>(),
  // Ruling W1-B/2: loadExcludedTargetKeys REFUSES when the override table is
  // unreadable and messaging is live. This fake never refuses, so the guard reads
  // false; the refusal itself is proved in src/lib/agent-wiring/scenarios.test.ts.
  isExclusionsUnavailable: () => false,
  excludedTargetKey: (siteId: string, patientId: string) => `${siteId}:${patientId}`,
}));
vi.mock("@/lib/recall/repository", () => ({ listOpenRecallPatientKeys: async () => new Set<string>() }));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
  dentallySiteId: (id: string) => id,
}));

import { POST } from "./route";

async function run() {
  const res = await POST(
    new Request("http://localhost/api/sync/reactivation", {
      method: "POST",
      headers: { authorization: "Bearer inv-secret" },
    }),
  );
  const body = (await res.json()) as {
    perSite: Array<{ processed: number; targets?: number }>;
  };
  return body.perSite[0];
}

let warnings: string[] = [];

beforeEach(() => {
  store.invoiceCalls = [];
  store.invoiceCount = 0;
  store.invoiceTotal = null;
  store.upserted = [];
  store.cursor = { page: null, done: false };
  store.backfillSets = [];
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(String(args[0]));
  });
  vi.stubEnv("CRON_SECRET", "inv-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("F6: the reactivation sync pages a patient's invoices", () => {
  it("sums EVERY page of a long-standing patient's history, not just the first", async () => {
    // 150 invoices at £10 paid. Unpaged, this patient scored £1,000 and was ranked
    // and offered accordingly; their real value to the practice is £1,500.
    store.invoiceCount = 150;
    store.invoiceTotal = 150;

    await run();

    expect(store.invoiceCalls.map((c) => c.page)).toEqual([1, 2]);
    expect(store.upserted).toHaveLength(1);
    expect(
      store.upserted[0].recoverableValue,
      "the spend that ranks this patient was summed over one page of their history",
    ).toBe(1_500);
  });

  it("COSTS NOTHING EXTRA for the ordinary patient: one page, one request", async () => {
    // The overwhelming majority of patients hold well under a page of invoices, and
    // this read runs per patient inside a 300-patient cap, at BACKGROUND priority,
    // against the shared 3,600/hour ceiling. A short page still ends the walk.
    store.invoiceCount = 3;
    store.invoiceTotal = 3;

    await run();

    expect(store.invoiceCalls).toHaveLength(1);
    expect(store.upserted[0].recoverableValue).toBe(30);
  });

  it("leaves a patient UNENRICHED when Dentally says more invoices match than it returned", async () => {
    // The same degradation this route already applies to a failed secondary read:
    // skipped, not scored, and (this run being a BACKFILL one) the page cursor does
    // not advance past their page, so the next run re-pages them rather than the
    // practice chasing them on a partial history. The incremental path's own holdback
    // is pinned in watermark-holdback.test.ts.
    store.invoiceCount = 12;
    store.invoiceTotal = 40;

    const site = await run();

    expect(store.upserted, "a patient was scored on a provably partial spend history").toEqual([]);
    expect(site.processed).toBe(1); // seen and counted, but not enriched
    expect(warnings.some((m) => m.includes("leaving them unenriched"))).toBe(true);
  });

  it("CONTROL: an envelope with no count keeps the short-page stop, exactly as before", async () => {
    store.invoiceCount = 12;
    store.invoiceTotal = null;

    await run();

    expect(store.upserted).toHaveLength(1);
    expect(store.upserted[0].recoverableValue).toBe(120);
  });
});
