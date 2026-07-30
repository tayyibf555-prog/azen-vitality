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
