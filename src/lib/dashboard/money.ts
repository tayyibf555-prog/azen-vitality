// ---------------------------------------------------------------------------
// Money and decimal parsing for the dashboard panels.
//
// Dentally returns money as a STRING ("27.9", "185.00"), and UDA figures the
// same way ("1.56"). Parsing those with Number() turns "" into 0 and "n/a" into
// NaN. Both outcomes are unacceptable on a takings panel: a NaN poisons every
// sum it touches, and a zero is worse still because it looks like a real answer.
// The house rule is that a figure we cannot source is reported as unavailable,
// never as a plausible-looking zero.
//
// So every parser here returns `null` for anything it cannot read exactly, and
// callers count the nulls (dropped rows) rather than coercing them.
//
// Integer arithmetic, not floats: totalling 40,000 float pounds accumulates
// binary rounding error, and a takings total a penny out is a support ticket.
// Money is carried as whole PENCE, UDA as whole HUNDREDTHS of a UDA.
//
// Pure functions only: no I/O, no clock reads.
// ---------------------------------------------------------------------------

/**
 * The only accepted money grammar: optional minus, digits, optionally 1 or 2
 * decimal places. Deliberately strict.
 *   - "1,234.56" is rejected: a thousands separator is not something Dentally
 *     sends, so seeing one means we are reading a field we do not understand.
 *   - "27.999" is rejected: rounding it to 28.00 would be inventing a number.
 *   - "+27.9", "27.", ".9", "1e3", "" are all rejected.
 */
const MONEY_GRAMMAR = /^-?\d+(?:\.\d{1,2})?$/;

/** Longest string we will look at, so an absurd input cannot lose precision. */
const MAX_MONEY_CHARS = 20;

/**
 * Parse a Dentally money value to whole pence.
 *
 * Returns null (meaning: drop this row and count it) for anything malformed.
 * A JS number is accepted as already-parsed and rounded to the nearest penny;
 * only strings go through the strict grammar, because a string is raw wire data.
 */
export function parseMoneyPence(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const pence = Math.round(raw * 100);
    return Number.isSafeInteger(pence) ? pence : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MONEY_CHARS) return null;
  if (!MONEY_GRAMMAR.test(trimmed)) return null;

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ""] = unsigned.split(".");
  const pence = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(pence)) return null;
  return negative ? -pence : pence;
}

/**
 * The grammar for an AGGREGATE Dentally sends us, as opposed to one row's amount.
 * Same shape, but ANY number of decimal places, because an aggregate genuinely
 * carries more than two. Still deliberately strict: no separator, no exponent, no
 * sign but a leading minus.
 */
const AGGREGATE_GRAMMAR = /^-?\d+(?:\.\d+)?$/;

/** Longest aggregate string we will look at. Wider than one row's, since a
 *  practice-lifetime total plus a five-decimal tail is a long string. */
const MAX_AGGREGATE_CHARS = 32;

/**
 * Parse a Dentally AGGREGATE money value — `meta.total_amount` on /v1/payments —
 * to whole pence, EXACTLY, then round the sub-penny remainder to the nearest penny.
 *
 * WHY THIS IS NOT parseMoneyPence. Two reasons, both proven against live Dentally
 * on 2026-08-21 and both capable of putting a wrong number on a takings screen:
 *
 *   1. AN AGGREGATE CAN CARRY MORE THAN TWO DECIMALS, because individual payments
 *      can. Payment 28647 on site N15, dated 2025-07-18, has amount "0.0015", and
 *      that month's meta.total_amount is "46721.8015". parseMoneyPence REJECTS
 *      three or more decimals — correctly, for a row, where rounding one payment to
 *      the penny would be inventing a figure. On a total it is the opposite: the
 *      total is exact and it is only the PRESENTATION that has to land on a penny,
 *      which is what Dentally's own screens do. Refusing the whole window's takings
 *      because one payment in it was worth a seventh of a penny would blank a real
 *      number to avoid a sub-penny rounding, which is not a trade worth making.
 *
 *   2. Number(s) * 100 IS NOT SAFE HERE. Number("27240.9") * 100 is
 *      2724089.9999999995, so Math.round is doing load-bearing work on a figure the
 *      practice compares penny-for-penny against Dentally. This function never
 *      builds a fractional float at all: it splits the digit string and adds two
 *      INTEGERS, so "27240.9" is 2,724,090 pence by construction rather than by
 *      rounding luck. (Integers, not BigInt, because tsconfig targets ES2017 and
 *      BigInt literals are unavailable there — and every figure here sits safely
 *      inside 2^53: this practice's entire payment history is under 400 million
 *      pence.)
 *
 * Rounding is half away from zero, so a refund's sub-penny tail rounds the same
 * distance as a payment's. Returns null for anything it cannot read exactly — the
 * house rule holds: a figure we cannot source is reported unavailable, never as a
 * plausible-looking zero. Note that "0.0" is a REAL zero and parses to 0: a day
 * with no takings answers total_amount "0.0", which is not the same fact as a
 * failed read and must not be confused with one.
 */
export function parseAggregateAmountPence(raw: unknown): number | null {
  if (typeof raw === "number") {
    // Already a float, so the exactness above is gone before we were called. Kept
    // only so a caller handed a number does not silently get null.
    if (!Number.isFinite(raw)) return null;
    const pence = Math.round(raw * 100);
    return Number.isSafeInteger(pence) ? pence : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AGGREGATE_CHARS) return null;
  if (!AGGREGATE_GRAMMAR.test(trimmed)) return null;

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ""] = unsigned.split(".");
  const wholeUnits = Number(whole);
  // Every step below is integer + integer, so it is exact right up to the guard.
  if (!Number.isSafeInteger(wholeUnits) || wholeUnits > Number.MAX_SAFE_INTEGER / 100) return null;
  let pence = wholeUnits * 100 + Number(fraction.slice(0, 2).padEnd(2, "0"));
  // Everything finer than a penny, rounded half away from zero.
  const subPenny = fraction.slice(2);
  if (subPenny.length > 0 && subPenny[0] >= "5") pence += 1;

  if (!Number.isSafeInteger(pence)) return null;
  return negative ? -pence : pence;
}

/**
 * Parse a Dentally UDA value ("1.56", "3", "0") to whole hundredths of a UDA.
 * Same grammar and same failure contract as money: null means unreadable.
 */
export function parseUdaHundredths(raw: unknown): number | null {
  return parseMoneyPence(raw);
}

/** Whole pence back to pounds, for callers that need a plain number. */
export function penceToPounds(pence: number): number {
  return pence / 100;
}

/** Hundredths back to UDA units. */
export function hundredthsToUda(hundredths: number): number {
  return hundredths / 100;
}

/**
 * Format whole pence as sterling, British style: "£3,060.20", "-£148,846.60".
 * Kept here so no panel has to invent its own formatting.
 */
export function formatPenceGbp(pence: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(pence / 100);
}

/** Round to 2 decimal places, for derived figures (percentages, pace, projections). */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
