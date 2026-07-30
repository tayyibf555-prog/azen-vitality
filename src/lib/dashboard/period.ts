// ---------------------------------------------------------------------------
// The five dashboard periods, as Europe/London calendar day windows.
//
// The takings strip is TODAY / YESTERDAY / LAST 7 DAYS / LAST 30 DAYS /
// LAST 90 DAYS, and every panel below it is driven by whichever cell is
// selected. Every one of those boundaries is a LOCAL day boundary: the practice
// closes at a London evening, not at UTC midnight. Bucketing on a UTC slice
// misfiles every payment taken after 23:00 BST into the following day, which
// during summer is one hour of takings landing on the wrong cell each night.
//
// So the anchor day always comes from londonDayKey(), and day arithmetic then
// runs on the `YYYY-MM-DD` key itself. Shifting a day key via UTC midnight is
// exact: London is UTC+0 or UTC+1, never behind, so a UTC-midnight instant
// always falls on the same London calendar date it was built from.
//
// Pure functions only: callers pass `now`.
// ---------------------------------------------------------------------------

import { londonDayKey } from "@/lib/time/london";

const DAY_MS = 86_400_000;

export type DashboardPeriod = "today" | "yesterday" | "last7" | "last30" | "last90";

/** Left-to-right order of the takings strip. */
export const DASHBOARD_PERIODS: readonly DashboardPeriod[] = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "last90",
] as const;

/** British English labels, matching the strip she reads in Dentally. */
export const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last30: "Last 30 days",
  last90: "Last 90 days",
};

/** An inclusive window of London calendar days. */
export interface DayWindow {
  /** First day in the window, `YYYY-MM-DD`, inclusive. */
  from: string;
  /** Last day in the window, `YYYY-MM-DD`, inclusive. */
  to: string;
}

/** A `YYYY-MM-DD` key that is also a real calendar date. */
const DAY_KEY_GRAMMAR = /^\d{4}-\d{2}-\d{2}$/;

/** True when `value` is a well-formed, real `YYYY-MM-DD` day key. */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY_GRAMMAR.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t)) return false;
  // Rejects "2026-02-31", which Date.parse would otherwise roll forward.
  return new Date(t).toISOString().slice(0, 10) === value;
}

/** Shift a day key by whole calendar days. Returns null for a malformed key. */
export function shiftDayKey(key: string, days: number): string | null {
  if (!isDayKey(key)) return null;
  const shifted = new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). Null if either is malformed. */
export function dayKeyDiff(from: string, to: string): number | null {
  if (!isDayKey(from) || !isDayKey(to)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The Europe/London calendar day of `now`. */
export function londonToday(now: Date): string {
  return londonDayKey(now);
}

/**
 * The London day an ISO instant falls on, or null when it is unparseable.
 * Use this for anything with a time component (appointment start_time); use the
 * raw value for a bare Dentally date field such as `dated_on`, which carries no
 * time zone and is already the practice's own calendar day.
 */
export function londonDayOfIso(iso: unknown): string | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return londonDayKey(d);
}

/**
 * The inclusive London day window for a period.
 *
 * "Last 7 days" includes today, so the strip reads as five nested windows all
 * ending on the same day, which is how the periods compare in Dentally.
 */
export function periodWindow(period: DashboardPeriod, now: Date): DayWindow {
  const today = londonToday(now);
  const back = (days: number): string => shiftDayKey(today, -days) ?? today;
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = back(1);
      return { from: y, to: y };
    }
    case "last7":
      return { from: back(6), to: today };
    case "last30":
      return { from: back(29), to: today };
    case "last90":
      return { from: back(89), to: today };
  }
}

/** Number of days a window spans, inclusive. */
export function windowLength(w: DayWindow): number {
  const diff = dayKeyDiff(w.from, w.to);
  return diff === null ? 0 : diff + 1;
}

/** Whether a day key falls inside an inclusive window. */
export function isDayInWindow(day: string, w: DayWindow): boolean {
  return day >= w.from && day <= w.to;
}

/** Every day key in a window, oldest first. Used to check rollup completeness. */
export function daysInWindow(w: DayWindow): string[] {
  const length = windowLength(w);
  if (length <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i < length; i += 1) {
    const day = shiftDayKey(w.from, i);
    if (day === null) break;
    out.push(day);
  }
  return out;
}

/**
 * The span of London days a fetched data set is known to be COMPLETE for.
 *
 * This exists because Dentally ignores every date filter on /v1/payments and
 * returns newest first, so the only way to build a period total live is to page
 * backwards from today and stop once past the boundary. A caller that stops
 * early (page budget, timeout) has a partial set. It records how far back it
 * genuinely reached here, and the aggregator then reports any longer period as
 * unavailable rather than silently totalling a truncated scan.
 */
export interface DayCoverage {
  from: string;
  to: string;
}

/** Whether a coverage span fully contains a window. A null coverage covers nothing. */
export function coversWindow(coverage: DayCoverage | null | undefined, w: DayWindow): boolean {
  if (!coverage) return false;
  if (!isDayKey(coverage.from) || !isDayKey(coverage.to)) return false;
  return coverage.from <= w.from && coverage.to >= w.to;
}
