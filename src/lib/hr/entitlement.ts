import type { Availability, Weekday } from "@/lib/rota/types";

// ===========================================================================
// HOLIDAY ENTITLEMENT: DECISION SUPPORT, NOT LEGAL ADVICE.
//
// This module computes the statutory starting point for a staff member's paid
// holiday and shows its working. It does NOT decide anybody's entitlement, and
// the screens that render it say so out loud, in the same posture the compliance
// module already takes.
//
// What it models: the statutory 5.6 weeks (capped at 28 days), scaled by the
// days a person works in a week, pro-rated when they join or leave part way
// through the leave year, and overridable at two levels by the manager.
//
// What it deliberately does NOT model: irregular-hours and part-year workers
// (the 12.07 percent accrual rules), bank holidays as part of or on top of the
// entitlement, carry-over, sickness accrual, and anything contractual above the
// statutory floor. Those have their own rules and pretending otherwise would be
// worse than saying nothing, because a manager would act on it.
//
// PURE. No I/O, no Date.now(), no React. Every date is a London calendar day key
// (`YYYY-MM-DD`), which sorts lexicographically in chronological order, so range
// comparisons are string comparisons: no Date objects in the rules, no DST edge,
// no timezone drift. The one place Date is used is day ARITHMETIC, anchored at
// UTC midnight where an hour of DST cannot move a day.
// ===========================================================================

/** The statutory minimum, in weeks. 5.6 weeks is 28 days for a five-day week. */
export const STATUTORY_WEEKS = 5.6;

/** The statutory cap, in days. Six and seven day weeks do not earn more. */
export const STATUTORY_CAP_DAYS = 28;

/** The default leave year start month. April is the common UK default. */
export const DEFAULT_LEAVE_YEAR_START_MONTH = 4;

const DAY_MS = 86_400_000;

