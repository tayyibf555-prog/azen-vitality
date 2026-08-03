import "server-only";
import { shiftDayKey, type DayCoverage } from "@/lib/dashboard/period";

// ---------------------------------------------------------------------------
// Paging a newest-first, date-unfilterable Dentally endpoint backwards.
//
// This is the same discipline the dashboard read layer uses (src/lib/dashboard/
// read.ts), reproduced here so the reports read path does not reach into that
// file's module-private helper. Dentally ignores every date filter on /v1/payments
// and /v1/nhs_claims and returns both newest first, so the only honest way to
// total a window is to page from today backwards until the boundary day is passed,
// and to report how far back the scan genuinely reached. A window the scan could
// not reach is reported unavailable, never totalled from a truncated set.
// ---------------------------------------------------------------------------

export const REPORTS_PER_PAGE = 100;

/** 100 rows a page × 60 pages = 6,000 rows per site — a generous month-report bound. */
export const REPORTS_SCAN_MAX_PAGES = 60;

/** The narrower of two coverage spans; null when either is null. */
export function intersectCoverage(a: DayCoverage | null, b: DayCoverage | null): DayCoverage | null {
  if (a === null || b === null) return null;
  const from = a.from > b.from ? a.from : b.from;
  const to = a.to < b.to ? a.to : b.to;
  return from <= to ? { from, to } : null;
}

/**
 * Page backwards until `boundaryDay` is passed, reporting how far back the scan
 * genuinely reached. A budget exhausted mid-history narrows coverage to the day
 * AFTER the oldest row seen: a half-collected oldest day, half-totalled, is worse
 * than not totalled.
 */
export async function scanBackwards(
  fetchPage: (page: number) => Promise<unknown[]>,
  dayOf: (raw: unknown) => string | null,
  boundaryDay: string,
  today: string,
): Promise<{ raw: unknown[]; coverage: DayCoverage | null }> {
  const raw: unknown[] = [];
  let oldestSeen: string | null = null;
  let exhausted = false;
  let passedBoundary = false;

  for (let page = 1; page <= REPORTS_SCAN_MAX_PAGES; page += 1) {
    const rows = await fetchPage(page);
    raw.push(...rows);
    for (const row of rows) {
      const day = dayOf(row);
      if (day === null) continue;
      if (oldestSeen === null || day < oldestSeen) oldestSeen = day;
    }
    if (rows.length < REPORTS_PER_PAGE) {
      exhausted = true;
      break;
    }
    if (oldestSeen !== null && oldestSeen < boundaryDay) {
      passedBoundary = true;
      break;
    }
  }

  if (exhausted || passedBoundary) return { raw, coverage: { from: boundaryDay, to: today } };
  if (oldestSeen === null) return { raw, coverage: null };
  const from = shiftDayKey(oldestSeen, 1);
  if (from === null || from > today) return { raw, coverage: null };
  return { raw, coverage: { from, to: today } };
}
