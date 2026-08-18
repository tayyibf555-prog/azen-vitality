// The DISPLAY/FRESH boundary, pinned at the read.ts seam.
//
// read.ts routes the DISPLAY reads through the shared display cache and keeps the
// FRESH reads (the write-confirmation guard, the by-id/sync read, online-booking
// availability) OUT of it. Under VITEST the cache is null (reads run uncached), so
// these tests INJECT an active cache backed by a spy store and assert which reads
// touch it. Each test names the mutation that turns it red.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface ClientStubs {
  listPatients: (arg: unknown) => Promise<unknown>;
  listAppointments: (arg: unknown) => Promise<unknown>;
  listTreatmentPlans: (arg: unknown) => Promise<unknown>;
  listInvoices: (arg: unknown) => Promise<unknown>;
  countPatients: (siteId: unknown) => Promise<number | null>;
  getPatient: (id: unknown) => Promise<unknown>;
  listPractitioners: (siteId: unknown) => Promise<unknown>;
  getAvailability: (arg: unknown) => Promise<unknown>;
}

const state = vi.hoisted<ClientStubs>(() => ({
  listPatients: () => Promise.resolve({ patients: [] }),
  listAppointments: () => Promise.resolve({ appointments: [] }),
  listTreatmentPlans: () => Promise.resolve({ treatment_plans: [] }),
  listInvoices: () => Promise.resolve({ invoices: [] }),
  countPatients: () => Promise.resolve(null),
  getPatient: () => Promise.resolve({ patient: { id: "p1", first_name: "A", last_name: "B", site_id: "site-cc" } }),
  listPractitioners: () => Promise.resolve({ practitioners: [] }),
  getAvailability: () => Promise.resolve({ availability: [] }),
}));

vi.mock("./client", () => ({
  DentallyClient: class {
    constructor() {}
    listPatients(a: unknown) { return state.listPatients(a); }
    listAppointments(a: unknown) { return state.listAppointments(a); }
    listTreatmentPlans(a: unknown) { return state.listTreatmentPlans(a); }
    listInvoices(a: unknown) { return state.listInvoices(a); }
    countPatients(s: unknown) { return state.countPatients(s); }
    getPatient(id: unknown) { return state.getPatient(id); }
    listPractitioners(s: unknown) { return state.listPractitioners(s); }
    getAvailability(a: unknown) { return state.getAvailability(a); }
  },
}));

import {
  listOutstanding,
  getPatientById,
  listSitePractitionersSafe,
  listDiaryAvailabilitySafe,
  prewarmOutstanding,
  __setDisplayCacheForTests,
} from "./read";
import { createDisplayCache, type DisplayCacheStore } from "./display-cache";

// A store that counts every interaction, so "did this read touch the shared cache?"
// is a hard number.
function spyStore(): DisplayCacheStore & {
  gets: number;
  sets: number;
  deletes: number;
  rows: Map<string, { value: unknown; expiresAt: number }>;
} {
  const rows = new Map<string, { value: unknown; expiresAt: number }>();
  const key = (c: string, k: string) => `${c}::${k}`;
  const s = {
    gets: 0,
    sets: 0,
    deletes: 0,
    rows,
    // Present-regardless-of-expiry: freshness is the cache's job now (so it can
    // stale-while-revalidate). This spy only ever holds fresh rows in these tests.
    async get(clientId: string, cacheKey: string) {
      s.gets += 1;
      const row = rows.get(key(clientId, cacheKey));
      if (!row) return null;
      return { value: JSON.parse(JSON.stringify(row.value)), expiresAt: row.expiresAt };
    },
    async set(clientId: string, cacheKey: string, value: unknown, expiresAtMs: number) {
      s.sets += 1;
      rows.set(key(clientId, cacheKey), { value: JSON.parse(JSON.stringify(value)), expiresAt: expiresAtMs });
    },
    async deleteByPrefix() {
      s.deletes += 1;
    },
  };
  return s;
}

let store: ReturnType<typeof spyStore>;

beforeEach(() => {
  vi.stubEnv("DENTALLY_API_KEY", "k");
  store = spyStore();
  __setDisplayCacheForTests(createDisplayCache({ store }));
});

