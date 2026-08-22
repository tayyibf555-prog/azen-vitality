import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  __setDentallyBudgetForTests,
  dentallyCeiling,
  runWithDentallyPriority,
  type BudgetConsumer,
} from "@/lib/dentally/budget";
import { DentallyBudgetExceededError } from "@/lib/dentally/client";
import {
  __setDisplayCacheForTests,
  asBackgroundRefresh,
  listAppointments,
  listAppointmentsSafe,
  listDiaryAvailabilitySafe,
  listOutstandingDetailed,
  listPatients,
  listSitePractitionersSafe,
  searchPatients,
  countPatients,
  prewarmOutstanding,
} from "@/lib/dentally/read";
import {
  createDisplayCache,
  jsonRoundTrip,
  type DisplayCacheStore,
} from "@/lib/dentally/display-cache";
import {
  DASHBOARD_CACHE_KEY,
  DASHBOARD_TTL_MS,
  prewarmPracticeDashboard,
  readPracticeDashboard,
} from "@/lib/dashboard/read";
import type { PracticeDashboardView } from "@/lib/dashboard/view";

// ---------------------------------------------------------------------------
// A REFUSAL MUST NOT BE CACHED OVER A GOOD ANSWER.
//
// The seven scans in src/lib/dashboard/read.ts each catch per site and degrade to
// empty/null, which is right for a dead endpoint and wrong for a BUDGET REFUSAL:
// a refusal hits every scan at once, so the assembly it produces is not a partial
// picture but a uniformly blank one — and it was being stamped into the shared L2
// cache as a FRESH fifteen-minute answer, on top of the good value that cache was
// serving a moment earlier. Two paths did it, and both are exercised below:
//
//   prewarmPracticeDashboard   wrote unconditionally, from the BACKGROUND class —
//                              the class refused first, at 60% of the hour. A
//                              refused pre-warm was the normal outcome of a busy
//                              afternoon, and it blanked the screen it exists to
//                              keep fast.
//
//   scheduleRefresh            (display-cache.ts) promotes any result the refresh
//                              function RETURNS. A refresh that degrades instead of
//                              throwing therefore looks like a successful refresh.
//                              Its catch already declines to promote a THROWING
//                              refresh — display-cache.test.ts, "a failed background
//                              refresh does NOT promote and does NOT clobber the
//                              stale row" — so making the refusal throw is all that
//                              was missing. This file re-checks it end to end rather
//                              than trusting the wiring.
//
// The fix is one distinction, borrowed from src/lib/reports/allocation-read.ts: a
// DentallyBudgetExceededError is not an upstream failure and propagates. These tests
// pin BOTH halves of it — a real Dentally failure must still degrade to the
// unavailable panel exactly as before, or the fix has broken the honesty it was
// built to protect.
// ---------------------------------------------------------------------------

const CLIENT = "vitality";
const SITE_IDS = ["site-cc", "site-rv", "site-ng"];
const SITE_CC_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";

// --- The shared L2, recording exactly what the real table records -----------

interface Row {
  value: unknown;
  expiresAt: number;
  /** The `computed_at` column supabaseDisplayCacheStore stamps on every upsert. */
  computedAt: number;
}

interface RecordingStore extends DisplayCacheStore {
  rows: Map<string, Row>;
  writes: number;
  snapshot(clientId: string, cacheKey: string): Row | null;
}

function recordingStore(now: () => number): RecordingStore {
  const rows = new Map<string, Row>();
  const rowKey = (clientId: string, cacheKey: string) => JSON.stringify([clientId, cacheKey]);
  const store: RecordingStore = {
    rows,
    writes: 0,
    snapshot(clientId, cacheKey) {
      const row = rows.get(rowKey(clientId, cacheKey));
      return row ? { ...row } : null;
    },
    async get(clientId, cacheKey) {
      const row = rows.get(rowKey(clientId, cacheKey));
      // Present at ANY age, like the real store: freshness is the cache's job.
      return row ? { value: jsonRoundTrip(row.value), expiresAt: row.expiresAt } : null;
    },
    async set(clientId, cacheKey, value, expiresAtMs) {
      store.writes += 1;
      rows.set(rowKey(clientId, cacheKey), {
        value: jsonRoundTrip(value),
        expiresAt: expiresAtMs,
        computedAt: now(),
      });
    },
    async deleteByPrefix() {
      /* not exercised here */
    },
  };
  return store;
}

