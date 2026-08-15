import { describe, it, expect } from "vitest";
import { DEFAULT_MAX_ROWS, DEFAULT_PAGE_SIZE, collectPages } from "./paging";

/** A fake paged source over a fixed array, recording exactly how it was called. */
function source(total: number) {
  const all = Array.from({ length: total }, (_, i) => i);
  const calls: { offset: number; limit: number }[] = [];
  return {
    calls,
    fetchPage: async (offset: number, limit: number) => {
      calls.push({ offset, limit });
      return all.slice(offset, offset + limit);
    },
  };
}

describe("collectPages", () => {
  it("reads every row across several pages, in order", () => {
    const s = source(2500);
    return collectPages(s.fetchPage, { pageSize: 1000 }).then((out) => {
      expect(out.rows).toHaveLength(2500);
      expect(out.rows[0]).toBe(0);
      expect(out.rows[2499]).toBe(2499);
      expect(out.truncated).toBe(false);
      expect(out.pages).toBe(3);
    });
  });

  it("THE 500-CAP BUG: a month bigger than one page is not silently short", async () => {
    // The exact failure this module exists for: 1,800 events read through a
    // single 500-row query returns 500 and understates everybody's hours.
    const s = source(1800);
    const out = await collectPages(s.fetchPage, { pageSize: 500 });
    expect(out.rows).toHaveLength(1800);
    expect(out.truncated).toBe(false);
  });

  it("the offset advances by a page each time (a stuck offset would loop forever)", async () => {
    const s = source(2500);
    await collectPages(s.fetchPage, { pageSize: 1000 });
    expect(s.calls.map((c) => c.offset)).toEqual([0, 1000, 2000]);
    expect(s.calls.every((c) => c.limit === 1000)).toBe(true);
  });

  it("a SHORT page stops the loop: no wasted query after the end", async () => {
    const s = source(1500);
    const out = await collectPages(s.fetchPage, { pageSize: 1000 });
    expect(out.pages).toBe(2);
    expect(s.calls).toHaveLength(2);
    expect(out.rows).toHaveLength(1500);
  });

  it("an exactly-full last page costs one more query and still terminates", async () => {
    const s = source(2000);
    const out = await collectPages(s.fetchPage, { pageSize: 1000 });
    expect(out.pages).toBe(3); // the third comes back empty, which is the end signal
    expect(out.rows).toHaveLength(2000);
    expect(out.truncated).toBe(false);
  });

  it("an empty first page returns nothing, and is not treated as an error", async () => {
    const s = source(0);
    const out = await collectPages(s.fetchPage, { pageSize: 1000 });
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(out.pages).toBe(1);
  });

  it("hitting the ceiling reports truncated: true rather than pretending to be complete", async () => {
    const s = source(5000);
    const out = await collectPages(s.fetchPage, { pageSize: 100, maxRows: 300 });
    expect(out.rows).toHaveLength(300);
    // THE POINT. A silent trim here is a silent undercount of somebody's pay.
    expect(out.truncated).toBe(true);
  });

  // THE OVERSHOOT TRIM. Every other ceiling test uses a maxRows that is an exact
  // multiple of pageSize (and so do the production defaults, 1000 into 10000), so
  // the `rows.length > maxRows` branch — the one that actually SLICES — was never
  // executed anywhere. A ceiling that is not a round number of pages is the only
  // way to reach it.
  it("trims to the ceiling exactly when a page overshoots it", async () => {
    const s = source(5000);
    const out = await collectPages(s.fetchPage, { pageSize: 100, maxRows: 250 });
    expect(out.rows).toHaveLength(250);
    expect(out.rows[249]).toBe(249); // trimmed from the END, not the start
    expect(out.truncated).toBe(true);
    // Three reads of 100 to overshoot 250, and no probe: overshooting is proof.
    expect(out.pages).toBe(3);
    expect(s.calls).toHaveLength(3);
  });

  it("reaching the ceiling on a SHORT page is not truncation, because there is no more", async () => {
    const s = source(300);
    const out = await collectPages(s.fetchPage, { pageSize: 100, maxRows: 300 });
    expect(out.rows).toHaveLength(300);
    expect(out.truncated).toBe(false);
  });

  it("a page size of zero is clamped instead of looping forever", async () => {
    const s = source(5);
    const out = await collectPages(s.fetchPage, { pageSize: 0 });
    expect(out.rows).toHaveLength(5);
    expect(s.calls.every((c) => c.limit >= 1)).toBe(true);
  });

  it("has sane defaults: one query covers an ordinary practice month", () => {
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThanOrEqual(500);
    expect(DEFAULT_MAX_ROWS).toBeGreaterThan(DEFAULT_PAGE_SIZE);
  });
});
