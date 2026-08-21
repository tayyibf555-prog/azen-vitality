import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// THE FLAGSHIP REPORTS MUST NOT DEPEND ON THE ORDER DENTALLY HANDS US ROWS IN.
//
// This is the reports-layer twin of src/lib/dashboard/takings-window-exact.test.ts,
// pinning the same 2026-08-21 calibration onto Report A (/v1/nhs_claims) and
// Report B (/v1/payments). Both endpoints serve rows in ID ORDER, not date order
// — on the real site N15 page 1 spans 2026-08-11..21 and page 2 already holds a
// payment from 2026-01-10 — and BOTH take a real date filter, under different
// names:
//
//   /v1/payments      start_date / end_date   (inclusive, on dated_on)
//   /v1/nhs_claims    after / before          (on submitted_date)
//
// The old flagship read believed neither and paged "newest first" until a row
// fell outside the window. On an id-ordered index that stops on page one, so the
// report she pays dentists from was totalled over an arbitrary sliver. Replayed
// live, the same walk produced £17,012.10 for 90 days of payments against a true
// £114,429.78.
//
// So THE FIXTURES BELOW ARE DELIBERATELY SHUFFLED in exactly that shape: an
// ancient row sits first in the index, and in-window rows sit far past where any
// backwards walk would have stopped. Three things are proved against them:
//
//   1. each report's figures equal an independently computed exact answer;
//   2. the requests carry each endpoint's OWN filter — and never the other's:
//      start_date/end_date are ACCEPTED on /v1/nhs_claims and match NOTHING
//      (zero rows for every range including 2000..2030), so the mock returns
//      exactly that if the payments parameters ever leak across;
//   3. THE CONTROL — the old backwards walk, run over this same fixture, is
//      short. If it ever stops being short, the fixture has stopped modelling
//      the bug and the other assertions are passing for free.
// ---------------------------------------------------------------------------

const PER_PAGE = 100;
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Fixed clock. The report window is LAST MONTH — the report Blerta actually runs. */
const NOW = new Date("2026-08-21T10:00:00.000Z");
const TODAY = "2026-08-21";
const WINDOW = { from: "2026-07-01", to: "2026-07-31" };

const SITE_UUIDS: Record<string, string> = {
  "site-cc": "3286d822-68c5-48ff-b1a2-065780dfcd15",
  "site-rv": "c9b87b78-96e6-4f3d-aa8b-e1b953ae79cf",
  "site-ng": "5855c8c1-2c3b-46c3-8c0f-36a9a774d2e6",
};
const SITES = Object.keys(SITE_UUIDS);
const SITE_BY_UUID = new Map(Object.entries(SITE_UUIDS).map(([id, uuid]) => [uuid, id]));

function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
}

/** Deterministic day scatter: co-prime strides interleave recent, in-window and
 *  years-old rows throughout the index, exactly like a book that accepts
 *  backdated entries. Row 0 is pinned EIGHT HUNDRED DAYS OLD so the very first
 *  thing a backwards walk sees is past every boundary. */
function scatterDay(i: number, salt: number): string {
  const daysBack = i === 0 ? 800 : (i * 617 + salt * 29) % 900;
  return shiftDay(TODAY, -daysBack);
}

// --- Report A fixture: NHS claims -------------------------------------------

interface ClaimRow {
  id: string;
  site: string;
  day: string;
  expectedUdaHundredths: number;
}

function buildClaimBook(rowCount: number, salt: number): ClaimRow[] {
  const rows: ClaimRow[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    rows.push({
      id: `claim-${salt}-${i}`,
      site: SITES[i % SITES.length]!,
      day: scatterDay(i, salt),
      // Distinct, awkward UDA values so a dropped or double-counted claim cannot
      // cancel out.
      expectedUdaHundredths: 25 + (i % 300),
    });
  }
  // The claim a truncated walk can never reach: inside the window, deep in the index.
  rows[3_500] = { id: `claim-${salt}-deep`, site: "site-cc", day: "2026-07-15", expectedUdaHundredths: 999 };
  return rows;
}

