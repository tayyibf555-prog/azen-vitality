import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// WHAT ONE COLD DASHBOARD COSTS THE PRACTICE, IN DENTALLY REQUESTS.
//
// Dentally allows this practice 3,600 requests an hour. On 2026-08-20 assembling
// this one screen, four times an hour on a cron, spent all of them: every read
// from production answered 403 "Rate limit exceeded" for the working day.
//
// So the assembly's cost is a number this repo has to know, and a number a change
// has to be able to move deliberately rather than by accident. Two measurements:
//
//   AT MOCK VOLUME  — the local mock is capacity-derived and small (roughly one
//                     page of patients and plans per site), so it measures the
//                     scans that are expensive at ANY size.
//
//                     THIS USED TO SAY those were "the backward walks through
//                     payments and NHS claims, which Dentally will not filter by
//                     date and which therefore have to be paged". Dentally DOES
//                     filter both (start_date/end_date on payments, after/before on
//                     nhs_claims — live-probed 2026-08-21), and the walks were not
//                     only expensive, they were wrong: the practice owner found the
//                     takings 38% short over thirty days and 85% short over ninety.
//                     Payments now costs ONE request per site per period, because
//                     the windowed total is in meta.total_amount.
//
//   AT LIVE VOLUME  — the mock cannot show the cost that actually caused the
//                     incident, because that cost only appears on a book with
//                     ~51,000 patients and ~85,000 treatment plans, where the
//                     unfiltered scans ran to their 40-page cap on every site.
//                     So a synthetic upstream is sized to those figures and the
//                     narrowed scan is measured against a control walk that does
//                     what the code used to do.
//
// The laptop's IP is blocked by Dentally (403 on every request), so neither
// figure is a live probe and neither is presented as one.
// ---------------------------------------------------------------------------

const SITES = 3;
/** src/lib/dashboard/read.ts SCAN_MAX_PAGES — the per-site page cap on every scan. */
const SCAN_MAX_PAGES = 40;
const PER_PAGE = 100;

type Counter = { total: number; byPath: Map<string, number> };

function newCounter(): Counter {
  return { total: 0, byPath: new Map() };
}

function record(counter: Counter, path: string): void {
  counter.total += 1;
  counter.byPath.set(path, (counter.byPath.get(path) ?? 0) + 1);
}

function report(label: string, counter: Counter): void {
  const rows = [...counter.byPath.entries()].sort((a, b) => b[1] - a[1]);
  process.stderr.write(`\n[dashboard-call-cost] ${label}: ${counter.total} upstream requests ${JSON.stringify(rows)}\n`);
}

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "dashboard-call-cost";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid/api/mock-dentally";
});

// --- Measurement 1: the real local mock, driven in process ------------------

const MOCK_HANDLERS: Record<string, () => Promise<{ GET: (r: Request) => Promise<Response> }>> = {
  "/v1/patients": () => import("@/app/api/mock-dentally/v1/patients/route") as never,
  "/v1/appointments": () => import("@/app/api/mock-dentally/v1/appointments/route") as never,
  "/v1/invoices": () => import("@/app/api/mock-dentally/v1/invoices/route") as never,
  "/v1/payments": () => import("@/app/api/mock-dentally/v1/payments/route") as never,
  "/v1/nhs_claims": () => import("@/app/api/mock-dentally/v1/nhs_claims/route") as never,
  "/v1/practitioners": () => import("@/app/api/mock-dentally/v1/practitioners/route") as never,
  "/v1/treatment_plans": () => import("@/app/api/mock-dentally/v1/treatment_plans/route") as never,
};

describe("one cold dashboard assembly, at mock volume", () => {
  it("stays inside its measured request budget", async () => {
    const counter = newCounter();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const path = url.pathname.replace("/api/mock-dentally", "");
      record(counter, path);
      const load = MOCK_HANDLERS[path];
      if (!load) throw new Error(`dashboard-call-cost: no mock handler for ${path}`);
      const mod = await load();
      return mod.GET(new Request(url, { headers: { Authorization: "Bearer probe" } }));
    }) as typeof fetch;

    const { readPracticeDashboard } = await import("./read");
    await readPracticeDashboard({ clientId: "vitality", now: new Date() });
    report("mock volume", counter);

    // A ceiling, not an equality: the mock's fixtures are generated from rostered
    // clinical minutes and move with the calendar. What must not happen is a change
    // that quietly doubles the cost of the most expensive screen in the platform.
    expect(counter.total).toBeLessThanOrEqual(120);

    // At this volume the patient and plan books fit in a page a site, so those scans
    // are already minimal here and the cost is the two backward walks Dentally will
    // not let us filter (see client.ts listPayments / listNhsClaims). That is why the
    // live-volume measurement below exists.
    expect(counter.byPath.get("/v1/patients")).toBeLessThanOrEqual(SITES * 2);
    expect(counter.byPath.get("/v1/treatment_plans")).toBeLessThanOrEqual(SITES * 2);

    // THE TAKINGS READ IS NOW A FIXED, SIZE-INDEPENDENT COST: one request per site
    // per period, whatever the book. It cannot drift back into a walk without this
    // number moving, which is the whole point of pinning it.
    expect(counter.byPath.get("/v1/payments")).toBe(SITES * 5);
  }, 120_000);
});