afterEach(() => {
  __setDisplayCacheForTests(null); // restore the VITEST pass-through
  vi.unstubAllEnvs();
});

describe("DISPLAY reads route through the shared cache", () => {
  it("listOutstanding computes once, then serves the shared cache (no second page walk)", async () => {
    const calls: number[] = [];
    state.listInvoices = ((a: { page?: number }) => {
      calls.push(a.page ?? 1);
      return Promise.resolve({ invoices: [] });
    }) as never;

    await listOutstanding(["site-cc"]);
    const invoiceCallsAfterFirst = calls.length;
    await listOutstanding(["site-cc"]); // within TTL

    expect(store.sets).toBe(1); // the computed result reached the shared L2
    expect(calls.length).toBe(invoiceCallsAfterFirst); // the second read paged Dentally ZERO more times
  });
});

describe("PRE-WARM writes the read's own key, tenant-correct, with the long ttl", () => {
  it("prewarmOutstanding lands under (clientId, outstanding-key) and satisfies the live read", async () => {
    let invoicePages = 0;
    state.listInvoices = (() => {
      invoicePages += 1;
      return Promise.resolve({ invoices: [] });
    }) as never;

    const LONG = 20 * 60_000;
    await prewarmOutstanding(["site-cc"], LONG);

    // Wrote exactly one row, under THIS client's tenant + the read's exact key, with
    // a ttl reflecting the long pre-warm window (not the 60s read ttl).
    expect(store.sets).toBe(1);
    const row = store.rows.get("vitality::outstanding:site-cc");
    expect(row).toBeTruthy();
    expect(row!.expiresAt).toBeGreaterThan(Date.now() + 10 * 60_000);
    // No other tenant's row was written.
    expect([...store.rows.keys()]).toEqual(["vitality::outstanding:site-cc"]);

    // The live read is now a fresh L2 hit: it pages Dentally ZERO more times.
    const pagesAfterWarm = invoicePages;
    await listOutstanding(["site-cc"]);
    expect(invoicePages).toBe(pagesAfterWarm);

    // MUTATION: key the pre-warm on a bare site set (drop clientIdForSites) or on a
    // different key string -> the row lands somewhere the read never looks, store.sets
    // stays 1 but the live read re-pages (invoicePages climbs) -> red.
  });
});

describe("FRESH reads bypass the shared cache", () => {
  it("getPatientById never touches the shared cache and is never memoised", async () => {
    let getPatientCalls = 0;
    state.getPatient = (() => {
      getPatientCalls += 1;
      return Promise.resolve({ patient: { id: "p1", first_name: "A", last_name: "B", site_id: "site-cc" } });
    }) as never;

    await getPatientById("p1");
    await getPatientById("p1");

    // MUTATION: wrap getPatientById in cachedRead -> store.sets becomes > 0 (red) and
    // getPatientCalls drops to 1 (a second red). A by-id read the sync + IDOR guard
    // rely on must always hit Dentally.
    expect(store.gets).toBe(0);
    expect(store.sets).toBe(0);
    expect(getPatientCalls).toBe(2);
  });

  it("a Safe read given its OWN client (the write-guard path) bypasses the cache in both directions", async () => {
    const guardClient = {
      listPractitioners: () => Promise.resolve({ practitioners: [{ id: "prac-1", active: true, user: { first_name: "D", last_name: "J" } }] }),
      getAvailability: () => Promise.resolve({ availability: [] }),
    } as never;

    await listSitePractitionersSafe("site-cc", { client: guardClient });
    await listDiaryAvailabilitySafe(
      { siteId: "site-cc", practitionerIds: ["prac-1"], fromDayKey: "2026-08-18", toDayKey: "2026-08-18" },
      { client: guardClient },
    );

    // MUTATION: drop `!opts.client` from either helper's useCache -> store.gets/sets
    // become > 0 (red). The move-service write guard must never be answered from, or
    // poison, the read-path cache.
    expect(store.gets).toBe(0);
    expect(store.sets).toBe(0);
  });
});
