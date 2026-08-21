import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// THE TAKINGS TOTAL MUST NOT DEPEND ON THE ORDER DENTALLY HANDS US ROWS IN.
//
// The practice owner found the dashboard understating her takings: last 30 days
// read £16,997.10 against Dentally's own £27,240.90, and last 90 days £17,012.10
// against £114,429.78. The cause was a scan that paged /v1/payments "newest first"
// and stopped once a row fell outside the window, on the documented belief that the
// endpoint would not filter by date.
//
// Both halves of that belief were false, and this file is built out of the second
// one, because it is the half no amount of care in the caller could have survived:
// /v1/payments IS NOT ORDERED BY DATE. It is ordered by id, so a payment entered
// today for work done two years ago sits wherever its id falls. On the real site
// N15 page 1 spans 2026-08-11..21, page 20 spans 2023-09-14..2026-03-31, page 40
// spans 2025-10-15..23 and page 41 spans 2024-09-20..2025-10-16.
//
// So THE FIXTURE BELOW IS DELIBERATELY SHUFFLED in exactly that shape: an ancient
// payment sits on page one, and in-window payments sit far past where any backwards
// walk would have stopped. Three things are then proved against it:
//
//   1. the assembled strip's money equals an independently computed exact total;
//   2. the SAME rows, re-shuffled, produce the SAME totals (order is irrelevant);
//   3. THE CONTROL — the old algorithm, run over this same fixture, is short. If
//      that control ever stopped being short, this fixture would have stopped
//      modelling the bug and the other two assertions would be passing for free.
// ---------------------------------------------------------------------------

const PER_PAGE = 100;
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Fixed clock, so every window below is a fixed set of days. */
const NOW = new Date("2026-08-21T10:00:00.000Z");
const TODAY = "2026-08-21";

const SITE_UUIDS: Record<string, string> = {
  "site-cc": "3286d822-68c5-48ff-b1a2-065780dfcd15",
  "site-rv": "c9b87b78-96e6-4f3d-aa8b-e1b953ae79cf",
  "site-ng": "5855c8c1-2c3b-46c3-8c0f-36a9a774d2e6",
};
const SITE_BY_UUID = new Map(Object.entries(SITE_UUIDS).map(([id, uuid]) => [uuid, id]));

interface Row {
  id: string;
  site: string;
  day: string;
  pence: number;
  deleted: boolean;
}

function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A payment book whose ids run in an order that has NOTHING to do with its dates.
 *
 * `daysBack` walks a deterministic non-monotonic sequence so that recent, mid-window
 * and years-old payments are interleaved throughout the index — the property the real
 * endpoint has and the old scan assumed away. Two rows are pinned by hand:
 *
 *   - row 0 is EIGHT HUNDRED DAYS OLD and therefore the very first thing a
 *     backwards walk sees, which is what made the old walk stop on page one;
 *   - a late row sits INSIDE today's window at index 3,500, far beyond the 4,000-row
 *     reach of a 40-page walk that stopped early.
 */
function buildBook(rowCount: number, salt: number): Row[] {
  const sites = Object.keys(SITE_UUIDS);
  const rows: Row[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    // A cheap deterministic scatter: co-prime strides mean consecutive ids land on
    // wildly different days, exactly like a book that accepts backdated entries.
    const daysBack = i === 0 ? 800 : ((i * 617 + salt * 29) % 900);
    rows.push({
      id: `pay-${salt}-${i}`,
      site: sites[i % sites.length]!,
      day: shiftDay(TODAY, -daysBack),
      // Distinct, awkward amounts so a dropped or double-counted row cannot cancel out.
      pence: 1_000 + ((i * 37) % 9_000),
      deleted: i % 61 === 0,
    });
  }
  // The row a truncated walk can never reach, on a day inside every window but the
  // single-day ones.
  rows[3_500] = { id: `pay-${salt}-deep`, site: "site-cc", day: shiftDay(TODAY, -3), pence: 123_456, deleted: false };
  return rows;
}

