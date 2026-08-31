import { describe, it, expect } from "vitest";
import { pageToCompletion } from "./paging";

// ===========================================================================
// "IT ONLY GOES BACK TO A CERTAIN DATE, WHICH IS ONLY TO MAY."
//
// The practice owner, comparing this platform's Correspondence tab with
// Dentally's own on the 27 August call. The reader behind it walked pages and
// stopped on the first page shorter than the size it asked for, with NO
// completeness signal of any kind.
//
// TWO THINGS MAKE THAT STOP EARLY AND SILENTLY:
//
//  1. Several Dentally endpoints SILENTLY CAP per_page below what is asked for
//     (measured on /v1/payments and /v1/nhs_claims: ask for 250, get 25). A
//     capped page is shorter than requested, the short-page rule reads it as the
//     end of the list, and the walk stops on page one. Rows come back NEWEST
//     FIRST, so what survives is the recent end — exactly the shape of the
//     complaint.
//  2. Hitting the page ceiling was a silent stop; the caller was told nothing.
//
// meta.total is the fix, and it was published all along: a live read of
// /v1/sms?patient_id=40000&per_page=100 on 2026-08-31 returned
// meta {total: 19, page: 1}. These tests hold both the fix and the honesty rule
// that goes with it — an incomplete read must SAY it is incomplete.
// ===========================================================================

/** A fake endpoint holding `total` rows and serving at most `cap` per page. */
function endpoint(total: number, cap: number, publishesTotal = true) {
  const calls: number[] = [];
  return {
    calls,
    fetchPage: async (page: number, perPage: number) => {
      calls.push(page);
      const size = Math.min(perPage, cap);
      const start = (page - 1) * size;
      const rows = Array.from({ length: total }, (_, i) => i + 1).slice(start, start + size);
      return { rows, total: publishesTotal ? total : null };
    },
  };
}

describe("a walk against an endpoint that silently caps per_page still finishes", () => {
  it("does NOT stop on the first short page when a total says there is more", () => {
    // THE BUG, DIRECTLY. Asking for 100 from an endpoint that serves 25 gives a
    // 25-row first page. The old short-page rule called that the end of the list and
    // returned a quarter of the history as though it were the whole of it.
    return pageToCompletion(endpoint(100, 25).fetchPage, 100, 40).then((read) => {
      expect(read.rows).toHaveLength(100);
      expect(read.complete).toBe(true);
      expect(read.total).toBe(100);
    });
  });

  it("keeps every row, in order, across the capped pages", async () => {
    const read = await pageToCompletion(endpoint(60, 25).fetchPage, 100, 40);
    expect(read.rows).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it("stops the moment it has as many rows as Dentally says exist", async () => {
    // No wasted request past the end. On a per-patient interactive read that is real
    // budget, and the whole reason meta.total is worth consulting.
    const ep = endpoint(50, 25);
    await pageToCompletion(ep.fetchPage, 100, 40);
    expect(ep.calls).toEqual([1, 2]);
  });
});

describe("an incomplete read SAYS it is incomplete", () => {
  it("reports complete:false when the page ceiling is reached first", () => {
    // 200 rows at 25 a page needs 8 pages; the walk is allowed 3. It must not come
    // back looking like a finished read.
    return pageToCompletion(endpoint(200, 25).fetchPage, 100, 3).then((read) => {
      expect(read.rows).toHaveLength(75);
      expect(read.complete).toBe(false);
      // The total is still reported, so a caller could say HOW short it fell.
      expect(read.total).toBe(200);
    });
  });

  it("reports complete:false when the endpoint runs dry short of its own total", async () => {
    // Dentally claiming 100 rows and handing back 40 is not a finished read, and
    // treating it as one is how a truncated history becomes a confident one.
    let served = 0;
    const read = await pageToCompletion(
      async (_page, perPage) => {
        const rows = served >= 40 ? [] : Array.from({ length: Math.min(perPage, 40 - served) }, () => 1);
        served += rows.length;
        return { rows, total: 100 };
      },
      25,
      40,
    );
    expect(read.rows).toHaveLength(40);
    expect(read.complete).toBe(false);
  });
});

describe("an endpoint publishing NO total falls back to the short-page stop", () => {
  it("treats a short page as the end when there is no total to check against", async () => {
    // Not a failure. It is the strongest honest claim available when the endpoint
    // tells us nothing, and it is exactly what pageToCeiling already does.
    const read = await pageToCompletion(endpoint(60, 100, false).fetchPage, 100, 40);
    expect(read.rows).toHaveLength(60);
    expect(read.complete).toBe(true);
    expect(read.total).toBe(null);
  });

  it("still reports incomplete when it runs out of PAGES with no total", async () => {
    const read = await pageToCompletion(endpoint(500, 25, false).fetchPage, 25, 3);
    expect(read.rows).toHaveLength(75);
    expect(read.complete).toBe(false);
  });

  it("handles an endpoint that is simply empty", async () => {
    const read = await pageToCompletion(endpoint(0, 25).fetchPage, 100, 40);
    expect(read.rows).toEqual([]);
    expect(read.complete).toBe(true);
  });
});

describe("the total is anchored to the FIRST page", () => {
  it("a shrinking total mid-walk cannot make an incomplete read look finished", async () => {
    // Rows can be written while we walk. Re-anchoring to a later page's smaller count
    // would let the walk declare victory holding fewer rows than it started out needing.
    let page = 0;
    const read = await pageToCompletion(
      async (_p, perPage) => {
        page += 1;
        // Page 1 says 100; every later page claims only 25 — which, if believed, would
        // end the walk at page 1 with 25 rows and complete:true.
        return {
          rows: page <= 4 ? Array.from({ length: perPage }, () => 1) : [],
          total: page === 1 ? 100 : 25,
        };
      },
      25,
      40,
    );
    expect(read.total).toBe(100);
    expect(read.rows).toHaveLength(100);
    expect(read.complete).toBe(true);
  });
});
