import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  __setDentallyBudgetForTests,
  dentallyCeiling,
  runWithDentallyPriority,
  DENTALLY_HOURLY_LIMIT,
  type BudgetConsumer,
  type DentallyPriority,
} from "@/lib/dentally/budget";
import { DentallyBudgetExceededError } from "@/lib/dentally/client";
import {
  __setDisplayCacheForTests,
  asBackgroundRefresh,
} from "@/lib/dentally/read";
import { createDisplayCache, type DisplayCacheStore } from "@/lib/dentally/display-cache";
import {
  DASHBOARD_CACHE_KEY,
  DASHBOARD_TTL_MS,
  prewarmPracticeDashboard,
  readPracticeDashboard,
} from "@/lib/dashboard/read";
import type { PracticeDashboardView } from "@/lib/dashboard/view";

// ---------------------------------------------------------------------------
// RE-VERIFICATION, ROUND 3 — my own measurement, not a re-run of the fixer's.
//
// THE PRIOR HOLD. A budget-refused dashboard assembly was promoted into the shared
// L2 cache stamped FRESH for fifteen minutes, blanking the practice's dashboard and
// overwriting the good figures that row was serving a moment earlier. Routine, not
// exotic: the pre-warm cron and every stale-while-revalidate refresh run in the
// BACKGROUND class, which is refused FIRST at 60% of the hour, so a refused assembly
// is the normal outcome of a busy afternoon.
//
// WHAT THIS FILE MEASURES, INDEPENDENTLY. It shares no helper, store, clock or
// fixture with budget-refusal-not-cached.test.ts. It builds its own L2 that records
// `computed_at` the way supabaseDisplayCacheStore actually writes it — a wall-clock
// ISO string stamped inside `set` — and it ADVANCES that wall clock between phases,
// so any re-stamp of the row is necessarily visible as a changed computed_at even if
// the value written happened to be identical.
//
// The measurement is the same practice, the same in-process mock, back to back:
//   phase 1  budget available      -> assemble, record the exact figures
//   phase 2  background exhausted  -> pre-warm tick, then the reader's own SWR refresh
// and the reader must get the GOOD figures in BOTH, served stale in the second, with
// the L2 row byte-identical across the refused attempt.
// ---------------------------------------------------------------------------

const CLIENT = "vitality";

// --- An L2 that records computed_at exactly as the real store does ----------

interface Row {
  value: unknown;
  expiresAt: number;
  /** `computed_at`, stamped from WALL CLOCK inside set(), as the real store does. */
  computedAt: string;
}

interface Probe extends DisplayCacheStore {
  rows: Map<string, Row>;
  writes: number;
  row(): Row | null;
  /** Everything about the row that an overwrite would disturb, as one string. */
  fingerprint(): string;
}

/** `wall` is deliberately SEPARATE from the cache's `now`, and always moves. */
let wall = 0;

function probeStore(): Probe {
  const rows = new Map<string, Row>();
  const k = (c: string, ck: string) => JSON.stringify([c, ck]);
  const store: Probe = {
    rows,
    writes: 0,
    row() {
      const r = rows.get(k(CLIENT, DASHBOARD_CACHE_KEY));
      return r ? { ...r } : null;
    },
    fingerprint() {
      const r = store.row();
      return r === null
        ? "NO ROW"
        : JSON.stringify({ computedAt: r.computedAt, expiresAt: r.expiresAt, value: r.value });
    },
    async get(clientId, cacheKey) {
      const r = rows.get(k(clientId, cacheKey));
      // Present at ANY age — freshness is the cache's job, not the store's, which is
      // what makes stale-while-revalidate possible at all.
      return r ? { value: JSON.parse(JSON.stringify(r.value)), expiresAt: r.expiresAt } : null;
    },
    async set(clientId, cacheKey, value, expiresAtMs) {
      store.writes += 1;
      wall += 1000; // every write is a distinguishable instant
      rows.set(k(clientId, cacheKey), {
        value: JSON.parse(JSON.stringify(value)),
        expiresAt: expiresAtMs,
        computedAt: new Date(wall).toISOString(),
      });
    },
    async deleteByPrefix() {},
  };
  return store;
}

