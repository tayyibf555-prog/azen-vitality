import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// THE FLAGSHIP REPORTS MUST NOT DEPEND ON THE ORDER DENTALLY HANDS US ROWS IN.
//
// src/lib/reports/flagship-read.ts totalled Report A and Report B by paging
// /v1/nhs_claims and /v1/payments BACKWARDS until a row fell past the window's first
// day, on a documented premise it shared with the dashboard: "these endpoints are
// date-unfilterable and newest-first". The dashboard's copy of that belief was
// caught by the practice owner — last 90 days read £17,012.10 against Dentally's own
// £114,429.78 — and this file is the reports-side pin for the same two facts, proven
// live on 2026-08-21:
//
//   1. THE INDEXES ARE NOT DATE-ORDERED. They are ordered by id, so a claim
//      submitted today for a course closed two years ago, or a backdated payment,
//      sits wherever its id falls. On site N15, /v1/payments page 1 spans
//      2026-08-11..21 while page 20 spans 2023-09-14..2026-03-31. A backwards walk
//      therefore stops on page ONE and never sees the in-window rows deeper in.
//
//   2. THE FILTERS WORK, UNDER DIFFERENT NAMES PER ENDPOINT — and the wrong pair is
//      not inert, it is a TRAP: start_date/end_date on /v1/nhs_claims is accepted
//      and matches nothing for every range. Sending the payments parameters there
//      would empty Report A while looking like a working filter.
//
// The fixtures below are deliberately shuffled in exactly that shape: an ancient row
// sits on page one, and an in-window row sits far past where any backwards walk could
// have stopped. The upstream honours only the parameters LIVE honours, reproduces the
// claims trap exactly, and serves rows in ID ORDER — never date order.
//
// SIBLING FILE. flagship-window-exact.test.ts pins the same two facts over a
// LAST-MONTH window; this one runs a LAST-30 window and carries the half that file
// does not: what the reports say when a read cannot be completed. `meta.total` is the
// only thing that can tell "the scan finished" from "the scan stopped" on an index
// that is not date-ordered, so every completeness rule — including Report C's, which
// never had the walk bug but did trust a short page — is pinned here.
// ---------------------------------------------------------------------------

const PER_PAGE = 100;
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const NOW = new Date("2026-08-21T10:00:00.000Z");
const TODAY = "2026-08-21";

function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
}

/** The report window under test: the last 30 days, the shape Blerta runs monthly. */
const WINDOW = { from: shiftDay(TODAY, -29), to: TODAY };

const SITE_UUIDS: Record<string, string> = {
  "site-cc": "3286d822-68c5-48ff-b1a2-065780dfcd15",
  "site-rv": "c9b87b78-96e6-4f3d-aa8b-e1b953ae79cf",
  "site-ng": "5855c8c1-2c3b-46c3-8c0f-36a9a774d2e6",
};
const SITE_BY_UUID = new Map(Object.entries(SITE_UUIDS).map(([id, uuid]) => [uuid, id]));
const SITES = Object.keys(SITE_UUIDS);

interface Row {
  id: string;
  site: string;
  day: string;
  /** Payments: whole pence. Claims: whole hundredths of a UDA. */
  units: number;
  deleted: boolean;
}

/**
 * A book whose ids run in an order that has NOTHING to do with its dates.
 *
 * `daysBack` walks a deterministic non-monotonic sequence so recent, mid-window and
 * years-old rows are interleaved throughout the index — the property the real
 * endpoints have and the old scan assumed away. Two rows are pinned by hand:
 *
 *   - row 0 is EIGHT HUNDRED DAYS OLD and therefore the first thing a backwards walk
 *     sees, which is what made the old walk stop on page one;
 *   - a late row sits INSIDE the window at index 3,500, far beyond the reach of a
 *     walk that stopped early.
 */
function buildBook(rowCount: number, salt: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const daysBack = i === 0 ? 800 : ((i * 617 + salt * 29) % 900);
    rows.push({
      id: `row-${salt}-${i}`,
      site: SITES[i % SITES.length]!,
      day: shiftDay(TODAY, -daysBack),
      // Distinct, awkward values so a dropped or double-counted row cannot cancel out.
      units: 100 + ((i * 37) % 900),
      deleted: i % 61 === 0,
    });
  }
  rows[3_500] = { id: `row-${salt}-deep`, site: "site-cc", day: shiftDay(TODAY, -3), units: 12_345, deleted: false };
  return rows;
}

/** Whole units -> the decimal string Dentally puts on the wire. */
function amountString(units: number): string {
  const fixed = (units / 100).toFixed(2);
  return fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
}

