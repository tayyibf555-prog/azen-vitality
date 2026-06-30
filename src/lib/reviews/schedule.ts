// When to send the single review request after an appointment is marked attended.
//
// Default behaviour: not immediately (give the patient time to leave), but the
// same day if there is still plenty of it. If the appointment was attended before
// the same-day cutoff, send a few hours later that day; otherwise send the next
// morning. All reasoning is in Europe/London local time so "next morning" lands at
// a sensible hour for the patient regardless of server timezone.
//
// Configurable via env:
//   REVIEW_DELAY_HOURS    same-day delay after attendance (default 3)
//   REVIEW_CUTOFF_HOUR    latest local hour to still send same day (default 15)
//   REVIEW_MORNING_HOUR   local hour for the next-morning send (default 10)

export interface ReviewScheduleConfig {
  delayHours: number;   // same-day delay after attendance
  cutoffHour: number;   // latest local hour (0-23) to still send same day
  morningHour: number;  // local hour (0-23) for the next-morning send
}

export const DEFAULT_REVIEW_SCHEDULE: ReviewScheduleConfig = {
  delayHours: 3,
  cutoffHour: 15,
  morningHour: 10,
};

const HOUR = 3_600_000;
const LONDON = "Europe/London";

/** The hour-of-day (0-23) of `d` in Europe/London. */
function londonHour(d: Date): number {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
    hour: "2-digit",
    hour12: false,
  }).format(d);
  // "24" can appear for midnight in some environments; normalise to 0.
  const n = Number(h);
  return n === 24 ? 0 : n;
}

/**
 * The send time for a review request, given when the appointment was attended.
 *
 * - Attended before the local cutoff hour: send `delayHours` later the same day.
 * - Attended at or after the cutoff: send the next morning at `morningHour` local.
 *
 * Pure: depends only on `attendedAt` and `cfg`.
 */
export function reviewSendAt(
  attendedAt: Date,
  cfg: ReviewScheduleConfig = DEFAULT_REVIEW_SCHEDULE,
): string {
  const hour = londonHour(attendedAt);

  if (hour < cfg.cutoffHour) {
    return new Date(attendedAt.getTime() + cfg.delayHours * HOUR).toISOString();
  }

  // Next morning at morningHour local. Step forward a day, then walk the UTC
  // instant until it reads morningHour in London (handles BST/GMT without a
  // date library: at most a couple of one-hour nudges).
  const next = new Date(attendedAt.getTime() + 24 * HOUR);
  let target = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), cfg.morningHour, 0, 0, 0),
  );
  for (let i = 0; i < 6 && londonHour(target) !== cfg.morningHour; i += 1) {
    const diff = cfg.morningHour - londonHour(target);
    target = new Date(target.getTime() + diff * HOUR);
  }
  return target.toISOString();
}

/** Build the schedule config from the environment, falling back to the defaults. */
export function reviewScheduleFromEnv(): ReviewScheduleConfig {
  const num = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    delayHours: num(process.env.REVIEW_DELAY_HOURS, DEFAULT_REVIEW_SCHEDULE.delayHours),
    cutoffHour: num(process.env.REVIEW_CUTOFF_HOUR, DEFAULT_REVIEW_SCHEDULE.cutoffHour),
    morningHour: num(process.env.REVIEW_MORNING_HOUR, DEFAULT_REVIEW_SCHEDULE.morningHour),
  };
}