/** Hundredths -> the decimal string Dentally puts in expected_uda ("1.56"). */
function udaString(hundredths: number): string {
  return (hundredths / 100).toFixed(2);
}

// --- Report B fixture: payments ---------------------------------------------

interface PaymentRow {
  id: string;
  site: string;
  day: string;
  pence: number;
  deleted: boolean;
}

function buildPaymentBook(rowCount: number, salt: number): PaymentRow[] {
  const rows: PaymentRow[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    rows.push({
      id: `pay-${salt}-${i}`,
      site: SITES[i % SITES.length]!,
      day: scatterDay(i, salt),
      pence: 1_000 + ((i * 37) % 9_000),
      deleted: i % 61 === 0,
    });
  }
  rows[3_500] = { id: `pay-${salt}-deep`, site: "site-cc", day: "2026-07-15", pence: 123_456, deleted: false };
  return rows;
}

function amountString(pence: number): string {
  return (pence / 100).toFixed(2);
}

// --- The upstream, behaving like the REAL endpoints -------------------------

interface Seen {
  claimQueries: URLSearchParams[];
  paymentQueries: URLSearchParams[];
}

function newSeen(): Seen {
  return { claimQueries: [], paymentQueries: [] };
}

/**
 * /v1/nhs_claims as live Dentally serves it: `after` / `before` filter on the
 * submitted day (both edges EXCLUSIVE — `before=<today>` was observed to exclude
 * today's own claims, and `after`'s convention is unstated, which is why the
 * caller must pad); rows in ID ORDER; meta carries total but NO total_amount.
 * AND THE TRAP: start_date / end_date are accepted and match NOTHING.
 */
function claimsResponse(book: readonly ClaimRow[], q: URLSearchParams): unknown {
  if (q.get("start_date") !== null || q.get("end_date") !== null) {
    return { nhs_claims: [], meta: { total: 0, current_page: 1, total_pages: 0 } };
  }
  const siteUuid = q.get("site_id");
  const site = siteUuid === null ? null : SITE_BY_UUID.get(siteUuid) ?? null;
  const after = q.get("after");
  const before = q.get("before");
  const matching = book.filter(
    (r) =>
      (site === null || r.site === site) &&
      (after === null || r.day > after) &&
      (before === null || r.day < before),
  );
  const page = Number(q.get("page") ?? "1");
  const perPage = Number(q.get("per_page") ?? "100");
  const from = (page - 1) * perPage;
  return {
    nhs_claims: matching.slice(from, from + perPage).map((r) => ({
      id: r.id,
      site_id: SITE_UUIDS[r.site],
      practitioner_id: `prac-${r.id.length % 3}`,
      expected_uda: udaString(r.expectedUdaHundredths),
      awarded_uda: null,
      submitted_date: r.day,
      claim_status: "submitted",
      uda_band: "1",
    })),
    meta: {
      total: matching.length,
      current_page: page,
      total_pages: Math.ceil(matching.length / perPage),
    },
  };
}

/**
 * /v1/payments as live Dentally serves it: start_date / end_date INCLUSIVE on
 * dated_on, rows in ID ORDER, meta.total and meta.total_amount for the filtered
 * set. Every row carries explanations[] (empty here: no invoice fan-out in these
 * tests — Report B's money identity still has to hold without a single leg).
 */
function paymentsResponse(book: readonly PaymentRow[], q: URLSearchParams): unknown {
  const siteUuid = q.get("site_id");
  const site = siteUuid === null ? null : SITE_BY_UUID.get(siteUuid) ?? null;
  const start = q.get("start_date");
  const end = q.get("end_date");
  const matching = book.filter(
    (r) =>
      (site === null || r.site === site) &&
      (start === null || r.day >= start) &&
      (end === null || r.day <= end),
  );
  const page = Number(q.get("page") ?? "1");
  const perPage = Number(q.get("per_page") ?? "100");
  const from = (page - 1) * perPage;
  return {
    payments: matching.slice(from, from + perPage).map((r) => ({
      id: r.id,
      amount: amountString(r.pence),
      dated_on: r.day,
      deleted: r.deleted,
      site_id: SITE_UUIDS[r.site],
      explanations: [],
      fully_explained: false,
    })),
    meta: {
      total: matching.length,
      current_page: page,
      total_amount: (matching.reduce((n, r) => n + r.pence, 0) / 100).toFixed(2),
    },
  };
}