interface Seen {
  claimQueries: URLSearchParams[];
  paymentQueries: URLSearchParams[];
  claimPages: number;
  paymentPages: number;
}

function newSeen(): Seen {
  return { claimQueries: [], paymentQueries: [], claimPages: 0, paymentPages: 0 };
}

interface UpstreamOpts {
  claims?: readonly Row[];
  payments?: readonly Row[];
  deadSite?: string;
  /** Endpoints that answer 500 for every site. */
  dead?: readonly string[];
  /** Endpoint -> a meta.total LARGER than the rows it will ever serve. */
  overstate?: Record<string, number>;
  /** Endpoints that never short-page: every page is full, for ever. */
  endless?: readonly string[];
}

const PRACTITIONERS = [
  { id: "prac-1", active: true, user: { first_name: "Shizza", last_name: "K" } },
  { id: "prac-2", active: true, user: { first_name: "Amir", last_name: "R" } },
];

/**
 * An upstream that behaves like the REAL endpoints:
 *   /v1/payments    honours start_date/end_date INCLUSIVELY on dated_on, and
 *                   publishes meta.total + meta.total_amount for the filtered set;
 *   /v1/nhs_claims  honours after (inclusive) / before (EXCLUSIVE of the day given)
 *                   on submitted_date, publishes meta.total and NO total_amount, and
 *                   REPRODUCES THE TRAP: start_date/end_date are accepted and match
 *                   nothing at all.
 * Both serve rows in id order.
 */
function upstream(seen: Seen, opts: UpstreamOpts = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const key = url.pathname.split("/").pop() ?? "";
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "100");
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    if (opts.dead?.includes(key)) return new Response("upstream is sick", { status: 500 });

    const siteUuid = url.searchParams.get("site_id");
    const site = siteUuid === null ? null : SITE_BY_UUID.get(siteUuid) ?? null;
    if (opts.deadSite !== undefined && site === opts.deadSite && (key === "payments" || key === "nhs_claims")) {
      return new Response("upstream is sick", { status: 500 });
    }

    const slice = <T>(rows: readonly T[]) => rows.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
    const endless = (rows: unknown[]) =>
      opts.endless?.includes(key) === true
        ? Array.from({ length: PER_PAGE }, (_, i) => ({ id: `${key}-${page}-${i}`, expected_uda: "1.0", awarded_uda: "1.0", claim_status: "submitted", submitted_date: TODAY, uda_band: "1", amount: "1.0", dated_on: TODAY, deleted: false, completed: false, created_at: `${TODAY}T09:00:00.000+01:00`, updated_at: `${TODAY}T09:00:00.000+01:00`, practitioner_id: "prac-1" }))
        : rows;

    if (key === "practitioners") return json({ practitioners: PRACTITIONERS });

    if (key === "payments") {
      seen.paymentQueries.push(url.searchParams);
      seen.paymentPages += 1;
      const start = url.searchParams.get("start_date");
      const end = url.searchParams.get("end_date");
      const matching = (opts.payments ?? []).filter(
        (r) =>
          (site === null || r.site === site) &&
          (start === null || r.day >= start) &&
          (end === null || r.day <= end),
      );
      const rows = endless(
        slice(matching).map((r) => ({
          id: r.id,
          amount: amountString(r.units),
          dated_on: r.day,
          deleted: r.deleted,
          site_id: SITE_UUIDS[r.site],
          explanations: [],
        })),
      );
      return json({
        payments: rows,
        meta: {
          total: opts.overstate?.["payments"] ?? matching.length,
          current_page: page,
          total_amount: amountString(matching.reduce((n, r) => n + r.units, 0)),
        },
      });
    }

    if (key === "nhs_claims") {
      seen.claimQueries.push(url.searchParams);
      seen.claimPages += 1;
      // THE TRAP, reproduced exactly: accepted, and matching nothing.
      if (url.searchParams.get("start_date") !== null || url.searchParams.get("end_date") !== null) {
        return json({ nhs_claims: [], meta: { total: 0, current_page: page, total_pages: 0 } });
      }
      const after = url.searchParams.get("after");
      const before = url.searchParams.get("before");
      const matching = (opts.claims ?? []).filter(
        (r) =>
          (site === null || r.site === site) &&
          (after === null || r.day >= after) &&
          (before === null || r.day < before),
      );
      const rows = endless(
        slice(matching).map((r) => ({
          id: r.id,
          site_id: SITE_UUIDS[r.site],
          practitioner_id: r.id.endsWith("0") ? "prac-2" : "prac-1",
          uda_band: "1",
          claim_status: "submitted",
          submitted_date: `${r.day}T12:55:02.776+01:00`,
          expected_uda: amountString(r.units),
          awarded_uda: "0.0",
        })),
      );
      return json({
        nhs_claims: rows,
        meta: {
          total: opts.overstate?.["nhs_claims"] ?? matching.length,
          current_page: page,
          total_pages: Math.ceil(matching.length / perPage),
        },
      });
    }

    if (key === "treatment_plan_items") {
      return json({
        treatment_plan_items: endless([]),
        meta: { total: opts.overstate?.["treatment_plan_items"] ?? 0, current_page: page },
      });
    }

    return json({ [key]: [], meta: { total: 0, current_page: page } });
  }) as typeof fetch;
}