// --- A budget with a movable "already spent this hour" figure ---------------

let spent = 0;
/** Flipped mid-run to model the hour running out DURING a scan, not before it. */
let refuseFromNow = false;
/** Refuse only calls whose index falls inside this window, for the one case that
 *  needs a read to succeed either side of a refused group (see the patient record). */
let refuseWindow: [number, number] | null = null;
const budget: BudgetConsumer = async (_priority, limit) => {
  spent += 1;
  if (refuseWindow !== null && spent >= refuseWindow[0] && spent <= refuseWindow[1]) return false;
  if (refuseFromNow) return false;
  return spent <= limit;
};

/** Put the hour past the BACKGROUND ceiling but well inside interactive's. */
function exhaustBackground(): void {
  spent = dentallyCeiling("background") + 1;
}

// --- Clock + background scheduler -------------------------------------------

let clockMs = 0;
const now = () => clockMs;

let scheduled: Array<() => Promise<void>> = [];
/** Models read.ts's afterScheduler: an SWR refresh is BACKGROUND work. */
function scheduleBackground(task: () => Promise<void>): void {
  scheduled.push(asBackgroundRefresh(task));
}
async function flushBackground(): Promise<void> {
  const queued = scheduled;
  scheduled = [];
  for (const task of queued) await task().catch(() => {});
}

let store: RecordingStore;

// --- Upstreams ---------------------------------------------------------------

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The local mock app, driven in process — the same harness dashboard-call-cost.test
 *  uses, so the "good" assembly below is the real one, not a fixture. */
const MOCK_HANDLERS: Record<string, () => Promise<{ GET: (r: Request) => Promise<Response> }>> = {
  "/v1/patients": () => import("@/app/api/mock-dentally/v1/patients/route") as never,
  "/v1/appointments": () => import("@/app/api/mock-dentally/v1/appointments/route") as never,
  "/v1/invoices": () => import("@/app/api/mock-dentally/v1/invoices/route") as never,
  "/v1/payments": () => import("@/app/api/mock-dentally/v1/payments/route") as never,
  "/v1/nhs_claims": () => import("@/app/api/mock-dentally/v1/nhs_claims/route") as never,
  "/v1/practitioners": () => import("@/app/api/mock-dentally/v1/practitioners/route") as never,
  "/v1/treatment_plans": () => import("@/app/api/mock-dentally/v1/treatment_plans/route") as never,
};

function mockAppFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname.replace("/api/mock-dentally", "");
    const load = MOCK_HANDLERS[path];
    if (!load) throw new Error(`no mock handler for ${path}`);
    const mod = await load();
    return mod.GET(new Request(url, { headers: { Authorization: "Bearer probe" } }));
  }) as typeof fetch;
}

/** Every endpoint 500s: a GENUINE Dentally failure, which must degrade as it always did. */
function deadUpstreamFetch(): typeof fetch {
  return (async () => jsonRes({ error: "upstream is down" }, 500)) as typeof fetch;
}

const PATIENT = {
  id: "p1",
  first_name: "Alex",
  last_name: "Berry",
  site_id: SITE_CC_UUID,
  active: true,
};

/** A tiny synthetic upstream for the non-dashboard display reads. */
function smallUpstreamFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname;
    if (path.endsWith("/v1/patients/p1")) return jsonRes({ patient: PATIENT });
    if (path.endsWith("/v1/patients")) return jsonRes({ patients: [PATIENT], meta: { total: 1 } });
    if (path.endsWith("/v1/appointments")) {
      return jsonRes({
        appointments: [
          { id: "a1", patient_id: "p1", start_time: "2026-08-20T09:00:00Z", state: "completed" },
        ],
      });
    }
    if (path.endsWith("/v1/practitioners")) {
      return jsonRes({
        practitioners: [{ id: "pr1", active: true, user: { first_name: "Dee", last_name: "Kaur" } }],
      });
    }
    if (path.endsWith("/v1/availability")) {
      return jsonRes({
        availability: [
          { practitioner_id: "pr1", start_time: "2026-08-20T09:00:00Z", finish_time: "2026-08-20T09:30:00Z" },
        ],
      });
    }
    if (path.endsWith("/v1/invoices")) {
      return jsonRes({
        invoices: [{ id: "i1", patient_id: "p1", amount: 120, amount_outstanding: 120, status: "new" }],
      });
    }
    return jsonRes({}, 404);
  }) as typeof fetch;
}