const WEEKDAYS: readonly Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a string is a `YYYY-MM-DD` day key we can compute with. */
export function isDayKey(value: unknown): value is string {
  return typeof value === "string" && DAY_KEY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Round to one decimal place. Entitlement is quoted in halves and tenths of a day. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function utcMs(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00Z`);
}

/** Inclusive whole days between two day keys. Same day is 1. Reversed is 0. */
export function inclusiveDays(startDay: string, endDay: string): number {
  if (!isDayKey(startDay) || !isDayKey(endDay)) return 0;
  const span = Math.round((utcMs(endDay) - utcMs(startDay)) / DAY_MS) + 1;
  return span > 0 ? span : 0;
}

/**
 * How many days a week this person works, counted from their rota availability.
 *
 * Reuses the rota's `Availability` map — the same one `workingDaysInRange` reads
 * in the absence rules — so the two modules cannot disagree about which days
 * somebody works. A missing weekday key means not available, never "unknown".
 */
export function daysPerWeekFromAvailability(availability: Availability | null | undefined): number {
  if (!availability) return 0;
  return WEEKDAYS.reduce((count, day) => (availability[day] === true ? count + 1 : count), 0);
}

/**
 * The statutory entitlement in days for a given working week.
 *
 * `daysPerWeek * 5.6`, capped at 28. Computed as `daysPerWeek * 56 / 10` rather
 * than `* 5.6`, because 3 * 5.6 is 16.799999999999997 in binary floating point
 * and a holiday balance that reads 16.799999999999997 is a bug report.
 */
export function statutoryDays(daysPerWeek: number): number {
  if (!Number.isFinite(daysPerWeek) || daysPerWeek <= 0) return 0;
  const days = Math.round(daysPerWeek * 56) / 10;
  return Math.min(round1(days), STATUTORY_CAP_DAYS);
}

export interface LeaveYear {
  /** First day of the leave year, inclusive. */
  start: string;
  /** Last day of the leave year, inclusive. */
  end: string;
}

/**
 * The leave year CONTAINING `onDay`, for a practice whose leave year starts on
 * the first of `startMonth`.
 *
 * The end is derived as "the day before the same date next year", so a leave
 * year spanning 29 February is 366 days without a leap-year rule of our own.
 */
export function leaveYearBounds(startMonth: number, onDay: string): LeaveYear {
  const month =
    Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12
      ? startMonth
      : DEFAULT_LEAVE_YEAR_START_MONTH;
  const safeDay = isDayKey(onDay) ? onDay : "1970-01-01";
  const year = Number(safeDay.slice(0, 4));
  const onMonth = Number(safeDay.slice(5, 7));
  const startYear = onMonth >= month ? year : year - 1;

  const start = new Date(Date.UTC(startYear, month - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(startYear + 1, month - 1, 1) - DAY_MS).toISOString().slice(0, 10);
  return { start, end };
}

/**
 * Entitlement scaled to the part of the leave year somebody is actually employed
 * for, as a proportion of CALENDAR days.
 *
 * Calendar days, not working days, is the ordinary way a part year is pro-rated
 * and it is the one that behaves sensibly when the working pattern is uneven
 * across the week. The window is clamped to the leave year, so a window outside
 * it returns 0 rather than a negative or an over-full year.
 */
export function proRataForWindow(
  entitlementDays: number,
  windowStart: string,
  windowEnd: string,
  leaveYear: LeaveYear,
): number {
  if (!Number.isFinite(entitlementDays) || entitlementDays <= 0) return 0;
  const total = inclusiveDays(leaveYear.start, leaveYear.end);
  if (total === 0) return 0;

  const from = windowStart > leaveYear.start ? windowStart : leaveYear.start;
  const to = windowEnd < leaveYear.end ? windowEnd : leaveYear.end;
  const covered = inclusiveDays(from, to);
  if (covered === 0) return 0;
  if (covered >= total) return round1(entitlementDays);

  return round1((entitlementDays * covered) / total);
}

/**
 * The brief's named form: a mid-year JOINER, employed from `startDate` to the
 * end of the leave year.
 *
 * Delegates to `proRataForWindow` so there is exactly one pro-rata calculation
 * in this module and the two cannot drift.
 */
export function proRataForPartYear(
  entitlementDays: number,
  startDate: string,
  leaveYearStart: string,
  leaveYearEnd: string,
): number {
  return proRataForWindow(entitlementDays, startDate, leaveYearEnd, {
    start: leaveYearStart,
    end: leaveYearEnd,
  });
}

export interface EntitlementInput {
  /** The rota availability map; the default source of "days a week". */
  availability?: Availability | null;
  /** HR profile override of the availability-derived count. */
  contractedDaysPerWeek?: number | null;
  /** HR profile override of the computed entitlement. The manager's final word. */
  entitlementDaysOverride?: number | null;
  employmentStart?: string | null;
  employmentEnd?: string | null;
  /** 1..12; anything else falls back to April. */
  leaveYearStartMonth?: number | null;
  /** The London day the answer is "as of": it picks the leave year. */
  onDay: string;
}

export type EntitlementBasis = "override" | "pro-rata" | "statutory" | "not-employed";

export interface EntitlementResult {
  /** Days of paid holiday for this leave year. */
  days: number;
  /** The working week the figure rests on. */
  daysPerWeek: number;
  /** Which rule produced `days`, so the screen can show its working. */
  basis: EntitlementBasis;
  /** True when the 28 day statutory cap bit (a six or seven day week). */
  capped: boolean;
  /** Whether `daysPerWeek` came from the HR profile rather than the rota. */
  daysPerWeekFromProfile: boolean;
  leaveYear: LeaveYear;
  /** One sentence of working, ready to render. Quiet and factual. */
  note: string;
}

/**
 * The whole entitlement question, answered once, with its working.
 *
 * The precedence, highest first:
 *   1. `entitlementDaysOverride` — the manager's final word, which wins outright
 *      because the statutory formula is decision support and a real contract can
 *      say anything above the floor;
 *   2. the employed window inside this leave year — nothing employed, nothing
 *      accrued;
 *   3. `contractedDaysPerWeek`, else the rota availability count;
 *   4. the statutory formula, pro-rated if the employed window is a part year.
 *
 * The component that renders this holds none of that: it prints `days`, `basis`
 * and `note`.
 */
export function resolveEntitlement(input: EntitlementInput): EntitlementResult {
  const leaveYear = leaveYearBounds(
    input.leaveYearStartMonth ?? DEFAULT_LEAVE_YEAR_START_MONTH,
    input.onDay,
  );

  const fromProfile =
    typeof input.contractedDaysPerWeek === "number" &&
    Number.isFinite(input.contractedDaysPerWeek) &&
    input.contractedDaysPerWeek > 0;
  const daysPerWeek = fromProfile
    ? Math.min(round1(input.contractedDaysPerWeek as number), 7)
    : daysPerWeekFromAvailability(input.availability);

  const full = statutoryDays(daysPerWeek);
  const capped = daysPerWeek * 5.6 > STATUTORY_CAP_DAYS;

  // 1. The override wins outright, including over "not employed this year": if a
  //    manager has typed a number, that number is the answer.
  const override = input.entitlementDaysOverride;
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return {
      days: round1(override),
      daysPerWeek,
      basis: "override",
      capped: false,
      daysPerWeekFromProfile: fromProfile,
      leaveYear,
      note: `Set by the practice at ${round1(override)} days for the leave year from ${leaveYear.start}.`,
    };
  }

  // 2. The employed window inside this leave year.
  const employedFrom =
    isDayKey(input.employmentStart) && input.employmentStart! > leaveYear.start
      ? input.employmentStart!
      : leaveYear.start;
  const employedTo =
    isDayKey(input.employmentEnd) && input.employmentEnd! < leaveYear.end
      ? input.employmentEnd!
      : leaveYear.end;

  if (employedFrom > employedTo) {
    return {
      days: 0,
      daysPerWeek,
      basis: "not-employed",
      capped: false,
      daysPerWeekFromProfile: fromProfile,
      leaveYear,
      note: `Not employed during the leave year from ${leaveYear.start} to ${leaveYear.end}.`,
    };
  }

  const partYear = employedFrom !== leaveYear.start || employedTo !== leaveYear.end;
  if (!partYear) {
    return {
      days: full,
      daysPerWeek,
      basis: "statutory",
      capped,
      daysPerWeekFromProfile: fromProfile,
      leaveYear,
      note:
        daysPerWeek > 0
          ? `${daysPerWeek} days a week at the statutory 5.6 weeks${capped ? ", capped at 28 days" : ""}.`
          : "No working days recorded, so no statutory entitlement is computed.",
    };
  }

  const prorated = proRataForWindow(full, employedFrom, employedTo, leaveYear);
  return {
    days: prorated,
    daysPerWeek,
    basis: "pro-rata",
    capped,
    daysPerWeekFromProfile: fromProfile,
    leaveYear,
    note: `${full} days a year, pro-rated for ${inclusiveDays(employedFrom, employedTo)} of ${inclusiveDays(leaveYear.start, leaveYear.end)} days employed.`,
  };
}
