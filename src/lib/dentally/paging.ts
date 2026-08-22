// ---------------------------------------------------------------------------
// THE BOUNDED PAGER. One copy, for every read in this repo that walks a Dentally
// list to a short page and stops at a ceiling.
//
// WHY IT IS HERE AND NOT IN EITHER OF THE FILES THAT USED TO OWN IT.
//
// There were two of these, line for line the same walk:
//
//   src/lib/dentally/read.ts          `pageBounded` — the DISPLAY reads (a name map,
//                                     a patient list, an appointment feed). It threw
//                                     the truncation away.
//   src/lib/dentally/charting-read.ts `pageToCeiling` — the chart reads. Identical
//                                     loop, except that it RETURNED the truncation,
//                                     because a chart cut off at the bound is a
//                                     partial clinical record and the screen says so.
//
// Two copies of one loop is two places to keep a stop in step, and they had already
// drifted from the third pager in the same way: BOTH measured a short page against
// their own module's `PER_PAGE` constant while each caller chose `per_page` inside
// its own closure. Nothing tied the size ASKED FOR to the size MEASURED AGAINST. Ask
// for 50 rows a page and the first full page (50) reads as SHORT, the walk ends on
// page one, and a truncated read comes back looking exactly like a whole one — the
// same defect `pageAll` (src/lib/reports/scan.ts) was fixed for, in the same week,
// two directories away. The two constants happening to agree is not a guarantee;
// passing one value to both is, which is why `perPage` is an argument here and is
// HANDED TO `fetchPage` rather than closed over by it.
//
// WHAT IT IS NOT. It is not `pageAll`. This pager has NO completeness signal beyond
// "did I run out of pages": it never consults `meta.total`, so a walk that ends on a
// short page is assumed to have ended at the end of the list. That assumption is
// sound for the reads on it (one patient's notes, one site's practitioner list) and
// is NOT sound for anything that will be summed, counted or printed as a total.
// Those belong on `pageAll`, where "did the walk finish?" is measured against
// Dentally's own row count and answered.
//
// TRUNCATION IS RETURNED, NEVER SWALLOWED. The DISPLAY callers that do not act on it
// destructure `.rows` and say so at the call site; that is a caller's decision taken
// in the open, not a fact the pager threw away on their behalf.
// ---------------------------------------------------------------------------

/**
 * `meta.total` — how many rows Dentally says match the query — or null when the
 * envelope does not carry one.
 *
 * WHY THIS GRAMMAR EXISTS TWICE IN THE REPO, WHICH IS NOT AN ACCIDENT AND IS PINNED.
 *
 * src/lib/reports/scan.ts holds the same parser and is the one the reports and
 * dashboard read paths share. This layer CANNOT import it: that module opens with
 * `import "server-only"`, and dentally/read.ts is imported by thirty test files and
 * by client-reachable code paths that do not carry that boundary — pulling it in
 * takes the whole Next server-only guard with it and breaks them at resolution.
 * Copying a twelve-line pure parser is the smaller evil, and the copy is not left to
 * drift: paging.test.ts feeds BOTH implementations the same table of envelopes and
 * fails if they ever disagree about a single one. One grammar, two homes, proven
 * equal — rather than two grammars that happen to agree today.
 *
 * Null is not an error: some endpoints omit it, and the caller then falls back to
 * the short-page heuristic.
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

/** What a bounded walk brings back, and whether it reached the end of the list. */
export interface BoundedRead<T> {
  rows: T[];
  /** True when the walk ran out of PAGES rather than out of rows. */
  truncated: boolean;
}

/**
 * Page a list to its first short page, or to `maxPages` — AND SAY WHICH.
 *
 * `perPage` is passed to `fetchPage` and is the size a short page is measured
 * against, so the two cannot disagree. See the header for why that matters.
 */
export async function pageToCeiling<T>(
  fetchPage: (page: number, perPage: number) => Promise<T[]>,
  perPage: number,
  maxPages: number,
): Promise<BoundedRead<T>> {
  const rows: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await fetchPage(page, perPage);
    rows.push(...batch);
    if (batch.length < perPage) return { rows, truncated: false }; // short page => last page
  }
  // Ran out of pages before running out of rows. Not an error, but not a complete
  // read either, and the difference is the whole reason this flag exists.
  return { rows, truncated: true };
}