/** The exact answer, computed here and not by the code under test. */
function expectedUnits(book: readonly Row[], opts: { skipDeleted?: boolean; site?: string } = {}): number {
  return book
    .filter(
      (r) =>
        r.day >= WINDOW.from &&
        r.day <= WINDOW.to &&
        (opts.site === undefined || r.site === opts.site) &&
        (opts.skipDeleted !== true || !r.deleted),
    )
    .reduce((n, r) => n + r.units, 0);
}

function expectedCount(book: readonly Row[], opts: { skipDeleted?: boolean } = {}): number {
  return book.filter(
    (r) => r.day >= WINDOW.from && r.day <= WINDOW.to && (opts.skipDeleted !== true || !r.deleted),
  ).length;
}

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "report-window-exact";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid";
});

// === Report A: NHS band activity ============================================

describe("Report A asks Dentally for the window, with the parameters this endpoint honours", () => {
  it("sends after/before and NEVER start_date/end_date", async () => {
    // start_date/end_date on /v1/nhs_claims are ACCEPTED and return zero rows for
    // every range, 2000..2030 included. Carrying the payments parameters across by
    // analogy would blank the whole report while looking like a working filter.
    const seen = newSeen();
    globalThis.fetch = upstream(seen, { claims: buildBook(2_000, 7) });

    const { readNhsBandReport } = await import("./flagship-read");
    await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    expect(seen.claimQueries.length).toBeGreaterThan(0);
    for (const q of seen.claimQueries) {
      expect(q.get("after"), "a claims read without `after` is a whole-index read").toBeTruthy();
      expect(q.get("before"), "a claims read without `before` runs past today").toBeTruthy();
      expect(q.get("after")! < q.get("before")!).toBe(true);
      expect(q.get("start_date"), "start_date on /v1/nhs_claims matches NOTHING").toBeNull();
      expect(q.get("end_date"), "end_date on /v1/nhs_claims matches NOTHING").toBeNull();
      expect(q.get("per_page")).toBe("100");
    }
  }, 120_000);

  it("pads both edges so a boundary day cannot be lost to an unstated convention", async () => {
    const seen = newSeen();
    globalThis.fetch = upstream(seen, { claims: buildBook(500, 8) });

    const { readNhsBandReport } = await import("./flagship-read");
    await readNhsBandReport({ siteIds: ["site-cc"], window: WINDOW, now: NOW });

    for (const q of seen.claimQueries) {
      // `before` was observed EXCLUSIVE of the day given, so asking for the window's
      // own last day would drop it. The band report windows client-side anyway.
      expect(q.get("after")).toBe(shiftDay(WINDOW.from, -1));
      expect(q.get("before")).toBe(shiftDay(WINDOW.to, 1));
    }
  }, 120_000);
});