function bookFetch(
  claims: readonly ClaimRow[],
  payments: readonly PaymentRow[],
  seen: Seen,
  opts: { deadSite?: string } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const q = url.searchParams;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    const siteUuid = q.get("site_id");
    const site = siteUuid === null ? null : SITE_BY_UUID.get(siteUuid) ?? null;
    if (opts.deadSite !== undefined && site === opts.deadSite && !url.pathname.endsWith("/v1/practitioners")) {
      return new Response("upstream is sick", { status: 500 });
    }

    if (url.pathname.endsWith("/v1/nhs_claims")) {
      seen.claimQueries.push(q);
      return json(claimsResponse(claims, q));
    }
    if (url.pathname.endsWith("/v1/payments")) {
      seen.paymentQueries.push(q);
      return json(paymentsResponse(payments, q));
    }
    const key = url.pathname.split("/").pop() ?? "";
    return json({ [key]: [], meta: { total: 0, current_page: 1, total_pages: 0 } });
  }) as typeof fetch;
}

// --- The exact answers, computed here and not by the code under test ---------

function claimsInWindow(book: readonly ClaimRow[]): ClaimRow[] {
  return book.filter((r) => r.day >= WINDOW.from && r.day <= WINDOW.to);
}

function paymentsInWindowPence(book: readonly PaymentRow[]): number {
  return book
    .filter((r) => r.day >= WINDOW.from && r.day <= WINDOW.to && !r.deleted)
    .reduce((n, r) => n + r.pence, 0);
}

beforeEach(() => {
  process.env.DENTALLY_API_KEY = "flagship-window-exact";
  process.env.DENTALLY_BASE_URL = "http://dentally.invalid";
});

describe("Report A asks /v1/nhs_claims for the window", () => {
  it("sends after/before on every claims request, and NEVER start_date/end_date", async () => {
    const seen = newSeen();
    globalThis.fetch = bookFetch(buildClaimBook(1_000, 1), buildPaymentBook(100, 1), seen);

    const { readNhsBandReport } = await import("./flagship-read");
    await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    expect(seen.claimQueries.length).toBeGreaterThan(0);
    for (const q of seen.claimQueries) {
      expect(q.get("after"), "a claims read without `after` is a whole-index read").toBeTruthy();
      expect(q.get("before"), "a claims read without `before` runs to today").toBeTruthy();
      // Padded past the window edges: both live edge conventions are exclusive or
      // unstated, and the compute layer trims client-side.
      expect(q.get("after")! < WINDOW.from).toBe(true);
      expect(q.get("before")! > WINDOW.to).toBe(true);
      // THE TRAP. These are the CORRECT parameters on /v1/payments and they are
      // accepted-and-ignored here, matching zero rows for every range.
      expect(q.get("start_date"), "start_date on /v1/nhs_claims matches nothing").toBeNull();
      expect(q.get("end_date"), "end_date on /v1/nhs_claims matches nothing").toBeNull();
    }
  }, 120_000);

  it("totals a date-SHUFFLED claims index exactly", async () => {
    const book = buildClaimBook(6_000, 1);
    globalThis.fetch = bookFetch(book, buildPaymentBook(100, 1), newSeen());

    const { readNhsBandReport } = await import("./flagship-read");
    const result = await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    const truth = claimsInWindow(book);
    expect(result.unavailableReason).toBeNull();
    expect(result.report).not.toBeNull();
    expect(result.report!.grandTotal.cotCount).toBe(truth.length);
    expect(result.report!.grandTotal.expectedUdaHundredths).toBe(
      truth.reduce((n, r) => n + r.expectedUdaHundredths, 0),
    );
    expect(result.droppedClaims).toBe(0);
  }, 120_000);

  it("THE CONTROL: the backwards walk this replaced is short on this very fixture", async () => {
    // Page newest-first, stop once past the boundary — exactly what flagship-read
    // did until this fix — over one site's slice of the same shuffled book. Row 0
    // is 800 days old, so the walk stops on page one.
    const book = buildClaimBook(6_000, 1);
    const own = book.filter((r) => r.site === "site-cc");

    let walked = 0;
    let oldestSeen: string | null = null;
    for (let page = 1; page <= 60; page += 1) {
      const rows = own.slice((page - 1) * PER_PAGE, page * PER_PAGE);
      for (const r of rows) {
        if (r.day >= WINDOW.from && r.day <= WINDOW.to) walked += 1;
        if (oldestSeen === null || r.day < oldestSeen) oldestSeen = r.day;
      }
      if (rows.length < PER_PAGE) break;
      if (oldestSeen !== null && oldestSeen < WINDOW.from) break;
    }

    const truth = claimsInWindow(book).filter((r) => r.site === "site-cc").length;
    expect(truth).toBeGreaterThan(0);
    expect(walked, "the fixture no longer models the bug it exists to catch").toBeLessThan(truth * 0.5);
  }, 120_000);
});

