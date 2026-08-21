import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { pageAll, REPORTS_PER_PAGE, REPORTS_SCAN_MAX_PAGES } from "./scan";

// ---------------------------------------------------------------------------
// THE WALK THAT KNEW IT COULD NOT FINISH AND WALKED ANYWAY.
//
// `pageAll` learns Dentally's own `meta.total` from page one. When that total is
// bigger than `maxPages` can carry, the answer is already decided: the read will be
// incomplete, the caller will report the figure unavailable, and the owner will be
// told to choose a shorter period. The walk used to go and prove it anyway — up to
// sixty live requests and six thousand parsed rows, one after another, before the
// screen could say the one sentence it was always going to say. On the report route
// that is a minute of a 300s budget spent on a foregone conclusion; on the page
// render (Report C fans out per clinician) it is the render.
//
// The mirror image is the last page: once the walk holds every row `meta.total`
// promised, the next request exists only to see a short page agree.
//
// Both stops are BEHAVIOUR-TIGHTENING ONLY. Every field of the return is what the
// old walk would have produced — `complete` in particular is still measured against
// `expected`, never assumed — so no caller can tell the difference except in how
// long it waited. That is what the controls at the bottom pin.
// ---------------------------------------------------------------------------

/** A full page of placeholder rows: enough to keep an unfixed walk going. */
function fullPage(page: number): unknown[] {
  return Array.from({ length: REPORTS_PER_PAGE }, (_, i) => ({ id: `${page}-${i}` }));
}

/**
 * A pager that records every page requested. `total` is what Dentally publishes in
 * the envelope (null publishes none); rows keep coming until `rowCount` is served.
 */
function recordingPager(opts: { rowCount: number; total: number | null }) {
  const requested: number[] = [];
  const fetchPage = async (page: number) => {
    requested.push(page);
    const before = (page - 1) * REPORTS_PER_PAGE;
    const left = Math.max(0, opts.rowCount - before);
    const size = Math.min(REPORTS_PER_PAGE, left);
    return {
      rows: size === REPORTS_PER_PAGE ? fullPage(page) : fullPage(page).slice(0, size),
      meta: opts.total === null ? {} : { total: opts.total },
    };
  };
  return { requested, fetchPage };
}

describe("pageAll stops as soon as the answer is known", () => {
  it("abandons a doomed walk after page one instead of paging to the cap", async () => {
    const maxPages = 5;
    // One row more than the budget carries: the read CANNOT come out complete.
    const rowCount = maxPages * REPORTS_PER_PAGE + 1;
    const { requested, fetchPage } = recordingPager({ rowCount, total: rowCount });

    const read = await pageAll(fetchPage, maxPages);

    expect(requested, "meta.total settled this on page one; the rest is spent proving it").toEqual([1]);
    expect(read.complete).toBe(false);
    expect(read.expected).toBe(rowCount);
    // The verdict and the rows are exactly what the full walk would have returned
    // for an incomplete read: page one's rows, handed back, totalled by nobody.
    expect(read.raw).toHaveLength(REPORTS_PER_PAGE);
  });

  it("stops on the page that completes meta.total, not on the empty one after it", async () => {
    const rowCount = 2 * REPORTS_PER_PAGE; // exactly two full pages
    const { requested, fetchPage } = recordingPager({ rowCount, total: rowCount });

    const read = await pageAll(fetchPage, REPORTS_SCAN_MAX_PAGES);

    expect(requested, "page 3 exists only to watch a short page agree").toEqual([1, 2]);
    expect(read.complete).toBe(true);
    expect(read.expected).toBe(rowCount);
    expect(read.raw).toHaveLength(rowCount);
  });

  // -------------------------------------------------------------------------
  // CONTROLS. A stop that fires early is a truncation dressed as a total, which is
  // the exact failure this whole file's subject exists to prevent.
  // -------------------------------------------------------------------------

  it("a window that exactly fills the budget is still read in full", async () => {
    const maxPages = 3;
    const rowCount = maxPages * REPORTS_PER_PAGE; // readable, to the last row
    const { requested, fetchPage } = recordingPager({ rowCount, total: rowCount });

    const read = await pageAll(fetchPage, maxPages);

    expect(requested).toEqual([1, 2, 3]);
    expect(read.complete, "one row short of the bail, and it is a COMPLETE read").toBe(true);
    expect(read.raw).toHaveLength(rowCount);
  });

  it("walks to the short page when the endpoint publishes no total", async () => {
    const rowCount = 2 * REPORTS_PER_PAGE + 7;
    const { requested, fetchPage } = recordingPager({ rowCount, total: null });

    const read = await pageAll(fetchPage, REPORTS_SCAN_MAX_PAGES);

    expect(requested).toEqual([1, 2, 3]);
    expect(read.expected).toBeNull();
    expect(read.complete).toBe(true);
    expect(read.raw).toHaveLength(rowCount);
  });

  it("still reports incomplete when an untotalled walk exhausts its budget", async () => {
    const maxPages = 2;
    const { requested, fetchPage } = recordingPager({ rowCount: 10_000, total: null });

    const read = await pageAll(fetchPage, maxPages);

    expect(requested).toEqual([1, 2]);
    expect(read.complete, "no total to check against, and the walk hit the cap").toBe(false);
  });

  it("an empty window is a complete answer, not a failed read", async () => {
    const { requested, fetchPage } = recordingPager({ rowCount: 0, total: 0 });

    const read = await pageAll(fetchPage, REPORTS_SCAN_MAX_PAGES);

    expect(requested).toEqual([1]);
    expect(read.raw).toHaveLength(0);
    expect(read.complete).toBe(true);
  });
});