// --- A budget modelled on the real SQL (increment first, then compare) ------

let spent = 0;
const consumed: DentallyPriority[] = [];
const budget: BudgetConsumer = async (priority, limit) => {
  // migration 0023: `count = count + 1 ... returning count` then `count <= limit`.
  // It increments on the call it REFUSES too, which is why a refusal has to be sticky.
  consumed.push(priority);
  spent += 1;
  return spent <= limit;
};

/** Past the BACKGROUND ceiling, comfortably inside interactive's and critical's. */
function exhaustBackground(): void {
  spent = dentallyCeiling("background") + 1;
}

// --- Clock + the SWR scheduler, classified as read.ts classifies it ---------

let clockMs = 0;
const now = () => clockMs;

let scheduled: Array<() => Promise<void>> = [];
function scheduleBackground(task: () => Promise<void>): void {
  // asBackgroundRefresh is the production wrapper; using it (rather than reproducing
  // it) is the point — if it stopped classifying refreshes as background, this
  // harness would stop reproducing production and the tests below would notice.
  scheduled.push(asBackgroundRefresh(task));
}
async function flushBackground(): Promise<void> {
  const queued = scheduled;
  scheduled = [];
  for (const t of queued) await t().catch(() => {});
}

let store: Probe;

// --- Upstreams ---------------------------------------------------------------

const MOCK: Record<string, () => Promise<{ GET: (r: Request) => Promise<Response> }>> = {
  "/v1/patients": () => import("@/app/api/mock-dentally/v1/patients/route") as never,
  "/v1/appointments": () => import("@/app/api/mock-dentally/v1/appointments/route") as never,
  "/v1/invoices": () => import("@/app/api/mock-dentally/v1/invoices/route") as never,
  "/v1/payments": () => import("@/app/api/mock-dentally/v1/payments/route") as never,
  "/v1/nhs_claims": () => import("@/app/api/mock-dentally/v1/nhs_claims/route") as never,
  "/v1/practitioners": () => import("@/app/api/mock-dentally/v1/practitioners/route") as never,
  "/v1/treatment_plans": () => import("@/app/api/mock-dentally/v1/treatment_plans/route") as never,
};

let upstreamCalls = 0;

/** The local mock app, in process. */
function mockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    upstreamCalls += 1;
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname.replace("/api/mock-dentally", "");
    const load = MOCK[path];
    if (!load) throw new Error(`no mock handler for ${path}`);
    const mod = await load();
    return mod.GET(new Request(url, { headers: { Authorization: "Bearer probe" } }));
  }) as typeof fetch;
}

/** A GENUINE upstream outage: every endpoint 500s. */
function deadFetch(): typeof fetch {
  return (async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ error: "dentally is down" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// THE PROCESS CLOCK IS PINNED, AND THAT IS THE POINT OF THIS BLOCK.
//
// This file was a TIME BOMB: it passed on today's calendar and went red on a
// shifted one, and the failure read as a logic regression rather than as a stale
// fixture. Found by running the whole suite under a shifted process clock
// (+3h/+1d/+3d/+4d/+30d/+90d/+181d/+2y/+10y) and diffing against a real-clock
// baseline — the only method that finds these, because grepping for hard-coded
// dates matches a third of the suite and misses the ones that matter.
//
// Only `Date` is faked. Faking all timers hangs the async route and agent paths
// these tests drive; this is the pattern from src/lib/agent/booking-duration.test.ts.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-20T14:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "zzv-round3";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid/api/mock-dentally";
  spent = 0;
  consumed.length = 0;
  upstreamCalls = 0;
  clockMs = Date.parse("2026-08-20T14:00:00.000Z");
  wall = Date.parse("2026-08-20T14:00:00.000Z");
  scheduled = [];
  store = probeStore();
  __setDisplayCacheForTests(createDisplayCache({ store, now, scheduleBackground }));
  __setDentallyBudgetForTests(budget);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __setDisplayCacheForTests(null);
  __setDentallyBudgetForTests(null);
});