/** Whole pence -> the decimal string Dentally puts in meta.total_amount. */
function amountString(pence: number): string {
  const fixed = (pence / 100).toFixed(2);
  return fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
}

interface Seen {
  paymentQueries: URLSearchParams[];
  claimQueries: URLSearchParams[];
  paymentPages: number;
}

/**
 * An upstream that behaves like the REAL /v1/payments: it honours start_date and
 * end_date inclusively on `dated_on`, publishes meta.total and meta.total_amount for
 * the filtered set, and serves rows in ID ORDER — never date order.
 */
function bookFetch(book: readonly Row[], seen: Seen, opts: { deadSite?: string } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    if (path.endsWith("/v1/payments")) {
      seen.paymentQueries.push(url.searchParams);
      seen.paymentPages += 1;
      const siteUuid = url.searchParams.get("site_id");
      const site = siteUuid === null ? null : SITE_BY_UUID.get(siteUuid) ?? null;
      if (opts.deadSite !== undefined && site === opts.deadSite) {
        return new Response("upstream is sick", { status: 500 });
      }
      const start = url.searchParams.get("start_date");
      const end = url.searchParams.get("end_date");
      const matching = book.filter(
        (r) =>
          (site === null || r.site === site) &&
          (start === null || r.day >= start) &&
          (end === null || r.day <= end),
      );
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "100");
      const from = (page - 1) * perPage;
      return json({
        payments: matching.slice(from, from + perPage).map((r) => ({
          id: r.id,
          amount: amountString(r.pence),
          dated_on: r.day,
          deleted: r.deleted,
          site_id: SITE_UUIDS[r.site],
        })),
        meta: {
          total: matching.length,
          current_page: page,
          total_amount: amountString(matching.reduce((n, r) => n + r.pence, 0)),
        },
      });
    }

    if (path.endsWith("/v1/nhs_claims")) {
      seen.claimQueries.push(url.searchParams);
      return json({ nhs_claims: [], meta: { total: 0, current_page: 1, total_pages: 0 } });
    }

    const key = path.split("/").pop() ?? "";
    return json({ [key]: [], meta: { total: 0, current_page: 1, total_pages: 0 } });
  }) as typeof fetch;
}

function newSeen(): Seen {
  return { paymentQueries: [], claimQueries: [], paymentPages: 0 };
}

/** The exact answer, computed here and not by the code under test. */
function expectedPence(book: readonly Row[], daysBack: number, site?: string): number {
  const from = shiftDay(TODAY, -daysBack);
  return book
    .filter((r) => r.day >= from && r.day <= TODAY && (site === undefined || r.site === site))
    .reduce((n, r) => n + r.pence, 0);
}

type View = import("@/lib/dashboard/view").PracticeDashboardView;

function stripOf(view: View, siteId: string | null) {
  const scope = view.scopes.find((s) => s.siteId === siteId);
  expect(scope, `no scope for ${siteId ?? "the group"}`).toBeTruthy();
  return scope!.strip;
}

function totalsOf(view: View, siteId: string | null): Record<string, number | null> {
  return Object.fromEntries(stripOf(view, siteId).cells.map((c) => [c.period, c.totalPence]));
}

function reasonsOf(view: View, siteId: string | null): Record<string, string | null> {
  return Object.fromEntries(stripOf(view, siteId).cells.map((c) => [c.period, c.unavailableReason]));
}

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "takings-window-exact";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid";
});

