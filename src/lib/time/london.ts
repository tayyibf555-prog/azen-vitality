// ---------------------------------------------------------------------------
// London-local date helpers.
//
// The practice operates in the UK (Europe/London) but the app runs on UTC hosts
// (Vercel). Bucketing "today"/"tomorrow" or computing overdue-by-N on raw UTC
// instants mis-buckets events around the local midnight boundary and shows the
// wrong local time. Every function here resolves the Europe/London calendar day
// (or wall-clock time) via Intl, which applies BST/GMT DST automatically.
//
// Pure functions only: no I/O, no Date.now() reads. Callers pass `now`.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The Europe/London calendar day for an instant, as `YYYY-MM-DD`. */
export function londonDayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Whether two instants fall on the same Europe/London calendar day. */
export function isSameLondonDay(a: Date, b: Date): boolean {
  return londonDayKey(a) === londonDayKey(b);
}

/** Whether an ISO instant falls on the London day of `now`. */
export function isLondonToday(iso: string, now: Date): boolean {
  return londonDayKey(new Date(iso)) === londonDayKey(now);
}

/** Whether an ISO instant falls on the London day after `now`. */
export function isLondonTomorrow(iso: string, now: Date): boolean {
  return londonDayKey(new Date(iso)) === londonDayKey(new Date(now.getTime() + DAY_MS));
}

/** Parse a `YYYY-MM-DD` day key to a UTC-midnight Date for stable day diffs. */
function dayKeyToUtcMidnight(key: string): number {
  return Date.parse(`${key}T00:00:00Z`);
}

/**
 * Whole-day difference between the London calendar day of `now` and of `dueIso`.
 * Positive = overdue, negative = due in the future, 0 = due today.
 *
 * Computed from the two `YYYY-MM-DD` day keys (parsed to UTC-midnight) so it is
 * a stable whole-day delta, never a fractional instant delta that drifts across
 * the local midnight boundary or DST changes.
 */
export function londonOverdueDays(dueIso: string, now: Date): number {
  const due = new Date(dueIso);
  // An unparseable date must never read as overdue; fail safe to "far future".
  if (Number.isNaN(due.getTime())) return Number.NEGATIVE_INFINITY;
  const nowDay = dayKeyToUtcMidnight(londonDayKey(now));
  const dueDay = dayKeyToUtcMidnight(londonDayKey(due));
  return Math.round((nowDay - dueDay) / DAY_MS);
}

/**
 * A London calendar-date label for an instant, e.g. "17 May 1967". Used wherever a
 * date is a DATE rather than a moment: a date of birth, a recall date, an invoice
 * date. Returns "" for an unparseable value, so a caller renders nothing rather
 * than "Invalid Date".
 */
export function londonDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  });
}

/**
 * A London wall-clock label for an instant, e.g. "Sun 28 Jun, 09:00".
 * Guards an unparseable instant to "soon".
 */
export function londonDateTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

/**
 * The same wall-clock label WITH the year, e.g. "Sun 28 Jun 2024, 09:00".
 *
 * The bare label is right for near-term rows (a confirmation, a recent message) where
 * the year is obvious. It is WRONG for a full appointment history that spans years: a
 * patient with a decade on file has rows a reader cannot date without the year, and
 * "Thu 17 Sept" for a 2019 visit reads as this year. Kept as its own function so the
 * near-term surfaces are not made noisier to fix the historical one.
 */
export function londonDateTimeLabelWithYear(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}