/**
 * The outstanding book with a debtor the BOOK SCAN CANNOT SEE (p2 owes, only p1 is in
 * the book), so the scan reaches its per-debtor resolve fan-out. The hour runs out the
 * moment the book scan starts, which is the only way to arrive at that fan-out with
 * the scope ALREADY refused — the branch that used to return a partial book.
 */
function debtorResolveUpstreamFetch(): typeof fetch {
  let invoiceCalls = 0;
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname;
    if (path.endsWith("/v1/invoices")) {
      invoiceCalls += 1;
      // A DISTINCT debtor per site, so the scan does not stop early on the
      // ignored-site-filter signature and all three sites are read.
      const site = url.searchParams.get("site_id") ?? "s";
      // The hour runs out exactly HERE: the invoice index is complete, and the whole
      // book scan that follows is refused. That is the only way to arrive at the
      // debtor fan-out with the scope ALREADY refused.
      if (invoiceCalls >= SITE_IDS.length) refuseFromNow = true;
      return jsonRes({
        invoices: [
          { id: `i-${site}`, patient_id: `p-${site}`, amount: 400, amount_outstanding: 400, status: "new" },
        ],
      });
    }
    if (path.endsWith("/v1/patients")) return jsonRes({ patients: [PATIENT], meta: { total: 1 } });
    return jsonRes({}, 404);
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "budget-refusal-not-cached";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid/api/mock-dentally";
  spent = 0;
  refuseFromNow = false;
  refuseWindow = null;
  clockMs = Date.parse("2026-08-20T13:00:00.000Z");
  scheduled = [];
  store = recordingStore(now);
  __setDisplayCacheForTests(createDisplayCache({ store, now, scheduleBackground }));
  __setDentallyBudgetForTests(budget);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __setDisplayCacheForTests(null);
  __setDentallyBudgetForTests(null);
});

// --- Reading the assembled view ---------------------------------------------

function groupScope(view: PracticeDashboardView) {
  const scope = view.scopes.find((s) => s.siteId === null);
  expect(scope, "no all-sites scope").toBeTruthy();
  return scope!;
}

/** The money figures the strip is actually able to source, by period. */
function sourcedTotals(view: PracticeDashboardView): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cell of groupScope(view).strip.cells) {
    if (cell.totalPence !== null) out[cell.period] = cell.totalPence;
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("a budget refusal propagates out of the dashboard assembly", () => {
  it("THROWS instead of assembling a blank dashboard, and the pre-warm never writes", async () => {
    globalThis.fetch = mockAppFetch();
    exhaustBackground();

    await expect(
      runWithDentallyPriority("background", () =>
        prewarmPracticeDashboard(CLIENT, new Date(clockMs), DASHBOARD_TTL_MS),
      ),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);

    // THE POINT OF THE THROW. prewarmPracticeDashboard writes unconditionally; the
    // only thing that stops the write is never reaching it.
    expect(store.writes, "the refused pre-warm wrote to the shared cache").toBe(0);
    expect(store.snapshot(CLIENT, DASHBOARD_CACHE_KEY)).toBeNull();
  }, 60_000);

  it("still degrades a GENUINE Dentally failure to the unavailable view, and caches it", async () => {
    // The distinction the whole change rests on. A 500 from every endpoint has
    // nothing better to offer, so the honest all-unavailable view is both returned
    // and cached, exactly as before.
    globalThis.fetch = deadUpstreamFetch();

    const view = await readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) });

    expect(Object.keys(sourcedTotals(view))).toEqual([]);
    for (const cell of groupScope(view).strip.cells) {
      expect(cell.totalPence).toBeNull();
      expect(cell.unavailableReason).toBeTruthy();
    }
    expect(view.practitioners).toEqual([]);
    expect(store.writes, "an honest upstream failure must still be cached").toBe(1);
  }, 60_000);
});