describe("Report B asks /v1/payments for the window", () => {
  it("sends start_date and end_date on every payments request", async () => {
    const seen = newSeen();
    globalThis.fetch = bookFetch(buildClaimBook(100, 2), buildPaymentBook(1_000, 2), seen);

    const { readPaymentAllocation } = await import("./flagship-read");
    await readPaymentAllocation({ siteIds: SITES, window: WINDOW, siteId: null, now: NOW });

    expect(seen.paymentQueries.length).toBeGreaterThan(0);
    for (const q of seen.paymentQueries) {
      // Both edges INCLUSIVE on dated_on, verified live — the window itself, unpadded.
      expect(q.get("start_date"), "a payments read without start_date is a whole-index read").toBe(WINDOW.from);
      expect(q.get("end_date"), "a payments read without end_date runs to today-or-later").toBe(WINDOW.to);
    }
  }, 120_000);

  it("totals a date-SHUFFLED payment index exactly", async () => {
    const book = buildPaymentBook(6_000, 1);
    globalThis.fetch = bookFetch(buildClaimBook(100, 1), book, newSeen());

    const { readPaymentAllocation } = await import("./flagship-read");
    const result = await readPaymentAllocation({ siteIds: SITES, window: WINDOW, siteId: null, now: NOW });

    expect(result.unavailableReason).toBeNull();
    expect(result.report).not.toBeNull();
    expect(result.report!.totalReceivedPence).toBe(paymentsInWindowPence(book));
  }, 120_000);
});

describe("what the reports say when they cannot read the window in full", () => {
  it("a window holding more claims than the page budget reports unavailable, never a slice", async () => {
    // 6,100 in-window claims on one site: past the 60-page budget, and meta.total
    // says so. The report must refuse rather than total the 6,000 it reached.
    const book: ClaimRow[] = [];
    for (let i = 0; i < 6_100; i += 1) {
      book.push({ id: `claim-big-${i}`, site: "site-cc", day: "2026-07-10", expectedUdaHundredths: 100 });
    }
    globalThis.fetch = bookFetch(book, buildPaymentBook(100, 3), newSeen());

    const { readNhsBandReport } = await import("./flagship-read");
    const result = await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });

    expect(result.report).toBeNull();
    expect(result.unavailableReason).toContain("shorter period");
  }, 120_000);

  it("one dead site fails the whole scope", async () => {
    const seen = newSeen();
    globalThis.fetch = bookFetch(buildClaimBook(1_000, 4), buildPaymentBook(1_000, 4), seen, {
      deadSite: "site-rv",
    });

    const { readNhsBandReport, readPaymentAllocation } = await import("./flagship-read");
    const a = await readNhsBandReport({ siteIds: SITES, window: WINDOW, now: NOW });
    const b = await readPaymentAllocation({ siteIds: SITES, window: WINDOW, siteId: null, now: NOW });

    expect(a.report).toBeNull();
    expect(a.unavailableReason).toContain("live read failed");
    expect(b.report).toBeNull();
    expect(b.unavailableReason).toContain("live read failed");
  }, 120_000);
});
