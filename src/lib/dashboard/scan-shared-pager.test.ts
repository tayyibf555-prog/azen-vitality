import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// F3 — THE LAST THREE HAND-ROLLED WALKS ARE ON THE SHARED PAGER.
//
// The claim and invoice scans were migrated onto `pageAll` (src/lib/reports/scan.ts)
// and the appointment, patient and plan scans were left behind, each still walking
// its own forty pages with its own copy of the same stop. Two things followed:
//
//   COST     a book bigger than the budget was paged to the cap on every site before
//            the panel could say the one sentence it was always going to say — up to
//            3 scans x 3 sites x 40 pages = 360 requests an assembly, against the
//            3,600/hour ceiling an over-eager cron emptied for a whole working day on
//            2026-08-20. `meta.total` arrives with page ONE, so the verdict is known
//            after one request.
//
//   TRUTH    a hand-rolled walk that ends on a SHORT PAGE calls itself complete. It
//            has nothing to check that against. When the endpoint publishes a count
//            and the walk came up short of it, the rows are missing and the old loop
//            could not tell — it would have counted them and printed the figure.
//
// WHICH ENDPOINTS ACTUALLY PUBLISH `meta.total`, as this repo knows it today:
//   /v1/patients        YES on live — countPatients (client.ts) reads a site's exact
//                       patient count off a one-row page of it. The local mock does
//                       not, so dev exercises the short-page path.
//   /v1/treatment_plans the local mock publishes `{ total, page }`; live UNVERIFIED.
//   /v1/appointments    no probe of live has recorded one, and the mock publishes
//                       none.
// The migration does not depend on the answer: with no meta the short-page stop is
// the whole story and the read costs exactly what it always did. That is the control
// at the bottom of this file.
// ---------------------------------------------------------------------------

const SITES = 3;
/** src/lib/dashboard/read.ts SCAN_MAX_PAGES and PER_PAGE. */
const SCAN_MAX_PAGES = 40;
const PER_PAGE = 100;

const NOW = new Date("2026-08-20T10:00:00Z");
const IN_WINDOW = "2026-08-19";

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "scan-shared-pager";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid";
});

interface Counter {
  byPath: Map<string, number>;
}
const newCounter = (): Counter => ({ byPath: new Map() });
const count = (c: Counter, path: string) => c.byPath.get(path) ?? 0;

/**
 * One row that WOULD produce a confident number if a truncation were absorbed: a
 * registration date, a plan start date and an appointment start, all inside the
 * window. Without them an honest blank and a silently short count look the same and
 * the assertions below would pass for the wrong reason.
 */
function row(key: string, page: number, i: number): Record<string, unknown> {
  return {
    id: `${key}-${page}-${i}`,
    created_at: IN_WINDOW,
    accepted_at: IN_WINDOW,
    completed_at: null,
    start_time: `${IN_WINDOW}T09:00:00+01:00`,
    state: "completed",
  };
}

/**
 * An upstream where the named resources answer with `pageSize` rows for ever and
 * publish `total` in the envelope. Everything else answers one empty page.
 */
function pagedFetch(
  counter: Counter,
  opts: { keys: readonly string[]; pageSize: number; total: number | null },
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = url.pathname.split("/").pop() ?? "";
    counter.byPath.set(url.pathname, count(counter, url.pathname) + 1);
    const page = Number(url.searchParams.get("page") ?? "1");
    const mine = opts.keys.includes(key);
    const rows = mine ? Array.from({ length: opts.pageSize }, (_, i) => row(key, page, i)) : [];
    const body: Record<string, unknown> = { [key]: rows };
    if (opts.total !== null) body["meta"] = { total: opts.total, current_page: page };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

type View = import("@/lib/dashboard/view").PracticeDashboardView;
function group(view: View) {
  const scope = view.scopes.find((s) => s.siteId === null);
  expect(scope).toBeTruthy();
  return scope!;
}

async function assemble(): Promise<View> {
  const { readPracticeDashboard } = await import("./read");
  return readPracticeDashboard({ clientId: "vitality", now: NOW });
}

describe("F3: a scan Dentally has already declared unreadable stops on page one", () => {
  it("costs ONE request a site, not forty, and still blanks the three panels", async () => {
    const counter = newCounter();
    globalThis.fetch = pagedFetch(counter, {
      keys: ["appointments", "patients", "treatment_plans"],
      pageSize: PER_PAGE,
      // One row more than 40 pages of 100 can carry: the read CANNOT come out whole,
      // and the envelope says so on page one.
      total: SCAN_MAX_PAGES * PER_PAGE + 1,
    });

    const view = await assemble();

    // THE COST. The hand-rolled walks paid 40 x 3 for each of these before saying the
    // same sentence. The pinned numbers went DOWN on this change, deliberately.
    expect(count(counter, "/v1/appointments"), "the appointment walk is still paging to its cap").toBe(SITES);
    expect(count(counter, "/v1/patients")).toBe(SITES);
    expect(count(counter, "/v1/treatment_plans")).toBe(SITES);

    // THE VERDICT, UNCHANGED. Withheld, not shortened.
    const panels = group(view).periods.last30;
    expect(panels.appointments.total.value).toBeNull();
    expect(panels.patients.newCount.value).toBeNull();
    expect(panels.plans.started.value).toBeNull();
  }, 120_000);
});

describe("F3: a walk that ends on a short page is checked against the count", () => {
  it("withholds the figures when fewer rows arrived than Dentally says exist", async () => {
    // THE CASE A HAND-ROLLED LOOP CANNOT SEE. Half a page arrives, so the walk stops —
    // and the old loop called that a complete read, because a short page was the only
    // thing it had to go on. The envelope says 500 rows match. 50 of 500 is a slice,
    // and a slice must not be counted.
    const counter = newCounter();
    globalThis.fetch = pagedFetch(counter, {
      keys: ["appointments", "patients", "treatment_plans"],
      pageSize: 50,
      total: 500,
    });

    const view = await assemble();

    expect(count(counter, "/v1/patients"), "the short page ended the walk, as it should").toBe(SITES);
    const panels = group(view).periods.last30;
    expect(panels.patients.newCount.value, "50 of 500 patients counted as a total").toBeNull();
    expect(panels.plans.started.value, "50 of 500 plans counted as a total").toBeNull();
    expect(panels.appointments.total.value, "50 of 500 appointments counted as a total").toBeNull();
  }, 120_000);

  it("CONTROL: the same short page with no count published is a complete read", async () => {
    // The endpoints that publish nothing (today: /v1/appointments, and
    // /v1/treatment_plans on live as far as this repo knows) must keep working
    // exactly as they did — the fix must not turn every readable panel off.
    const counter = newCounter();
    globalThis.fetch = pagedFetch(counter, {
      keys: ["appointments", "patients", "treatment_plans"],
      pageSize: 50,
      total: null,
    });

    const view = await assemble();

    expect(count(counter, "/v1/patients")).toBe(SITES);
    const panels = group(view).periods.last30;
    expect(panels.patients.newCount.value, "a complete read produced no number").toBe(50 * SITES);
    expect(panels.plans.started.value).toBe(50 * SITES);
    expect(panels.appointments.total.value).toBe(50 * SITES);
  }, 120_000);
});