describe("the takings read asks Dentally for the window", () => {
  it("sends start_date and end_date on every payments request, and never pages for a total", async () => {
    const book = buildBook(6_000, 1);
    const seen = newSeen();
    globalThis.fetch = bookFetch(book, seen);

    const { readPracticeDashboard } = await import("./read");
    await readPracticeDashboard({ clientId: "vitality", now: NOW });

    expect(seen.paymentQueries.length).toBeGreaterThan(0);
    for (const q of seen.paymentQueries) {
      // THE FIX, IN ONE ASSERTION. The old read sent site_id and page only.
      expect(q.get("start_date"), "a payments read without start_date is a whole-index read").toBeTruthy();
      expect(q.get("end_date"), "a payments read without end_date runs to today-or-later").toBeTruthy();
      expect(q.get("start_date")! <= q.get("end_date")!).toBe(true);
      // One row, because the answer is in meta. Anything larger is paging for a total.
      expect(q.get("per_page")).toBe("1");
      expect(q.get("page")).toBe("1");
    }

    // Three sites x five periods, and not one request more. The walk it replaced cost
    // up to forty pages a site.
    expect(seen.paymentPages).toBe(15);
  }, 120_000);

  it("asks for exactly the five windows the strip shows, per site", async () => {
    const book = buildBook(2_000, 2);
    const seen = newSeen();
    globalThis.fetch = bookFetch(book, seen);

    const { readPracticeDashboard } = await import("./read");
    await readPracticeDashboard({ clientId: "vitality", now: NOW });

    const windows = new Set(seen.paymentQueries.map((q) => `${q.get("start_date")}..${q.get("end_date")}`));
    expect([...windows].sort()).toEqual(
      [
        `${TODAY}..${TODAY}`,
        `${shiftDay(TODAY, -1)}..${shiftDay(TODAY, -1)}`,
        `${shiftDay(TODAY, -6)}..${TODAY}`,
        `${shiftDay(TODAY, -29)}..${TODAY}`,
        `${shiftDay(TODAY, -89)}..${TODAY}`,
      ].sort(),
    );
  }, 120_000);
});

describe("a date-SHUFFLED payment index still totals exactly", () => {
  it("every period matches an independently computed exact total", async () => {
    const book = buildBook(6_000, 1);
    globalThis.fetch = bookFetch(book, newSeen());

    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: NOW });

    // The group, and one site on its own: a per-site scope must be exact too, since
    // that is the view the practice manager actually reads.
    expect(totalsOf(view, null)).toEqual({
      today: expectedPence(book, 0),
      yesterday: expectedPence(book, 1) - expectedPence(book, 0),
      last7: expectedPence(book, 6),
      last30: expectedPence(book, 29),
      last90: expectedPence(book, 89),
    });
    expect(totalsOf(view, "site-cc")).toEqual({
      today: expectedPence(book, 0, "site-cc"),
      yesterday: expectedPence(book, 1, "site-cc") - expectedPence(book, 0, "site-cc"),
      last7: expectedPence(book, 6, "site-cc"),
      last30: expectedPence(book, 29, "site-cc"),
      last90: expectedPence(book, 89, "site-cc"),
    });
    // Every cell sourced. A null here would mean the strip quietly went blank.
    expect(Object.values(reasonsOf(view, null))).toEqual([null, null, null, null, null]);
  }, 120_000);

  it("re-shuffling the SAME rows changes nothing", async () => {
    // Same money, different ids, therefore a different page order upstream. If any of
    // the answer still came from where a row happened to sit, this would move.
    const book = buildBook(6_000, 1);
    globalThis.fetch = bookFetch(book, newSeen());
    const { readPracticeDashboard } = await import("./read");
    const first = totalsOf(await readPracticeDashboard({ clientId: "vitality", now: NOW }), null);

    const reshuffled = [...book].sort((a, b) => (a.id < b.id ? 1 : -1));
    globalThis.fetch = bookFetch(reshuffled, newSeen());
    const second = totalsOf(await readPracticeDashboard({ clientId: "vitality", now: NOW }), null);

    expect(second).toEqual(first);
  }, 120_000);

  it("THE CONTROL: the algorithm this replaced is short on this very fixture", async () => {
    // Page newest-first, stop once a row falls outside the window — exactly what
    // src/lib/dashboard/read.ts did until 2026-08-21 — over the same shuffled book.
    // Row 0 is 800 days old, so the walk stops on page one and reports a total that
    // is a small fraction of the truth. THIS is the failure the practice owner saw.
    const book = buildBook(6_000, 1);
    const boundary = shiftDay(TODAY, -89);
    const site = "site-cc";
    const own = book.filter((r) => r.site === site);

    let walked = 0;
    let oldestSeen: string | null = null;
    for (let page = 1; page <= 40; page += 1) {
      const rows = own.slice((page - 1) * PER_PAGE, page * PER_PAGE);
      for (const r of rows) {
        walked += r.day >= boundary && r.day <= TODAY ? r.pence : 0;
        if (oldestSeen === null || r.day < oldestSeen) oldestSeen = r.day;
      }
      if (rows.length < PER_PAGE) break;
      if (oldestSeen !== null && oldestSeen < boundary) break;
    }

    const truth = expectedPence(book, 89, site);
    expect(truth).toBeGreaterThan(0);
    expect(walked, "the fixture no longer models the bug it exists to catch").toBeLessThan(truth * 0.5);

    // And the fixed read gets the truth from the same book.
    globalThis.fetch = bookFetch(book, newSeen());
    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: NOW });
    expect(totalsOf(view, site).last90).toBe(truth);
    process.stderr.write(
      `[takings-window-exact] control (old backwards walk) ${walked}p vs truth ${truth}p on the same book\n`,
    );
  }, 120_000);
});