// --- Reading figures out of the assembled view -------------------------------

function group(view: PracticeDashboardView) {
  const s = view.scopes.find((x) => x.siteId === null);
  expect(s, "the view has no all-sites scope").toBeTruthy();
  return s!;
}

/** Every period the takings strip could actually SOURCE, with its pence total. */
function totals(view: PracticeDashboardView): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of group(view).strip.cells) if (c.totalPence !== null) out[c.period] = c.totalPence;
  return out;
}

/** Every period the strip declared UNAVAILABLE, with the stated reason. */
function reasons(view: PracticeDashboardView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of group(view).strip.cells) {
    if (c.totalPence === null && c.unavailableReason) out[c.period] = c.unavailableReason;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. THE BACK-TO-BACK MEASUREMENT
// ---------------------------------------------------------------------------

describe("round 3 / same client, same mock, back to back", () => {
  it("the reader gets the GOOD figures with budget AND with background spent", async () => {
    globalThis.fetch = mockFetch();

    // -- PHASE 1: budget available. This is the practice's real dashboard. -----
    const good = await readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) });
    const goodTotals = totals(good);

    // The measurement is only worth anything if phase 1 actually sourced money.
    expect(
      Object.keys(goodTotals).length,
      "phase 1 sourced no takings at all, so this test would pass vacuously",
    ).toBeGreaterThan(0);
    expect(Object.values(goodTotals).some((p) => p > 0)).toBe(true);
    expect(good.practitioners.length, "phase 1 named no practitioners").toBeGreaterThan(0);

    expect(store.writes).toBe(1);
    const beforeRefusal = store.fingerprint();
    expect(beforeRefusal).not.toBe("NO ROW");

    process.stderr.write(
      `\n[round3] PHASE 1 (budget available): totals=${JSON.stringify(goodTotals)} ` +
        `practitioners=${good.practitioners.length} upstreamCalls=${upstreamCalls}\n`,
    );

    // -- PHASE 2: the hour turns. Background is spent; interactive is not. -----
    exhaustBackground();
    const callsBefore = upstreamCalls;

    // 2a. THE PRE-WARM TICK. It writes unconditionally; only never reaching the
    //     write can stop it stamping a blank over the good row.
    await expect(
      runWithDentallyPriority("background", () =>
        prewarmPracticeDashboard(CLIENT, new Date(clockMs), DASHBOARD_TTL_MS),
      ),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);

    expect(store.writes, "the refused pre-warm wrote to L2").toBe(1);
    expect(store.fingerprint(), "the refused pre-warm disturbed the L2 row").toBe(beforeRefusal);

    // 2b. THE READER'S OWN SWR REFRESH. Age the row past its TTL so the next read
    //     serves stale and schedules the second promote path.
    clockMs += DASHBOARD_TTL_MS + 60_000;
    const served = await readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) });

    // SERVED STALE, AND STILL GOOD. Same figures, not "Unavailable".
    expect(totals(served)).toEqual(goodTotals);
    expect(served.practitioners.length).toBe(good.practitioners.length);
    expect(scheduled.length, "no SWR refresh was scheduled, so the second path is untested").toBe(1);

    await flushBackground();

    // -- THE ASSERTION THE PRIOR HOLD WAS ABOUT -------------------------------
    expect(store.writes, "the refused SWR refresh promoted an assembly").toBe(1);
    expect(
      store.fingerprint(),
      "the L2 row changed across the refused attempt — computed_at, expires_at or value",
    ).toBe(beforeRefusal);

    // And the row is still readable as the good figures by the NEXT reader.
    const again = await readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) });
    expect(totals(again)).toEqual(goodTotals);
    for (const cell of group(again).strip.cells) {
      if (goodTotals[cell.period] === undefined) continue;
      expect(cell.totalPence).toBe(goodTotals[cell.period]);
      expect(cell.unavailableReason).toBeNull();
    }

    process.stderr.write(
      `[round3] PHASE 2 (background spent): totals=${JSON.stringify(totals(again))} ` +
        `L2 writes=${store.writes} computed_at=${store.row()?.computedAt} ` +
        `(unchanged) refusedUpstreamCalls=${upstreamCalls - callsBefore}\n`,
    );
  }, 180_000);

  it("the refused assembly really IS blank, so the row it would have replaced matters", async () => {
    // The other half of the same measurement: what the refused attempt WOULD have
    // written if it were allowed to return instead of throw. Measured at the same
    // boundary the cache promotes from, with the SAME mock — so "the good row
    // survived" above is a statement about a real loss, not a hypothetical one.
    globalThis.fetch = mockFetch();
    exhaustBackground();

    const view = await runWithDentallyPriority("background", () =>
      readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) }),
    );

    // Uniformly blank — every period, not one panel.
    expect(totals(view)).toEqual({});
    expect(Object.keys(reasons(view)).length).toBeGreaterThan(0);
    expect(view.practitioners).toEqual([]);

    // ...and it was NOT cached, so the next hour retries rather than serving it.
    expect(store.writes, "a refused cold assembly was promoted into L2").toBe(0);
    expect(store.row()).toBeNull();

    process.stderr.write(
      `[round3] the refused assembly: totals=${JSON.stringify(totals(view))} ` +
        `unavailablePeriods=${Object.keys(reasons(view)).length} practitioners=0 L2 writes=0\n`,
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. A REAL UPSTREAM FAILURE MUST STILL DEGRADE HONESTLY
// ---------------------------------------------------------------------------

describe("round 3 / a genuine Dentally outage is untouched by the fix", () => {
  it("degrades to declared-unavailable panels — not a throw, not a blank screen", async () => {
    globalThis.fetch = deadFetch();

    // No refusal anywhere: the budget is wide open, Dentally itself is down.
    const view = await readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) });

    // It RESOLVED (no thrown page) and every period states a reason rather than a
    // figure. Coverage is declared, which is the honesty the fix must not cost.
    expect(totals(view)).toEqual({});
    for (const cell of group(view).strip.cells) {
      expect(cell.totalPence).toBeNull();
      expect(cell.unavailableReason, `period ${cell.period} went blank with no reason`).toBeTruthy();
    }
    // The practice's own sites are still named, so the screen is recognisably theirs.
    expect(view.sites.length).toBeGreaterThan(0);

    // AND IT IS STILL CACHED. An outage has nothing better to offer, so caching the
    // honest unavailable view is correct — this is the branch the fix must not have
    // swept up with the refusal.
    expect(store.writes, "an honest upstream failure stopped being cached").toBe(1);
    expect(spent, "an outage must not be mistaken for a refusal").toBeGreaterThan(0);

    process.stderr.write(
      `[round3] genuine outage: resolved, ${Object.keys(reasons(view)).length} periods ` +
        `declared unavailable, L2 writes=${store.writes} (cached, as it should be)\n`,
    );
  }, 120_000);

  it("an outage DURING a refused hour is still an outage, and still not cached blank", async () => {
    // Both at once, which is the realistic bad afternoon: the quota is gone AND the
    // endpoint is sick. The refusal wins (it happens before any request is sent), so
    // nothing is promoted — the good row, if any, survives either way.
    globalThis.fetch = deadFetch();
    exhaustBackground();

    const view = await runWithDentallyPriority("background", () =>
      readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) }),
    );
    expect(totals(view)).toEqual({});
    expect(store.writes).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. PRIOR ROUNDS' PROPERTIES, RE-MEASURED HERE