describe("THE DECIDING SCENARIO: a good cached dashboard survives a refused hour", () => {
  it("keeps serving the good value, and neither promote path overwrites the row", async () => {
    globalThis.fetch = mockAppFetch();

    // 1. A real, unrefused assembly. This is the value the practice is looking at.
    const good = await readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) });
    const goodTotals = sourcedTotals(good);
    expect(
      Object.keys(goodTotals).length,
      "the mock produced no sourceable takings, so this test would prove nothing",
    ).toBeGreaterThan(0);
    expect(good.practitioners.length).toBeGreaterThan(0);
    expect(good.appointments.length).toBeGreaterThan(0);

    const promoted = store.snapshot(CLIENT, DASHBOARD_CACHE_KEY);
    expect(promoted).not.toBeNull();
    const writesAfterGood = store.writes;
    expect(writesAfterGood).toBe(1);

    // 2. The hour turns: background is spent, interactive still has headroom.
    exhaustBackground();

    // 3. THE PRE-WARM TICK. It recomputes unconditionally and stamps L2.
    await expect(
      runWithDentallyPriority("background", () =>
        prewarmPracticeDashboard(CLIENT, new Date(clockMs), DASHBOARD_TTL_MS),
      ),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);
    expect(store.writes, "the pre-warm overwrote the good row").toBe(writesAfterGood);

    // 4. THE READER'S OWN SWR REFRESH. Move past the row's expiry so the next read
    //    serves stale and schedules a background refresh — the second promote path.
    clockMs += DASHBOARD_TTL_MS + 60_000;
    const served = await readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) });
    expect(served, "the stale serve did not hand back the good value").toEqual(jsonRoundTrip(good));
    expect(scheduled.length, "no stale-while-revalidate refresh was scheduled").toBe(1);

    await flushBackground();

    // 5. THE WHOLE POINT. The refused refresh promoted nothing: same value, same
    //    computed_at, same expires_at, same write count.
    const after = store.snapshot(CLIENT, DASHBOARD_CACHE_KEY);
    expect(store.writes, "the refused SWR refresh promoted a blank assembly").toBe(writesAfterGood);
    expect(after?.computedAt).toBe(promoted?.computedAt);
    expect(after?.expiresAt).toBe(promoted?.expiresAt);
    expect(after?.value).toEqual(promoted?.value);

    // 6. And a reader still gets the practice's real figures, not "Unavailable".
    const again = await readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) });
    expect(sourcedTotals(again)).toEqual(goodTotals);
    // Every cell that was sourceable before the refused hour is still sourceable and
    // still carries a figure rather than a reason.
    for (const cell of groupScope(again).strip.cells) {
      if (goodTotals[cell.period] === undefined) continue;
      expect(cell.totalPence).toBe(goodTotals[cell.period]);
      expect(cell.unavailableReason).toBeNull();
    }
    process.stderr.write(
      `\n[budget-refusal-not-cached] good totals survived a refused hour: ${JSON.stringify(goodTotals)}\n`,
    );
  }, 120_000);

  it("without the fix the same row would be blanked: the refused assembly IS blank", async () => {
    // The measurement the defect was reported from, kept as a test so the two halves
    // stay comparable: the SAME upstream, one hour with budget and one without.
    globalThis.fetch = mockAppFetch();
    const withBudget = await readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) });
    expect(Object.keys(sourcedTotals(withBudget)).length).toBeGreaterThan(0);

    exhaustBackground();
    const refused = await runWithDentallyPriority("background", () =>
      prewarmPracticeDashboard(CLIENT, new Date(clockMs), DASHBOARD_TTL_MS),
    ).then(
      () => "assembled",
      (err: unknown) => (err instanceof DentallyBudgetExceededError ? "refused" : "other"),
    );
    // If this ever reads "assembled" again, the blank view is back and the row it
    // would be written over is the one asserted above.
    expect(refused).toBe("refused");
  }, 120_000);
});

describe("a true COLD read under refusal is honest, and is not cached", () => {
  it("serves the unavailable view without promoting it", async () => {
    globalThis.fetch = mockAppFetch();
    exhaustBackground();
    // No row anywhere, and the assembly is refused: there is nothing better to serve,
    // so the reader gets the honest unavailable view rather than a 500 — but it must
    // NOT become the cached answer for the next fifteen minutes.
    const view = await runWithDentallyPriority("background", () =>
      readPracticeDashboard({ clientId: CLIENT, now: new Date(clockMs) }),
    );
    expect(Object.keys(sourcedTotals(view))).toEqual([]);
    expect(view.sites.map((s) => s.id).sort()).toEqual([...SITE_IDS].sort());
    expect(store.writes, "a refused cold assembly was cached").toBe(0);
    expect(store.snapshot(CLIENT, DASHBOARD_CACHE_KEY)).toBeNull();
  }, 60_000);
});