describe("what it says when it cannot read a site", () => {
  it("blanks the group total rather than silently dropping a practice", async () => {
    const book = buildBook(2_000, 3);
    globalThis.fetch = bookFetch(book, newSeen(), { deadSite: "site-rv" });

    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: NOW });

    // The group cannot be stated at all: two practices out of three is not a group.
    expect(Object.values(totalsOf(view, null))).toEqual([null, null, null, null, null]);
    for (const reason of Object.values(reasonsOf(view, null))) {
      expect(reason).toContain("could not be read");
    }
    // The sites that DID answer keep their exact figures — one dead endpoint costs
    // its own panel, not the page.
    expect(totalsOf(view, "site-cc").last30).toBe(expectedPence(book, 29, "site-cc"));
    expect(totalsOf(view, "site-rv").last30).toBeNull();
  }, 120_000);

  it("an unreadable meta reports unavailable, never zero", async () => {
    // A zero on a takings screen is acted on. An envelope we cannot read is not a
    // quiet day and must never render as one.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const key = url.pathname.split("/").pop() ?? "";
      const body =
        key === "payments"
          ? { payments: [], meta: { total: 4, current_page: 1, total_amount: "not a number" } }
          : { [key]: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const { readPracticeDashboard } = await import("./read");
    const view = await readPracticeDashboard({ clientId: "vitality", now: NOW });
    expect(Object.values(totalsOf(view, null))).toEqual([null, null, null, null, null]);
  }, 120_000);
});

describe("the NHS claim read does not copy the payments parameters", () => {
  it("sends after/before and NEVER start_date/end_date", async () => {
    // start_date/end_date are ACCEPTED on /v1/nhs_claims and match nothing — every
    // range, including 2000..2030, returns zero rows. Sending them would blank the
    // whole UDA block while looking like a working filter.
    const seen = newSeen();
    globalThis.fetch = bookFetch(buildBook(500, 4), seen);

    const { readPracticeDashboard } = await import("./read");
    await readPracticeDashboard({ clientId: "vitality", now: NOW });

    expect(seen.claimQueries.length).toBeGreaterThan(0);
    for (const q of seen.claimQueries) {
      expect(q.get("after"), "the claim scan must narrow to the contract year").toBeTruthy();
      expect(q.get("before")).toBeTruthy();
      expect(q.get("start_date"), "start_date on /v1/nhs_claims matches nothing").toBeNull();
      expect(q.get("end_date")).toBeNull();
    }
  }, 120_000);
});