// ---------------------------------------------------------------------------

describe("round 3 / the earlier properties still hold", () => {
  it("STICKY REFUSAL: a refused background assembly cannot inflate the counter", async () => {
    globalThis.fetch = mockFetch();
    exhaustBackground();
    const at = spent;

    await runWithDentallyPriority("background", () =>
      readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) }),
    );

    // The whole assembly fans out over three sites and seven scans. Without sticky
    // refusal every one of those would be a real increment of the practice's shared
    // hourly counter for a request never sent. The residual is bounded by the fan-out
    // already in flight when the first refusal lands, NOT by the item count.
    const phantom = spent - at;
    expect(phantom, `a refused assembly inflated the shared counter by ${phantom}`).toBeLessThan(30);
    expect(upstreamCalls, "a refused assembly still called Dentally").toBe(0);

    process.stderr.write(
      `[round3] sticky refusal: refused assembly cost ${phantom} counter increments, ` +
        `${upstreamCalls} upstream calls\n`,
    );
  }, 120_000);

  it("CRITICAL AND INTERACTIVE KEEP READING while background is starved", async () => {
    globalThis.fetch = mockFetch();
    exhaustBackground();

    // Background: refused.
    await expect(
      runWithDentallyPriority("background", () =>
        prewarmPracticeDashboard(CLIENT, new Date(clockMs), DASHBOARD_TTL_MS),
      ),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);

    // Critical (the public booking calendar, the agent) in the SAME hour: served.
    // A fresh scope, so it does not inherit the background scope's refusal.
    const critical = await runWithDentallyPriority("critical", () =>
      readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) }),
    );
    expect(
      Object.keys(totals(critical)).length,
      "critical work was starved by a background refusal",
    ).toBeGreaterThan(0);

    // The ceilings are nested, so this is only meaningful below critical's.
    expect(spent).toBeLessThan(dentallyCeiling("critical"));
    expect(dentallyCeiling("background")).toBeLessThan(dentallyCeiling("interactive"));
    expect(dentallyCeiling("interactive")).toBeLessThan(dentallyCeiling("critical"));
    expect(dentallyCeiling("critical")).toBeLessThan(DENTALLY_HOURLY_LIMIT);

    process.stderr.write(
      `[round3] priority split held: background refused, critical assembled ` +
        `${Object.keys(totals(critical)).length} periods at spend ${spent}\n`,
    );
  }, 180_000);

  it("FAIL-OPEN / FAIL-CLOSED asymmetry survives an unavailable budget store", async () => {
    // The store itself is down: the guard cannot know the consumption.
    __setDentallyBudgetForTests(async () => {
      throw new Error("api_budget unreachable");
    });
    globalThis.fetch = mockFetch();

    // BACKGROUND FAILS CLOSED — a bulk scan that cannot see the budget must not run.
    await expect(
      runWithDentallyPriority("background", () =>
        prewarmPracticeDashboard(CLIENT, new Date(clockMs), DASHBOARD_TTL_MS),
      ),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);
    expect(store.writes, "a fail-closed background run still wrote to L2").toBe(0);

    // INTERACTIVE FAILS OPEN — a practice manager is not blocked by our bookkeeping.
    const view = await runWithDentallyPriority("interactive", () =>
      readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) }),
    );
    expect(
      Object.keys(totals(view)).length,
      "interactive work failed CLOSED when the budget store was down",
    ).toBeGreaterThan(0);

    process.stderr.write(
      `[round3] asymmetry: store down -> background refused (0 L2 writes), ` +
        `interactive assembled ${Object.keys(totals(view)).length} periods\n`,
    );
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 4. AUDIT OF THE OTHER CACHED DISPLAY FAMILIES
// ---------------------------------------------------------------------------
//
// The eleven families that reach the shared L2 are, with the guard that stops a
// refusal being promoted:
//
//   readPracticeDashboard      dashboard/read.ts   catch OUTSIDE cachedRead
//   getPatientRecord           patient/record.ts   catch OUTSIDE cachedRead
//   listPatients               dentally/read.ts    degradeOnBudgetRefusal
//   searchPatients             dentally/read.ts    degradeOnBudgetRefusal
//   countPatients              dentally/read.ts    degradeOnBudgetRefusal
//   listAppointments           dentally/read.ts    degradeOnBudgetRefusal
//   getPatientDetail           dentally/read.ts    degradeOnBudgetRefusal
//   listOutstandingDetailed    dentally/read.ts    degradeOnBudgetRefusal
//   listSitePractitioners      dentally/read.ts    promotes only when !failed
//   listAppointmentsSafe       dentally/read.ts    promotes only when failedSiteIds is empty
//   listDiaryAvailabilitySafe  dentally/read.ts    promotes only when !failed
//
// plus the two pre-warm write paths (prewarmPracticeDashboard, prewarmOutstanding),
// both of which are now unreachable on a refusal. For the promote-an-empty hazard the
// audit is complete — checked family by family, not taken on the report's word.
//
// WHAT THE AUDIT DID *NOT* CARRY ACROSS is the sibling defect the same pass fixed for
// the dashboard: the TTL a reader's own refresh RE-STAMPS the row with. The test
// below measures it on the outstanding book.