// --- Measurement 2: a synthetic upstream sized to the live book -------------
//
// Live figures, from this repo's own read-only probes (recorded in client.ts and in
// the retired /api/sync/dentally route): ~51,000 patients across three sites, and
// ~85,000 treatment plans. Both indexes are paged 100 rows at a time and NEITHER is
// date-ordered, so an unfiltered walk is a walk through the whole book.
//
// The upstream below models exactly the property the fix depends on: `updated_after`
// is honoured server-side, so asking for the last 90 days returns a few hundred rows
// instead of tens of thousands. Everything else returns one short page, so the two
// scans under test are isolated.

function liveVolumeFetch(counter: Counter): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname.replace("/api/mock-dentally", "");
    record(counter, path);
    const page = Number(url.searchParams.get("page") ?? "1");
    const narrowed = url.searchParams.has("updated_after");

    const body = (key: string): Response => {
      // Narrowed: 250 rows a site (three pages). Unfiltered: the whole book, which
      // no page budget reaches — every page comes back full, for ever.
      const remaining = narrowed ? Math.max(0, 250 - (page - 1) * PER_PAGE) : PER_PAGE;
      const rows = Array.from({ length: Math.min(PER_PAGE, remaining) }, (_, i) => ({
        id: `${key}-${page}-${i}`,
      }));
      return new Response(JSON.stringify({ [key]: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    if (path === "/v1/patients") return body("patients");
    if (path === "/v1/treatment_plans") return body("treatment_plans");
    const empty: Record<string, string> = {
      "/v1/appointments": "appointments",
      "/v1/invoices": "invoices",
      "/v1/payments": "payments",
      "/v1/nhs_claims": "nhs_claims",
      "/v1/practitioners": "practitioners",
    };
    const key = empty[path];
    if (!key) throw new Error(`dashboard-call-cost: unexpected path ${path}`);
    return new Response(JSON.stringify({ [key]: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("one cold dashboard assembly, at live volume", () => {
  it("stops the patient and plan scans early instead of running them to the page cap", async () => {
    const counter = newCounter();
    globalThis.fetch = liveVolumeFetch(counter);

    const { readPracticeDashboard } = await import("./read");
    await readPracticeDashboard({ clientId: "vitality", now: new Date() });
    report("live volume", counter);

    // THE CONTROL: what these two scans cost before they carried `updated_after`.
    // On a book this size no page is ever short, so the walk runs to the cap on
    // every site — 40 pages x 3 sites, twice over, for two small counts.
    const controlPerScan = SCAN_MAX_PAGES * SITES;
    expect(controlPerScan).toBe(120);

    // AFTER: 250 rows a site is three pages, and the third is short, so the walk
    // stops itself.
    expect(counter.byPath.get("/v1/patients")).toBe(SITES * 3);
    expect(counter.byPath.get("/v1/treatment_plans")).toBe(SITES * 3);

    const saved = 2 * controlPerScan - (SITES * 3) * 2;
    process.stderr.write(
      `[dashboard-call-cost] live volume: patients + plans ${2 * controlPerScan} -> ${SITES * 6} requests (${saved} saved per assembly)\n`,
    );
    expect(saved).toBe(222);
  }, 120_000);

  it("proves the control is real: an unfiltered walk never short-pages on a live-size book", async () => {
    // Without the narrowing there is no natural stopping point — the ONLY thing that
    // ends the walk is the page cap, which is why the old scan cost 40 requests a
    // site and returned an arbitrary 4,000 of ~17,000 rows, counted, and printed the
    // result as fact.
    const counter = newCounter();
    globalThis.fetch = liveVolumeFetch(counter);
    const { dentallyFromEnv } = await import("@/lib/dentally/read");
    const client = dentallyFromEnv();
    let shortPage = false;
    for (let page = 1; page <= SCAN_MAX_PAGES; page += 1) {
      const res = await client.listPatients({ siteId: "site-ng", page, perPage: PER_PAGE });
      if ((res.patients ?? []).length < PER_PAGE) {
        shortPage = true;
        break;
      }
    }
    expect(shortPage).toBe(false);
    expect(counter.byPath.get("/v1/patients")).toBe(SCAN_MAX_PAGES);
  }, 120_000);
});
