// ---------------------------------------------------------------------------
// THE INCREMENTAL HIGH-WATER MARK IS THE CURSOR, AND IT HAD NO REWIND.
//
// The backfill path already knew this: a patient whose secondary reads fail is left
// unenriched, and the page cursor rewinds to just before their page so the next run
// re-pages them (backfill.test.ts pins it). The INCREMENTAL path had only half of
// that. An unenriched patient correctly did not contribute their OWN updated_at to
// the mark — but nothing stopped a PEER's later updated_at doing it for them. The
// /v1/patients feed is UNORDERED, so a patient updated at 10:00 whose invoice walk
// came up short, sitting next to a peer updated at 11:00 that read fine, stored 11:00
// and was never queried again until Dentally happened to touch their record.
//
// That mattered more here than the "retry next run" comments admitted, because one of
// this route's failure modes is DETERMINISTIC: an invoice walk that ends short of
// `meta.total` ends short on every run. Not a blip that heals — a patient dropped out
// of reactivation for good, silently.
//
// The mark is now capped a second below the earliest patient the run could not read,
// with a bounded escape valve so a permanently-failing patient pins one record rather
// than the whole site's sync. These tests run the route TWICE over a filtering feed,
// so what is pinned is not "the number we stored" but the thing that actually matters:
// whether the next run's query comes back with the stranded patient in it.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Two years ago: a lapsed patient with a real, parseable last visit. */
const LAST_VISIT = new Date(Date.now() - 730 * 86_400_000).toISOString();

/** The patient whose enrichment fails. Updated EARLIER than the peer that succeeds. */
const OLD_UPDATED = "2026-07-06T10:00:00Z";
/** The peer that reads fine, updated an hour later — the one that used to carry the mark. */
const NEW_UPDATED = "2026-07-06T11:00:00Z";

const store = vi.hoisted(() => ({
  /** The site's feed, in feed order (which is NOT updated_at order — Dentally has no sort). */
  patients: [] as Array<{ id: string; updated_at: string }>,
  /** Patient whose invoice walk comes up short of meta.total -> left unenriched. */
  shortPatientId: null as string | null,
  /** Every (page, updatedAfter) the route asked /v1/patients for, across all runs. */
  listCalls: [] as Array<{ page: number; updatedAfter: string | undefined; returned: string[] }>,
  /** The stored incremental mark, read back by the next run exactly as Postgres would. */
  mainHwm: null as string | null,
  mainSets: [] as string[],
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
    listTreatmentPlans() {
      return Promise.resolve({ treatment_plans: [] as unknown[] });
    }
    // THE FEED HONOURS updated_after, STRICTLY. Dentally's own boundary semantics are
    // unprobed (the live key is read-only and IP-pinned), so this models the STRICTER
    // of the two readings: a mark stored AT a patient's updated_at would not bring
    // them back. A fix that survives this survives `>=` too.
    listPatients(a: unknown) {
      const { page = 1, updatedAfter } = (a ?? {}) as { page?: number; updatedAfter?: string };
      const matching = store.patients.filter(
        (p) => updatedAfter === undefined || Date.parse(p.updated_at) > Date.parse(updatedAfter),
      );
      const rows = page === 1 ? matching : [];
      store.listCalls.push({ page, updatedAfter, returned: rows.map((r) => r.id) });
      return Promise.resolve({
        patients: rows.map((r) => ({ id: r.id, first_name: "A", last_name: "B", updated_at: r.updated_at })),
      });
    }
    getPatientAppointments(_id: unknown, page = 1) {
      return Promise.resolve({
        appointments: page === 1 ? [{ id: "ap-1", start_time: LAST_VISIT, state: "completed" }] : [],
      });
    }
    getPatientInvoices(id: unknown, page = 1) {
      // The short walk: Dentally says 40 invoices match, one page of 12 comes back.
      if (String(id) === store.shortPatientId) {
        return Promise.resolve({
          invoices: page === 1 ? Array.from({ length: 12 }, (_, i) => ({ id: `inv-${i}`, paid: 10 })) : [],
          meta: { total: 40, current_page: page },
        });
      }
      return Promise.resolve({
        invoices: page === 1 ? [{ id: "inv-0", paid: 10 }] : [],
        meta: { total: 1, current_page: page },
      });
    }
  },
}));
vi.mock("@/lib/reactivation/repository", () => ({
  upsertTargets: async () => {},
  listTargets: async () => [],
  getCadenceByTarget: async () => null,
  updateCadence: async () => {},
  setTargetStatus: async () => {},
  getSyncState: async () => (store.mainHwm === null ? null : { highWaterMark: store.mainHwm }),
  setSyncState: (_s: string, _r: string, v: string) => {
    store.mainHwm = v;
    store.mainSets.push(v);
    return Promise.resolve();
  },
  // Backfill is DONE: this exercises the incremental path, the one with no rewind.
  getBackfillCursor: async () => ({ page: 4, done: true }),
  setBackfillCursor: async () => {},
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
      headers: { authorization: "Bearer hwm-secret" },
    }),
  );
  const body = (await res.json()) as { perSite: Array<{ mode: string; processed: number }> };
  return body.perSite[0];
}