describe("EVERY degrading catch in the assembly separates a refusal from a failure", () => {
  // A BEHAVIOURAL TEST CANNOT REACH ONE SCAN AT A TIME. The budget guard refuses by
  // CLASS, not by endpoint, so a refused hour refuses all seven scans at once and the
  // assembly throws whichever of them is still honest — one scan quietly going back
  // to absorbing the refusal is invisible from the outside (verified: removing the
  // re-throw from the payments catch alone leaves every behavioural test green).
  //
  // So the rule is pinned where it lives. Every `catch (err)` in the assembly that
  // degrades a read must ask rethrowIfBudgetRefused FIRST — which is also the check a
  // scan added next year has to pass.
  it("no catch in src/lib/dashboard/read.ts absorbs a budget refusal", () => {
    const path = "src/lib/dashboard/read.ts";
    const source = readFileSync(join(process.cwd(), path), "utf8");
    const marker = "catch (err) {";

    // The WHOLE block, by brace matching — not a fixed window, which a long comment
    // above the re-throw would silently push out of view.
    const blocks: string[] = [];
    for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
      let depth = 0;
      let end = i + marker.length - 1;
      for (; end < source.length; end += 1) {
        if (source[end] === "{") depth += 1;
        else if (source[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      blocks.push(source.slice(i, end + 1));
    }
    // Six Dentally catches plus the nightly-count read; a scan added without a catch
    // does not degrade at all, which is also fine.
    //
    // IT WAS EIGHT. The NHS claim scan was the fourth copy of the shared per-site
    // block (scanWindowedPerSite) and joined it, so its own `catch (err)` is gone and
    // the ONE catch inside the shared block now covers all four windowed scans —
    // which is a strictly stronger version of this rule, not a weakening of it: the
    // shared catch is still checked below like every other, and a fifth scan added to
    // the block inherits the re-throw instead of having to remember it. The floor
    // moved with the code rather than the rule being relaxed.
    expect(blocks.length, `${path} has no degrading catches left to check`).toBeGreaterThanOrEqual(7);

    for (const block of blocks) {
      // The nightly patient count reads OUR OWN table, so it has no Dentally refusal
      // to separate out. It is the ONLY exemption, and it names itself.
      if (block.includes("nightly patient count read failed")) continue;
      expect(
        // Either form of the same decision: the helper, or the explicit class check
        // readPracticeDashboard's own boundary uses to turn a refusal into an
        // uncached unavailable view.
        block.includes("rethrowIfBudgetRefused(err)") ||
          block.includes("instanceof DentallyBudgetExceededError"),
        `a catch in ${path} degrades a Dentally read without re-throwing a budget ` +
          `refusal, so a refused hour will be cached as a blank panel over the good ` +
          `value:\n${block.slice(0, 240)}`,
      ).toBe(true);
    }
  });

  it("still separates them the way the reports layer already does", () => {
    // The precedent, kept visible: allocation-read.ts branches on the SAME class to
    // stop a refusal being retried. This pass stops it being cached.
    const source = readFileSync(join(process.cwd(), "src/lib/reports/allocation-read.ts"), "utf8");
    expect(source).toContain("err instanceof DentallyBudgetExceededError");
  });
});

describe("the OTHER cached display reads", () => {
  it("listOutstanding: a refused pre-warm leaves the real debtors book in place", async () => {
    globalThis.fetch = smallUpstreamFetch();

    await prewarmOutstanding(SITE_IDS, 60_000);
    const good = store.snapshot(CLIENT, `outstanding:${[...SITE_IDS].sort().join("|")}`);
    expect(good?.value).toBeTruthy();
    expect((good?.value as { rows: unknown[] }).rows.length).toBe(1);
    const writesAfterGood = store.writes;

    exhaustBackground();
    await expect(
      runWithDentallyPriority("background", () => prewarmOutstanding(SITE_IDS, 60_000)),
    ).rejects.toBeInstanceOf(DentallyBudgetExceededError);

    expect(store.writes, "the refused warm stamped an empty book over the real one").toBe(
      writesAfterGood,
    );
    const after = store.snapshot(CLIENT, `outstanding:${[...SITE_IDS].sort().join("|")}`);
    expect(after?.computedAt).toBe(good?.computedAt);
    expect(after?.value).toEqual(good?.value);
  }, 60_000);

  it("listOutstanding: the reader degrades to a stated FLOOR, and caches nothing", async () => {
    globalThis.fetch = smallUpstreamFetch();
    exhaustBackground();
    const read = await runWithDentallyPriority("background", () =>
      listOutstandingDetailed(SITE_IDS),
    );
    // truncated:true, not a confident "nobody owes anything".
    expect(read).toEqual({ rows: [], truncated: true });
    expect(store.writes).toBe(0);
  });

  it("listOutstanding: a refusal during the DEBTOR RESOLVE abandons rather than caches a partial", async () => {
    // The narrow branch: the invoice index succeeded, so there IS a book to return —
    // just one missing every debtor the bounded patient scan did not reach. It used
    // to set `truncated` and return that partial, which prewarmOutstanding then wrote
    // over the complete book. A stated floor is honest to a reader and dishonest to a
    // cache: the row it replaces held the real total.
    globalThis.fetch = debtorResolveUpstreamFetch();

    await expect(
      runWithDentallyPriority("background", () => prewarmOutstanding(SITE_IDS, 60_000)),
    ).rejects.toThrow(/outstanding debtor resolve/);

    expect(store.writes, "a partial debtors book was cached").toBe(0);
    expect(store.snapshot(CLIENT, `outstanding:${[...SITE_IDS].sort().join("|")}`)).toBeNull();
  });

  it("listOutstanding: an UNSCOPED reader's debtor resolve is refused the same way", async () => {
    // Outside a priority scope there IS no scope refusal to consult — dentallyScopeRefused()
    // is always false for a reader — so the guard above cannot fire and the fan-out
    // runs. getPatientById answers null on any error and a null debtor is DROPPED, so
    // without a propagating variant this cached a total missing every debtor the book
    // scan did not reach, and stated it as the practice's whole debt.
    globalThis.fetch = debtorResolveUpstreamFetch();

    const read = await listOutstandingDetailed(SITE_IDS);

    expect(read).toEqual({ rows: [], truncated: true });
    expect(store.writes, "an understated outstanding total was cached").toBe(0);
  });

  it("listPatients / searchPatients / countPatients / listAppointments cache nothing when refused", async () => {
    globalThis.fetch = smallUpstreamFetch();
    exhaustBackground();

    await runWithDentallyPriority("background", async () => {
      // Each still answers exactly what it answered before — the caller sees no new
      // failure mode — but none of these answers reaches the shared cache.
      expect(await listPatients(SITE_IDS)).toEqual([]);
      expect(await searchPatients(SITE_IDS, "berry")).toEqual([]);
      expect(await countPatients(SITE_IDS)).toBeNull();
      expect(await listAppointments(SITE_IDS, { from: "2026-08-20", to: "2026-08-20" })).toEqual([]);
    });

    expect(store.writes, "a refused read was promoted into the shared cache").toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it("the three Safe reads already refuse to cache a failure, refusal included", async () => {
    // listAppointmentsSafe, listSitePractitionersSafe and listDiaryAvailabilitySafe
    // promote only a CLEAN read, so a refusal sets their failure flags and is never
    // cached. Unchanged by this pass; pinned so it stays that way.
    globalThis.fetch = smallUpstreamFetch();
    exhaustBackground();

    await runWithDentallyPriority("background", async () => {
      const appts = await listAppointmentsSafe(SITE_IDS, { from: "2026-08-20", to: "2026-08-20" });
      expect(appts.failed).toBe(true);
      expect(appts.failedSiteIds.sort()).toEqual([...SITE_IDS].sort());

      const pracs = await listSitePractitionersSafe("site-cc");
      expect(pracs.failed).toBe(true);

      // A FUTURE day, derived from the clock rather than written down. Dentally
      // refuses an availability window that is not in the future, so the read
      // does not issue a call at all for a day that has ended -- and a fixed date
      // here would therefore stop testing the refusal the moment it went by.
      const futureDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(
        new Date(Date.now() + 2 * 86_400_000),
      );
      const avail = await listDiaryAvailabilitySafe({
        siteId: "site-cc",
        practitionerIds: ["pr1"],
        fromDayKey: futureDay,
        toDayKey: futureDay,
      });
      expect(avail.failed).toBe(true);
    });

    expect(store.writes).toBe(0);
  });
});
