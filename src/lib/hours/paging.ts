// ===========================================================================
// THE PAGED READ, AS A PURE DRIVER.
//
// WHY THIS FILE EXISTS. `listEvents` in src/lib/clock/repository.ts caps every
// read at 500 rows (DEFAULT_EVENT_LIMIT). That is right for a day view and
// catastrophic for a month: thirty staff clocking in and out twice a day is
// roughly 1,800 events, so the read SILENTLY returns the first 500 and the month
// report understates everybody's hours, and therefore their pay, with no error
// anywhere. A quiet undercount on a payroll figure is the worst class of bug in
// this module, so the cap is fixed before the report ships.
//
// The loop that walks the pages is separated from the query that fetches one,
// because the loop is where the bugs live (an offset that does not advance, a
// short page that does not stop it, a ceiling that silently drops rows) and the
// query needs a database. `fetchPage` is injected, so every one of those cases
// is a test in this file rather than a hope.
//
// PURE. No I/O of its own, no server-only import: vitest imports it directly.
// ===========================================================================

export interface CollectOptions {
  /** Rows per query. */
  pageSize?: number;
  /**
   * The hard ceiling. Reaching it does NOT throw and does NOT silently trim
   * without saying so: the result carries `truncated: true`, and the callers
   * refuse to call the month final while it is set.
   */
  maxRows?: number;
}

export interface Collected<T> {
  rows: T[];
  /**
   * True when the ceiling was reached and there may be more rows we have not
   * read. The report must say so out loud rather than present a short month as
   * a complete one.
   */
  truncated: boolean;
  /** How many queries were issued. Useful in logs when a month reads slowly. */
  pages: number;
}

/** Big enough that a normal month is one or two queries, small enough to be a bounded read. */
export const DEFAULT_PAGE_SIZE = 1000;

/**
 * Ten thousand clock events is roughly a hundred staff clocking four times a day
 * for a month. Beyond that something is wrong with the data, and reading
 * unboundedly to find out is not the answer.
 */
export const DEFAULT_MAX_ROWS = 10_000;

/**
 * Walk a paged source to exhaustion, or to the ceiling, whichever comes first.
 *
 * Stops on the FIRST short page (fewer rows than asked for), which is the only
 * reliable end-of-data signal a range query gives, and on an empty page, which
 * is what a source that ignores the offset would return forever.
 */
export async function collectPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<T[]>,
  opts?: CollectOptions,
): Promise<Collected<T>> {
  // Clamped, because a pageSize of 0 would advance the offset by nothing and
  // read the same page until the process died.
  const pageSize = Math.max(1, Math.floor(opts?.pageSize ?? DEFAULT_PAGE_SIZE));
  const maxRows = Math.max(1, Math.floor(opts?.maxRows ?? DEFAULT_MAX_ROWS));

  const rows: T[] = [];
  let pages = 0;
  let offset = 0;

  for (;;) {
    const page = await fetchPage(offset, pageSize);
    pages += 1;
    rows.push(...page);

    // Exhausted: a short page (including an empty one) means there is no more.
    if (page.length < pageSize) return { rows, truncated: false, pages };

    if (rows.length >= maxRows) {
      // Overshot the ceiling: rows were definitely dropped.
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), truncated: true, pages };

      // Landed exactly ON the ceiling with a full page, so we cannot yet tell a
      // complete month from a truncated one. PROBE for a single further row
      // rather than guess: guessing "truncated" cries wolf on every month whose
      // size happens to divide the ceiling, and guessing "complete" is the
      // silent undercount this module exists to prevent.
      const probe = await fetchPage(offset + pageSize, 1);
      pages += 1;
      return { rows, truncated: probe.length > 0, pages };
    }

    offset += pageSize;
  }
}
