import "server-only";

// ---------------------------------------------------------------------------
// Paging a FILTERED Dentally list until it is provably complete.
//
// WHAT THIS FILE USED TO BE, AND WHY IT WAS WRONG.
//
// It held `scanBackwards`, which paged an endpoint "newest first" and stopped once
// a row fell past the window's first day, on this stated premise: "Dentally ignores
// every date filter on /v1/payments and /v1/nhs_claims and returns both newest
// first, so the only honest way to total a window is to page from today backwards
// until the boundary day is passed". Every clause of that was false, proven against
// live Dentally by read-only probe on 2026-08-21, and the same premise cost the
// practice owner a dashboard that understated her ninety-day takings by 85% before
// it was fixed there (see the header of src/lib/dashboard/read.ts).
//
//   1. THE ROWS ARE NOT DATE-ORDERED. They are ordered by id, so a backdated entry
//      sits wherever its id falls: on site N15, /v1/payments page 1 spans
//      2026-08-11..21 while page 20 spans 2023-09-14..2026-03-31. A backwards walk
//      therefore stops early AND skips in-window rows deeper in the index — and the
//      coverage span it then reported claimed the window WAS covered, so the
//      report printed a truncated total as a complete one.
//
//   2. THE DATE FILTERS WORK, under a different name per endpoint:
//        /v1/payments      start_date / end_date          (inclusive, on dated_on)
//        /v1/nhs_claims    after / before                 (on submitted_date)
//        /v1/invoices      created_after / created_before (on created_at)
//      They are NOT interchangeable: start_date/end_date on /v1/nhs_claims is
//      accepted and matches nothing for every range, so carrying the payments
//      parameters across by analogy silently empties the report.
//
// WHAT IT IS NOW. One pager, `pageAll`, that walks a request the server has ALREADY
// narrowed to the window and then answers the only question that matters about a
// scan: did it get everything? `meta.total` states exactly how many rows match, so
// completeness is MEASURED rather than inferred from where a walk happened to stop.
// A read that came up short says so, and its caller reports the figure unavailable
// rather than totalling a slice.
// ---------------------------------------------------------------------------

/** Rows per request. Dentally caps per_page at 100 — 200/250/500 silently return 25. */
export const REPORTS_PER_PAGE = 100;

/** 100 rows a page × 60 pages = 6,000 rows per site — a generous month-report bound. */
export const REPORTS_SCAN_MAX_PAGES = 60;

/** One page of a Dentally list: the rows, and the envelope they arrived in. */
export interface ListPage {
  rows: unknown[];
  meta: unknown;
}

export interface PagedRead {
  raw: unknown[];
  /**
   * True only when the read is PROVABLY whole — either Dentally's own `meta.total`
   * was reached, or the endpoint published no total and the walk ended on a short
   * page well inside its budget. False means rows are missing and the caller must
   * not total what it has.
   */
  complete: boolean;
  /** `meta.total` from the first page, or null when the endpoint published none. */
  expected: number | null;
}

/**
 * `meta.total` — how many rows Dentally says match the query — or null when the
 * envelope does not carry one.
 *
 * THE ONE HOME of this grammar: src/lib/dashboard/read.ts imports it from here
 * (the twin it once carried is deleted), which works because this module imports
 * nothing but "server-only" — no panel graph comes along. The parsing that
 * actually carries money — `parseAggregateAmountPence` in
 * src/lib/dashboard/money.ts — is likewise shared; this is a row count.
 *
 * Null is not an error: some endpoints omit it, and the caller then falls back to
 * the short-page heuristic and treats a budget-exhausting walk as incomplete.
 */
export function metaTotal(meta: unknown): number | null {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>)["total"];
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : null;
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Page a server-filtered list to the end of its result set, or to `maxPages`.
 *
 * The caller is expected to have narrowed the request with the filter that endpoint
 * actually honours; this only walks the pages and reports whether it got them all.
 *
 * A ZERO-ROW ANSWER IS AN ANSWER. An empty window returns `{ raw: [], complete:
 * true }` — "no claims this month" is a fact, and it must not be confused with a
 * failed read, which is the caller's own catch and a different reason on screen.
 *
 * A WALK THAT CANNOT FINISH IS ABANDONED ON PAGE ONE. `meta.total` arrives with the
 * first page, so a window holding more rows than `maxPages` can carry is KNOWN to be
 * unreadable before the second request is made. It used to walk all sixty pages
 * anyway — six thousand rows fetched, parsed and thrown away, one live request at a
 * time — to reach the same `complete: false` and the same "choose a shorter period"
 * on screen. The verdict is unchanged; only the sixty seconds spent reaching it are
 * gone. For the same reason the walk stops the moment it holds `expected` rows
 * rather than spending one more request to see a short page confirm it.
 *
 * Both stops assume what every caller in this file already relies on: pages of
 * REPORTS_PER_PAGE rows (it is also what the existing short-page stop measures
 * against). A caller paging in some other size gets the old walk, not a wrong one.
 */
export async function pageAll(
  fetchPage: (page: number) => Promise<ListPage>,
  maxPages: number = REPORTS_SCAN_MAX_PAGES,
): Promise<PagedRead> {
  const raw: unknown[] = [];
  let expected: number | null = null;
  let hitCap = true;

  for (let page = 1; page <= maxPages; page += 1) {
    const { rows, meta } = await fetchPage(page);
    if (page === 1) expected = metaTotal(meta);
    raw.push(...rows);
    // Dentally has already said the window is bigger than this budget: every
    // remaining request would be spent proving a truncation we have been told about.
    if (page === 1 && expected !== null && expected > maxPages * REPORTS_PER_PAGE) {
      return { raw, complete: false, expected };
    }
    if (rows.length < REPORTS_PER_PAGE) {
      hitCap = false;
      break;
    }
    // Everything Dentally says exists is in hand. The next page would be the empty
    // or short one that today's stop waits for.
    if (expected !== null && raw.length >= expected) {
      hitCap = false;
      break;
    }
  }

  // Dentally told us how many exist: anything less is a truncated read, whatever
  // the walk looked like. This is the check a short page alone cannot make on an
  // index that is not date-ordered.
  if (expected !== null) return { raw, complete: raw.length >= expected, expected };
  return { raw, complete: !hitCap, expected: null };
}
