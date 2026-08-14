import type { PayRate } from "./types";

// ===========================================================================
// PRICING HOURS. INTEGER PENCE, EFFECTIVE DATED, PER DAY.
//
// TWO RULES, BOTH OF WHICH COST REAL MONEY IF BROKEN.
//
// 1. INTEGER PENCE, NEVER A FLOAT. Pounds as a decimal number is how a payroll
//    total ends up reading 1234.5600000000002, and how two people summing the
//    same column get different answers.
//
// 2. EACH DAY IS PRICED AT THE RATE IN FORCE ON THAT DAY. Taking "the current
//    rate" and multiplying it by the month's minutes silently RE-PRICES every
//    hour already worked: a rise on the 15th would back-date itself over the
//    first fortnight, and a fall would quietly claw pay back. That is why 0075
//    stores rates as appended, effective-dated rows rather than a mutable
//    column, and why nothing here ever asks for "the rate".
//
// PURE: no I/O, no clock. `rateOnDay` is given every rate and a day, and answers.
// ===========================================================================

const MINUTES_PER_HOUR = 60;

/**
 * The hourly rate in force on one London day, or null when there is none.
 *
 * Null is not zero. A staff member with no rate recorded has an UNKNOWN cost,
 * and the report says so; pricing them at zero would present unpaid work as a
 * fact and make a month look cheaper than it is.
 *
 * RESOLUTION RULE: among the rows that cover the day, the one with the LATEST
 * `effectiveFrom` wins. That is what makes append-only history work. A pay rise
 * is a new row starting on the rise date, and the old row is usually left open
 * ended (nobody remembers to close it), so overlapping open rows are the NORMAL
 * state rather than an error to reject.
 */
export function rateOnDay(dayKey: string, rates: readonly PayRate[]): number | null {
  let best: PayRate | null = null;
  for (const rate of rates) {
    if (!Number.isFinite(rate.hourlyPence)) continue;
    if (rate.effectiveFrom > dayKey) continue;
    if (rate.effectiveTo && rate.effectiveTo < dayKey) continue;
    if (!best || rate.effectiveFrom > best.effectiveFrom) best = rate;
  }
  return best ? Math.round(best.hourlyPence) : null;
}

/**
 * What `minutes` at `ratePence` per hour comes to, in whole pence.
 *
 * Rounded once, per day, by the caller's day loop: rounding each day is what
 * makes the printed daily figures add up to the printed monthly one. Rounding
 * only at the end would produce a total nobody can reconcile against the rows
 * above it.
 */
export function costPence(minutes: number, ratePence: number): number {
  if (!Number.isFinite(minutes) || !Number.isFinite(ratePence)) return 0;
  if (minutes <= 0 || ratePence <= 0) return 0;
  return Math.round((minutes * ratePence) / MINUTES_PER_HOUR);
}

export interface DayMinutes {
  /** London day key, `YYYY-MM-DD`. */
  dayKey: string;
  minutes: number;
}

export interface PricedDays {
  /** Total, or null when any day with minutes could not be priced. */
  costPence: number | null;
  /** Days with minutes and no rate in force. */
  unpricedDays: number;
  /** Distinct rates that priced this set. More than one is a mid-period change. */
  ratesApplied: number;
  /** The rate in force on the last priced day, for display. */
  lastRatePence: number | null;
}

/**
 * Price a set of days, each at its own rate.
 *
 * If ANY day with worked minutes has no rate, the total is null. Summing the
 * days we could price and presenting it as the month's cost is the quiet
 * undercount this whole module is written to avoid; `unpricedDays` tells the
 * screen exactly what to say instead.
 */
export function priceDays(days: readonly DayMinutes[], rates: readonly PayRate[]): PricedDays {
  let total = 0;
  let unpriced = 0;
  let lastRate: number | null = null;
  let lastDay = "";
  const distinct = new Set<number>();

  for (const day of days) {
    if (day.minutes <= 0) continue;
    const rate = rateOnDay(day.dayKey, rates);
    if (rate === null) {
      unpriced += 1;
      continue;
    }
    distinct.add(rate);
    total += costPence(day.minutes, rate);
    if (day.dayKey >= lastDay) {
      lastDay = day.dayKey;
      lastRate = rate;
    }
  }

  return {
    costPence: unpriced > 0 ? null : total,
    unpricedDays: unpriced,
    ratesApplied: distinct.size,
    lastRatePence: lastRate,
  };
}

/**
 * A typed amount of pounds ("12.50", "£12.50", "1,234.56") as integer pence, or
 * null when it is not a money amount.
 *
 * Parsed as DIGITS, never via `parseFloat(x) * 100`: that multiplication is how
 * 12.10 becomes 1209.9999999999998 and then 1209 under a floor, and an hourly
 * rate a penny short is wrong on every hour anybody works.
 *
 * More than two decimal places is REFUSED rather than rounded: somebody typing
 * an hourly rate to three places means something we should not guess at.
 */
export function poundsToPence(value: string): number | null {
  const cleaned = value.replace(/[£,\s]/g, "");
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]);
  const fraction = Number((m[3] ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(whole)) return null;
  return sign * (whole * 100 + fraction);
}

/**
 * Pence as "£1,234.56", built with integer arithmetic.
 *
 * `(pence / 100).toFixed(2)` is the obvious form and it goes through a float on
 * the way, which is precisely the thing this module refuses to do with money.
 */
export function poundsLabel(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(Math.round(pence));
  const whole = Math.floor(abs / 100);
  const part = String(abs % 100).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}£${grouped}.${part}`;
}