describe("a date-SHUFFLED claim index still totals exactly", () => {
  it("the band report's claim count and UDA match an independently computed total", async () => {
    const book = buildBook(6_000, 1);
    globalThis.fetch = upstream(newSeen(), { claims: book });

    const { readNhsBandReport } = await import("./flagship-read");
    const result = await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    expect(result.unavailableReason).toBeNull();
    expect(result.report).not.toBeNull();
    expect(result.report!.grandTotal.cotCount).toBe(expectedCount(book));
    expect(result.report!.grandTotal.expectedUdaHundredths).toBe(expectedUnits(book));
    // The row a truncated walk can never reach is IN the answer.
    expect(expectedCount(book)).toBeGreaterThan(0);
  }, 120_000);

  it("re-shuffling the SAME claims changes nothing", async () => {
    const book = buildBook(6_000, 1);
    globalThis.fetch = upstream(newSeen(), { claims: book });
    const { readNhsBandReport } = await import("./flagship-read");
    const first = await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    // Same claims, different ids, therefore a different page order upstream.
    const reshuffled = [...book].sort((a, b) => (a.id < b.id ? 1 : -1));
    globalThis.fetch = upstream(newSeen(), { claims: reshuffled });
    const second = await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    expect(second.report!.grandTotal.cotCount).toBe(first.report!.grandTotal.cotCount);
    expect(second.report!.grandTotal.expectedUdaHundredths).toBe(
      first.report!.grandTotal.expectedUdaHundredths,
    );
  }, 120_000);

  it("THE CONTROL: the backwards walk this replaced is short on this very fixture", async () => {
    // Page the UNFILTERED index and stop once a row falls past the window's first
    // day — exactly what src/lib/reports/flagship-read.ts did until 2026-08-21.
    const book = buildBook(6_000, 1);
    const site = "site-cc";
    const own = book.filter((r) => r.site === site);

    let walked = 0;
    let oldestSeen: string | null = null;
    for (let page = 1; page <= 60; page += 1) {
      const rows = own.slice((page - 1) * PER_PAGE, page * PER_PAGE);
      for (const r of rows) {
        walked += r.day >= WINDOW.from && r.day <= WINDOW.to ? r.units : 0;
        if (oldestSeen === null || r.day < oldestSeen) oldestSeen = r.day;
      }
      if (rows.length < PER_PAGE) break;
      if (oldestSeen !== null && oldestSeen < WINDOW.from) break;
    }

    const truth = expectedUnits(book, { site });
    expect(truth).toBeGreaterThan(0);
    expect(walked, "the fixture no longer models the bug it exists to catch").toBeLessThan(truth * 0.5);

    globalThis.fetch = upstream(newSeen(), { claims: book });
    const { readNhsBandReport } = await import("./flagship-read");
    const result = await readNhsBandReport({ siteIds: [site], window: WINDOW, now: NOW });
    expect(result.report!.grandTotal.expectedUdaHundredths).toBe(truth);
    process.stderr.write(
      `[report-window-exact] control (old backwards walk) ${walked} UDA-hundredths vs truth ${truth} on the same book\n`,
    );
  }, 120_000);
});

// === Report B: payment allocation ===========================================

describe("Report B asks Dentally for the window it attributes", () => {
  it("sends start_date and end_date on every payments request", async () => {
    const seen = newSeen();
    globalThis.fetch = upstream(seen, { payments: buildBook(2_000, 2) });

    const { readPaymentAllocation } = await import("./flagship-read");
    await readPaymentAllocation({ siteIds: SITES, window: WINDOW, siteId: null, now: NOW });

    expect(seen.paymentQueries.length).toBeGreaterThan(0);
    for (const q of seen.paymentQueries) {
      expect(q.get("start_date"), "a payments read without start_date is a whole-index read").toBe(
        WINDOW.from,
      );
      // Both edges are INCLUSIVE on /v1/payments, so unlike claims they are NOT padded.
      expect(q.get("end_date")).toBe(WINDOW.to);
      expect(q.get("after"), "after/before are the CLAIMS parameters and are ignored here").toBeNull();
    }
    // And it pages only the window. An unfiltered read of this book is ~7 pages a
    // site — the shape that made the old walk both wrong and expensive.
    expect(seen.paymentPages).toBeLessThanOrEqual(2 * SITES.length);
  }, 120_000);

  it("a date-SHUFFLED payment index still totals exactly, and refuses nothing", async () => {
    const book = buildBook(6_000, 2);
    globalThis.fetch = upstream(newSeen(), { payments: book });

    const { readPaymentAllocation } = await import("./flagship-read");
    const result = await readPaymentAllocation({ siteIds: SITES, window: WINDOW, siteId: null, now: NOW });

    expect(result.unavailableReason).toBeNull();
    expect(result.report).not.toBeNull();
    // Deleted payments are excluded and counted by the report itself; the money is
    // otherwise the exact sum of every in-window row, wherever its id put it.
    expect(result.report!.totalReceivedPence).toBe(expectedUnits(book, { skipDeleted: true }));
    expect(result.report!.totalCount).toBe(expectedCount(book, { skipDeleted: true }));
    expect(result.droppedPayments).toBe(0);
  }, 120_000);
});

// === Honesty: an incomplete read is never a total ===========================

