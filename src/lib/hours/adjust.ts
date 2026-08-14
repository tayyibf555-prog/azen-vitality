import type { ClockEvent, ClockKind, ClockValidation } from "@/lib/clock/types";

// ===========================================================================
// THE CORRECTION PATH, AND WHY IT COULD NOT BE THE CLOCKING ROUTE.
//
// POST /api/staff-check-in stamps every tap with the SERVER clock and takes no
// caller-supplied time, by design: backdating is not something you need in order
// to clock in, and allowing it there would let anybody write yesterday into
// their own attendance. That design has one consequence nobody could live with
// at month end: when somebody forgets to clock out, there is no way to record
// what actually happened, so the month can never be honestly finalised.
//
// So corrections are a SEPARATE act with a separate route, and this module is
// its rules:
//   * a manager records it, never the person themselves (the route's job);
//   * the time is EXPLICIT, which is the whole point;
//   * a reason is MANDATORY, because a manually written attendance record with
//     no explanation is exactly what an employment tribunal asks about;
//   * it is APPENDED. src/lib/clock/repository.ts states there is deliberately
//     no update and no delete: a mistaken tap is corrected by RECORDING the
//     correction, so the pairing rules show the manager both the mistake and the
//     correction. Nothing here edits an original away.
//
// PURE: `now` is a parameter, the events are given. No I/O, no clock read.
// ===========================================================================

/**
 * How far back a correction may reach.
 *
 * Two months, so the previous month can still be fixed while it is being paid,
 * and no further: a "correction" to a quarter-old month is a rewrite of a period
 * somebody has already been paid for, and it should be a conversation rather
 * than a form.
 */
export const MAX_BACKDATE_DAYS = 62;

/** Long enough to be a sentence, not "x". */
export const MIN_REASON_LENGTH = 4;
export const MAX_REASON_LENGTH = 300;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** An ISO 8601 instant carrying an explicit zone: "...Z" or "...+01:00". */
const HAS_TIMEZONE = /(Z|[+-]\d{2}:?\d{2})$/;

export interface AdjustmentInput {
  staffId: string;
  kind: ClockKind;
  /** The instant the practice says it actually happened, ISO 8601. */
  occurredAt: string;
  reason: string;
}

/** The same minute, so a double submit is not recorded twice. */
function sameMinute(aIso: string, bIso: string): boolean {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.floor(a / MINUTE_MS) === Math.floor(b / MINUTE_MS);
}

/**
 * Whether this correction may be recorded.
 *
 * `events` is that person's surrounding stream (the route reads a window either
 * side of the correction). The final rule is the interesting one: the corrected
 * stream must still ALTERNATE around the insertion point. A tap whose nearest
 * neighbour on either side is the same kind would create two arrivals or two
 * departures in a row, which does not describe anything that can happen and
 * would show up later as an invented anomaly nobody can explain.
 *
 * Note what is deliberately NOT reused: `validateClock`. It answers "what is the
 * next legal tap RIGHT NOW", which is the wrong question for an event being
 * inserted into the past.
 */
export function validateAdjustment(
  input: AdjustmentInput,
  events: readonly ClockEvent[],
  now: Date,
): ClockValidation {
  if (input.kind !== "in" && input.kind !== "out") {
    return { ok: false, reason: "A correction must be a clock in or a clock out." };
  }

  // AN EXPLICIT TIME ZONE IS REQUIRED, and this is not pedantry. A browser's
  // datetime-local field yields "2026-06-11T17:30" with no zone, and Date.parse
  // resolves a zoneless string against the LOCAL clock: the manager's laptop
  // reads it as half past five in London, and the UTC server reads it as half
  // past five UTC, which in British Summer Time is a different instant and a
  // different hour of somebody's pay. The caller converts before sending.
  if (!HAS_TIMEZONE.test(input.occurredAt)) {
    return { ok: false, reason: "That time is missing its time zone, so it could not be recorded exactly." };
  }

  const at = Date.parse(input.occurredAt);
  if (Number.isNaN(at)) return { ok: false, reason: "That time could not be read." };

  const nowMs = now.getTime();
  if (at > nowMs) return { ok: false, reason: "A clock event cannot be in the future." };
  if (at < nowMs - MAX_BACKDATE_DAYS * DAY_MS) {
    return {
      ok: false,
      reason: `A correction cannot reach back more than ${MAX_BACKDATE_DAYS} days. Record it outside the platform and note why.`,
    };
  }

  const reason = (input.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    return { ok: false, reason: "Say why this is being recorded. The reason is kept with the entry." };
  }
  if (reason.length > MAX_REASON_LENGTH) {
    return { ok: false, reason: `Keep the reason under ${MAX_REASON_LENGTH} characters.` };
  }

  // That person's stream only, in time order.
  const mine = events
    .filter((e) => e.staffId === input.staffId && !Number.isNaN(Date.parse(e.occurredAt)))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));

  if (mine.some((e) => e.kind === input.kind && sameMinute(e.occurredAt, input.occurredAt))) {
    return { ok: false, reason: "That entry is already recorded for this person at that time." };
  }

  let before: ClockEvent | null = null;
  let after: ClockEvent | null = null;
  for (const event of mine) {
    const t = Date.parse(event.occurredAt);
    if (t <= at) before = event;
    else if (!after) after = event;
  }

  if (before && before.kind === input.kind) {
    return {
      ok: false,
      reason:
        input.kind === "in"
          ? "They were already clocked in before that time. Record the missing clock out first."
          : "They were already clocked out before that time. Record the missing clock in first.",
    };
  }
  if (after && after.kind === input.kind) {
    return {
      ok: false,
      reason:
        input.kind === "in"
          ? "The next entry after that time is also a clock in, so this would leave two arrivals in a row."
          : "The next entry after that time is also a clock out, so this would leave two departures in a row.",
    };
  }

  return { ok: true };
}
