// ---------------------------------------------------------------------------
// The date windows the two flagship reports are run over.
//
// Blerta's questions are always period-shaped: "how many band ones this MONTH",
// "the report I run at the END OF THE MONTH". So the report offers her the same
// windows she thinks in — this month, last month, a quarter, the contract year
// to date — plus a free from/until. Every window is an inclusive span of
// Europe/London calendar days, the same day model the takings strip uses, so a
// payment taken at 22:00 on the last of the month lands in the right month.
//
// Pure functions only: callers pass `now`. No clock read in here.
// ---------------------------------------------------------------------------

import { nhsContractYear } from "@/lib/dashboard/uda";
import {
  dayKeyDiff,
  isDayKey,
  londonToday,
  shiftDayKey,
  type DayWindow,
} from "@/lib/dashboard/period";

export type ReportPreset =
  | "this_month"
  | "last_month"
  | "last_7"
  | "last_30"
  | "this_quarter"
  | "contract_ytd";

export const REPORT_PRESETS: readonly ReportPreset[] = [
  "this_month",
  "last_month",
  "last_7",
  "last_30",
  "this_quarter",
  "contract_ytd",
] as const;

export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_7: "Last 7 days",
  last_30: "Last 30 days",
  this_quarter: "This quarter",
  contract_ytd: "Contract year to date",
};

/** The first day of the month a day key falls in. */
export function firstOfMonth(dayKey: string): string {
  return `${dayKey.slice(0, 7)}-01`;
}

/** The last day of the month a day key falls in. */
export function lastOfMonth(dayKey: string): string {
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  const nextMonthYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextFirst = `${String(nextMonthYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
  return shiftDayKey(nextFirst, -1) ?? dayKey;
}

/** The first day of the calendar quarter a day key falls in. */
export function firstOfQuarter(dayKey: string): string {
  const year = dayKey.slice(0, 4);
  const month = Number(dayKey.slice(5, 7));
  const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
  return `${year}-${String(quarterStartMonth).padStart(2, "0")}-01`;
}

/** The inclusive London day window for a preset. */
export function presetWindow(preset: ReportPreset, now: Date): DayWindow {
  const today = londonToday(now);
  switch (preset) {
    case "this_month":
      return { from: firstOfMonth(today), to: today };
    case "last_month": {
      const firstThis = firstOfMonth(today);
      const lastPrev = shiftDayKey(firstThis, -1) ?? today;
      return { from: firstOfMonth(lastPrev), to: lastPrev };
    }
    case "last_7":
      return { from: shiftDayKey(today, -6) ?? today, to: today };
    case "last_30":
      return { from: shiftDayKey(today, -29) ?? today, to: today };
    case "this_quarter":
      return { from: firstOfQuarter(today), to: today };
    case "contract_ytd":
      return { from: nhsContractYear(now).start, to: today };
  }
}

/**
 * A window from an explicit from/until pair, or null when either is not a real
 * day key or the order is reversed. A bad custom range must not silently become
 * "everything" — an empty result the caller can explain is safer than a total
 * over a window nobody asked for.
 */
export function customWindow(from: unknown, to: unknown): DayWindow | null {
  if (!isDayKey(from) || !isDayKey(to)) return null;
  if ((dayKeyDiff(from, to) ?? -1) < 0) return null;
  return { from, to };
}

/** A human label for a window, e.g. "1–31 August 2026" style, kept plain. */
export function windowLabel(w: DayWindow): string {
  return w.from === w.to ? w.from : `${w.from} to ${w.to}`;
}

/**
 * The preset the allocation report OPENS on — server page and client component
 * must agree, and this is the one module both may import.
 *
 * IT MUST NOT LIVE IN flagship-reports.tsx. That file is "use client", and under
 * React Server Components EVERY export of a client module — components and plain
 * constants alike — becomes a client-reference proxy when a server component
 * imports it. The server page once imported this constant from there: the proxy
 * matched no presetWindow case, the window came back undefined, and the reports
 * page 500d at render while tsc, vitest (plain node ignores the directive) and
 * the production build all stayed green. Render-time only, invisible to every
 * gate — which is why the constant lives HERE and reports-view.test.ts pins the
 * import path.
 */
export const PAY_DEFAULT_PRESET: ReportPreset = "last_7";