describe("a read that came up short says so, and says which kind of short", () => {
  it("Report A: fewer rows than meta.total blanks the report, even on a SHORT PAGE", async () => {
    // The sharp edge of the fix. The walk ended on a short page — the old
    // "I must be finished" signal — but Dentally says 500 claims match and 100
    // arrived. On an index that is not date-ordered, a short page proves nothing.
    globalThis.fetch = upstream(newSeen(), {
      claims: buildBook(2_000, 3),
      overstate: { nhs_claims: 500 },
    });

    const { readNhsBandReport } = await import("./flagship-read");
    const result = await readNhsBandReport({ siteIds: ["site-cc"], window: WINDOW, now: NOW });

    expect(result.report, "a report over an unknown fraction of the claims is not a report").toBeNull();
    expect(result.unavailableReason).toContain("more NHS claims than a single run can read");
    expect(result.unavailableReason).not.toContain("a live read failed");
    expect(result.coverage).toBeNull();
  }, 120_000);

  it("Report A: a walk that never short-pages is incomplete too", async () => {
    globalThis.fetch = upstream(newSeen(), {
      endless: ["nhs_claims"],
      overstate: { nhs_claims: 1_000_000 },
    });

    const { readNhsBandReport } = await import("./flagship-read");
    const result = await readNhsBandReport({ siteIds: ["site-cc"], window: WINDOW, now: NOW });

    expect(result.report).toBeNull();
    expect(result.unavailableReason).toContain("more NHS claims than a single run can read");
  }, 120_000);

  it("Report B: fewer payments than meta.total blanks the allocation", async () => {
    globalThis.fetch = upstream(newSeen(), {
      payments: buildBook(2_000, 4),
      overstate: { payments: 900 },
    });

    const { readPaymentAllocation } = await import("./flagship-read");
    const result = await readPaymentAllocation({
      siteIds: ["site-cc"],
      window: WINDOW,
      siteId: "site-cc",
      now: NOW,
    });

    expect(result.report, "a wage computed from some of the payments is a wrong wage").toBeNull();
    expect(result.unavailableReason).toContain("more payments than a single run can read");
    expect(result.invoicesRequested, "an incomplete read must not spend the invoice budget").toBe(0);
  }, 120_000);

  it("a genuine outage still says 'a live read failed', never 'too much data'", async () => {
    // The two send someone looking in different places: one at a broken connection,
    // the other at the period picker.
    globalThis.fetch = upstream(newSeen(), { claims: buildBook(500, 5), deadSite: "site-rv" });

    const { readNhsBandReport } = await import("./flagship-read");
    const result = await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    expect(result.report, "two practices out of three is not a group").toBeNull();
    expect(result.unavailableReason).toContain("a live read failed");
    expect(result.unavailableReason).not.toContain("more NHS claims");
  }, 120_000);

  it("Report C: fewer treatment-plan items than meta.total blanks the completion report", async () => {
    // The clinical read never had the backwards-walk bug, but it did stop on a short
    // page alone. meta.total is published here too, so an under-read is now caught.
    globalThis.fetch = upstream(newSeen(), { overstate: { treatment_plan_items: 4_000 } });

    const { readNhsClinicalReport } = await import("./flagship-read");
    const result = await readNhsClinicalReport({ siteIds: ["site-cc"], window: WINDOW, now: NOW });

    expect(result.report).toBeNull();
    expect(result.unavailableReason).toContain("more treatment-plan items than a single run can read");
    expect(result.filterPathUsed).toBe("practitioner");
  }, 120_000);

  it("an EMPTY window is an answer, not a failure", async () => {
    // "No claims this month" is a fact. It must never be dressed up as unavailable —
    // and completeness must not read an empty result as a truncation.
    globalThis.fetch = upstream(newSeen(), { claims: [] });

    const { readNhsBandReport } = await import("./flagship-read");
    const result = await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    expect(result.unavailableReason).toBeNull();
    expect(result.report!.grandTotal.cotCount).toBe(0);
    expect(result.coverage).toEqual({ from: WINDOW.from, to: WINDOW.to });
  }, 120_000);
});

// === Cost: narrowing at the server made these reads cheaper =================

describe("the windowed reads cost less than the walk they replaced", () => {
  it("a month of claims across three sites is a handful of requests, not 180", async () => {
    const seen = newSeen();
    globalThis.fetch = upstream(seen, { claims: buildBook(6_000, 1) });

    const { readNhsBandReport } = await import("./flagship-read");
    await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    // A month's claims for one site fit in a page or two. The walk this replaced was
    // budgeted at 60 pages a site and routinely spent them, because it was paging an
    // unfiltered index of years. An UNFILTERED read of this same book is 20 pages a
    // site, so this bound also fails the moment the date filter stops being sent.
    expect(seen.claimPages).toBeLessThanOrEqual(2 * SITES.length);
    process.stderr.write(`[report-window-exact] Report A cost ${seen.claimPages} claim pages for 3 sites\n`);
  }, 120_000);
});
