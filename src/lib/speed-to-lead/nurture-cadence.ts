// Lead nurture cadence - pure timing rules, no I/O.
//
// A contacted-but-quiet lead gets a gentle 3-touch nurture. The touches land on
// days 3, 10 and 21 after the first contact (the "last touch" moving forward), i.e.
// intervals of 3, then 7, then 11 days. nurture_step counts touches ALREADY sent
// (0..3); touch 3 is terminal.
//
// Kept dependency-free so both the repository (query cutoffs) and the sweep can use
// it without an import cycle, and so the cadence maths is unit-testable in isolation.

const DAY_MS = 86_400_000;

/** Days from the previous touch to the next, indexed by touches-already-sent. */
export const NURTURE_INTERVALS_DAYS = [3, 7, 11] as const;

/** Total nurture touches before the lead is retired to 'nurture_done'. */
export const NURTURE_MAX_TOUCHES = NURTURE_INTERVALS_DAYS.length; // 3

/** Never nurture a lead older than this (mirrors the SLA sweep's staleness guard). */
export const NURTURE_AGE_LIMIT_DAYS = 60;

/** Most nurture messages one sweep tick may send (bounds cost + blast radius). */
export const NURTURE_PER_TICK_CAP = 10;

/** How many due leads a single tick will even consider (bounds the DB scan). */
export const NURTURE_SCAN_LIMIT = 50;

/**
 * When the next nurture touch is due, given how many have already been sent and the
 * anchor instant (the last touch, or the first contact for the entry touch). Returns
 * null once the cadence is exhausted (all touches sent).
 *
 *   step 0 -> anchor + 3d  (entry: touch 1)
 *   step 1 -> anchor + 7d  (touch 2, ~day 10)
 *   step 2 -> anchor + 11d (touch 3, ~day 21)
 *   step 3 -> null         (terminal)
 */
export function nurtureNextAt(stepsSent: number, fromIso: string): string | null {
  if (stepsSent < 0 || stepsSent >= NURTURE_INTERVALS_DAYS.length) return null;
  const days = NURTURE_INTERVALS_DAYS[stepsSent];
  const base = Date.parse(fromIso);
  if (Number.isNaN(base)) return null;
  return new Date(base + days * DAY_MS).toISOString();
}

/** Whether the given number of sent touches completes the nurture cadence. */
export function isNurtureComplete(stepsSent: number): boolean {
  return stepsSent >= NURTURE_MAX_TOUCHES;
}

/** ISO instant `days` before `now` (used for the entry + age-guard cutoffs). */
export function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}