import { listOutstandingDetailed, prewarmOutstanding } from "@/lib/dentally/read";

describe("round 3 / audit: the TTL a reader re-stamps the OUTSTANDING row with", () => {
  it("MEASURES the re-stamp: the pre-warm's 15 minutes becomes 60 seconds", async () => {
    // The dashboard's own version of this was diagnosed and fixed in this pass:
    // DASHBOARD_TTL_MS went 60s -> 15min because "an SWR refresh re-stamps the row
    // with THIS ttl", so a lapsed pre-warm left the shared row expiring every minute
    // and every instance re-paging the practice's whole book. listOutstandingDetailed
    // has the identical structure and was left at the default.
    const SITES = ["site-cc", "site-rv", "site-ng"];
    const KEY = `outstanding:${[...SITES].sort().join("|")}`;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      upstreamCalls += 1;
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname.endsWith("/v1/invoices")) {
        return new Response(
          JSON.stringify({
            invoices: [
              { id: "i1", patient_id: "p1", amount: 400, amount_outstanding: 400, status: "new" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/v1/patients")) {
        return new Response(
          JSON.stringify({
            patients: [
              { id: "p1", first_name: "A", last_name: "B", site_id: "site-cc", active: true },
            ],
            meta: { total: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const PREWARM_TTL = DASHBOARD_TTL_MS; // what the cron actually stamps
    await prewarmOutstanding(SITES, PREWARM_TTL);
    const warmed = store.rows.get(JSON.stringify([CLIENT, KEY]));
    expect(warmed, "the pre-warm wrote no outstanding row").toBeTruthy();
    const warmedFor = warmed!.expiresAt - clockMs;
    expect(warmedFor).toBe(PREWARM_TTL);

    // Age past the pre-warm's stamp: the row is stale, so the next read serves it and
    // schedules the refresh that re-stamps it.
    clockMs += PREWARM_TTL + 1_000;
    await listOutstandingDetailed(SITES);
    expect(scheduled.length, "no SWR refresh was scheduled for the outstanding row").toBe(1);
    await flushBackground();

    const restamped = store.rows.get(JSON.stringify([CLIENT, KEY]))!;
    const restampedFor = restamped.expiresAt - clockMs;

    process.stderr.write(
      `[round3] outstanding TTL: pre-warm stamped ${warmedFor / 60000} min, ` +
        `the reader's own refresh re-stamped ${restampedFor / 60000} min ` +
        `(dashboard uses ${DASHBOARD_TTL_MS / 60000} min for the same reason)\n`,
    );

    // THE FINDING, NOW INVERTED INTO A REGRESSION PIN.
    //
    // This test was written to RECORD the defect: the pre-warm stamped fifteen
    // minutes and the reader's own refresh re-stamped sixty seconds, so with an
    // hourly cron the row spent ~45 minutes of every hour expiring and re-paging
    // the whole invoice book - the second-most expensive read in the platform,
    // on the same treadmill the dashboard had just been lifted off.
    //
    // listOutstandingDetailed now passes OUTSTANDING_TTL_MS, and the pre-warm
    // derives its stamp from that same constant, so the warmer and the reader
    // cannot disagree. Asserting they AGREE is what keeps it fixed; the old
    // assertion (=== 60s) would now pass only if the defect came back.
    expect(restampedFor).toBe(warmedFor);
    expect(restampedFor).toBeGreaterThan(60_000);
  }, 120_000);
});
