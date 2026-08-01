/**
 * Relative time, in words, against a fixed reference.
 *
 * PURE. No I/O, no Date.now(), no locale lookup: the caller passes `now`, so every
 * screen that renders a relative time is testable and stable across a re-render.
 *
 * WHY THIS EXISTS. The original helper in lib/utils.ts stopped at days and had no
 * future tense at all, which produced two lies on a clinical record:
 *   - a recall due in three months read "just now" (a negative difference fell
 *     through the `mins < 1` branch), and
 *   - a visit two years ago read "730 days ago", which nobody reads as two years.
 * Both appear on the patient record, where a misread date is a clinical-safety
 * problem rather than a cosmetic one, so the units run all the way to years and
 * the future tense is a first-class case.
 *
 * The vocabulary is deliberately the one already on screen elsewhere: "3 min ago",
 * "2 hr ago", "5 days ago". Only the units above days and the future tense are new,
 * so no existing screen changes wording for a value it could already express.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Mean days per month / per year, used only to choose the unit and its numeral.
 *  A calendar-exact month count is not worth the complexity for a phrase whose
 *  whole job is to be read at a glance. */
const DAYS_PER_MONTH = 30.44;
const DAYS_PER_YEAR = 365.25;

function phrase(count: number, unit: string, future: boolean, plural: boolean): string {
  const word = plural && count !== 1 ? `${unit}s` : unit;
  return future ? `in ${count} ${word}` : `${count} ${word} ago`;
}

/**
 * "3 min ago", "5 days ago", "3 weeks ago", "4 months ago", "2 years ago", and the
 * future forms "in 20 min", "in 3 months".
 *
 * Returns "" for an unparseable timestamp rather than "Invalid Date ago": a blank
 * is quiet, and every caller already renders around an empty cell.
 */
export function relativeLabel(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = now.getTime() - then;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);

  const mins = Math.round(abs / MINUTE_MS);
  if (mins < 1) return "just now";
  if (mins < 60) return phrase(mins, "min", future, false);

  const hours = Math.round(abs / HOUR_MS);
  if (hours < 24) return phrase(hours, "hr", future, false);

  const days = Math.round(abs / DAY_MS);
  if (days < 7) return phrase(days, "day", future, true);

  // Weeks are capped at 4 so a 30-day gap never reads "5 weeks" one day and
  // "1 month" the next.
  if (days < 31) return phrase(Math.min(4, Math.round(days / 7)), "week", future, true);

  // Months are capped at 11 for the same reason: "12 months ago" and "1 year ago"
  // must not both be reachable.
  if (days < 365) return phrase(Math.min(11, Math.max(1, Math.round(days / DAYS_PER_MONTH))), "month", future, true);

  return phrase(Math.max(1, Math.round(days / DAYS_PER_YEAR)), "year", future, true);
}