/** What the NEXT run's /v1/patients query actually came back with. */
function lastQuery() {
  return store.listCalls[store.listCalls.length - 1];
}

let errors: string[] = [];

beforeEach(() => {
  store.patients = [
    { id: "pat-old", updated_at: OLD_UPDATED },
    { id: "pat-new", updated_at: NEW_UPDATED },
  ];
  store.shortPatientId = null;
  store.listCalls = [];
  store.mainHwm = "2026-07-06T09:00:00Z"; // a prior run's mark; backfill is long done
  store.mainSets = [];
  errors = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(String(args[0]));
  });
  vi.stubEnv("CRON_SECRET", "hwm-secret");
  vi.stubEnv("DENTALLY_API_KEY", "k");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reactivation incremental watermark: an unread patient holds the mark back", () => {
  it("re-queries a patient whose invoice walk came up short, even though a LATER peer read fine", async () => {
    store.shortPatientId = "pat-old";

    const first = await run();
    expect(first.mode).toBe("incremental");
    expect(first.processed).toBe(2); // both seen; only the peer enriched

    // The mark must land BELOW the unread patient, not on the peer that succeeded.
    expect(store.mainSets).toHaveLength(1);
    expect(
      Date.parse(store.mainSets[0]),
      "the stored mark sits at or past the unread patient, so the next run's " +
        "updated_after filters them out — stranded until Dentally touches their record",
    ).toBeLessThan(Date.parse(OLD_UPDATED));

    // THE ACTUAL PROOF: run again against a feed that honours updated_after and check
    // the stranded patient comes back. This is the assertion the stored number is only
    // a proxy for.
    store.listCalls = [];
    await run();
    expect(
      lastQuery().returned,
      "the next run's query did not return the patient it failed to read",
    ).toContain("pat-old");

    // And the holdback is a FIXED POINT, not a ratchet: it is derived from the unread
    // patient's own updated_at, so a run that re-fails them re-computes the same mark
    // rather than walking the window a second further back every hour.
    expect(store.mainSets[1]).toBe(store.mainSets[0]);
  });

  it("stores the plain maximum when every patient enriched (no needless rewind)", async () => {
    const site = await run();

    expect(site.processed).toBe(2);
    expect(
      store.mainSets,
      "a clean run must still advance the mark to the newest record it processed",
    ).toEqual([NEW_UPDATED]);

    // And a clean run's mark really does close the window: nothing is re-queried.
    store.listCalls = [];
    await run();
    expect(lastQuery().returned).toEqual([]);
  });

  it("ESCAPE VALVE: past the holdback window it advances over the patient, loudly and by name", async () => {
    // The same deterministic failure, but the practice's records have moved a working
    // week beyond the stuck patient. Holding the mark here is no longer protecting one
    // record — it is re-querying an ever-growing window that will outgrow the per-run
    // cap and stop the site syncing at all.
    store.patients = [
      { id: "pat-old", updated_at: "2026-07-01T00:00:00Z" },
      { id: "pat-new", updated_at: NEW_UPDATED }, // 2026-07-06T11:00 — 5 days later
    ];
    store.mainHwm = "2026-06-30T00:00:00Z";
    store.shortPatientId = "pat-old";

    await run();

    expect(
      store.mainSets,
      "the mark stayed pinned on a patient that cannot be read, at the cost of the whole site",
    ).toEqual([NEW_UPDATED]);
    expect(
      errors.some((m) => m.includes("pat-old") && m.includes("ADVANCING")),
      "the site's sync gave up on a patient without naming them at error level",
    ).toBe(true);
  });

  it("stays held back while the failure is still inside the holdback window", async () => {
    // One hour of Dentally updates between the unread patient and the newest record —
    // well inside the window, so this is a retry, not a write-off.
    store.shortPatientId = "pat-old";

    await run();

    expect(errors.some((m) => m.includes("ADVANCING"))).toBe(false);
    expect(Date.parse(store.mainSets[0])).toBeLessThan(Date.parse(OLD_UPDATED));
  });
});
