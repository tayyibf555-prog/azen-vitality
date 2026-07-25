// ---------------------------------------------------------------------------
// How many lifecycle cadences ONE sync run is allowed to create.
//
// The recall and reactivation syncs classify targets but nothing in the product
// ever enrolled them, so a switched-on module sent nothing at all. The syncs now
// auto-enrol, which means a single run could otherwise start a cadence for every
// one of the thousands of stored targets and the sweep would then message real
// patients at that rate. This is the bound that makes that impossible.
//
// Three independent brakes, all of which must allow the enrolment:
//   1. the owner's kill switch for the module,
//   2. the module's daily automated-contact cap, minus what has already been
//      queued today AND minus the cadences already waiting to send (that backlog
//      will spend today's budget, so enrolling more just piles up messages),
//   3. a hard per-run ceiling, whatever the daily budget allows.
//
// Pure: no clock, no I/O, so the arithmetic is unit tested rather than reasoned
// about in a route.
// ---------------------------------------------------------------------------

export interface EnrolmentBudgetInput {
  /** False when the owner has the module switched off (kill switch). */
  systemEnabled: boolean;
  /** The module's daily automated-contact cap, per Europe/London day. */
  dailyLimit: number;
  /** Messages the module has already queued today. */
  usedToday: number;
  /** Active cadences already due to send, which will spend today's budget. */
  pendingDue: number;
  /** Hard ceiling on a single run, whatever the daily budget allows. */
  perRunCap: number;
}

/** A count that can be trusted, or Infinity so a broken input fails CLOSED. */
function safeCount(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : Number.POSITIVE_INFINITY;
}

/**
 * The number of cadences this run may create. Always a whole number >= 0, and 0
 * whenever anything about the inputs is off, so a misread limit can never be
 * mistaken for "unlimited".
 */
export function enrolmentBudget(input: EnrolmentBudgetInput): number {
  if (!input.systemEnabled) return 0;
  if (!Number.isFinite(input.dailyLimit) || input.dailyLimit <= 0) return 0;
  if (!Number.isFinite(input.perRunCap) || input.perRunCap <= 0) return 0;

  const remainingToday = Math.floor(input.dailyLimit) - safeCount(input.usedToday) - safeCount(input.pendingDue);
  if (!(remainingToday > 0)) return 0;
  return Math.min(Math.floor(input.perRunCap), remainingToday);
}
