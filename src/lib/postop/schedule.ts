// When a post-op check-in may go out. PURE, no I/O.
//
// Three rules, and they are all about time of day rather than cadence, because
// there is no cadence: one message, once, or not at all.
//
//   1. DUE. Not before `checkInAfterHours` after the procedure finished. Twenty
//      hours, so an afternoon procedure is checked the following late morning
//      rather than at 08:00 the next day while they are still asleep.
//   2. QUIET HOURS. Clamped into 08:00-20:00 Europe/London, using the diary's own
//      window (src/lib/calendar/notify.ts) so the practice has ONE definition of
//      "not in the middle of the night" rather than two that can drift.
//   3. STALE. Past `maxProcedureAgeHours` the check-in is not sent at all. A
//      check-in that arrives three days late is not a check-in; it is evidence
//      that nobody was watching, and it invites a reply about a problem that has
//      had three days to get worse while we said nothing.
//
// Rule 3 is the one that makes rule 2 safe. Clamping a 21:00 send to 08:00
// tomorrow is right for a diary notice; for a post-op check it is only right
// because anything clamped past the staleness ceiling is dropped instead.

import { clampToSendWindow, SEND_WINDOW_START_HOUR, SEND_WINDOW_END_HOUR } from "@/lib/calendar/notify";
import type { PostopConfig } from "./types";

export { SEND_WINDOW_START_HOUR, SEND_WINDOW_END_HOUR };

const HOUR = 3_600_000;

/**
 * The earliest instant a check-in for a procedure finishing at `procedureAt` may
 * be sent: the configured delay, then clamped into the send window.
 *
 * Returns null when the ISO instant cannot be read. Null is a REFUSAL, not a
 * "send now": a target whose time we cannot establish is a target whose staleness
 * we cannot establish either, and this module would rather send nothing.
 */
export function dueAtFor(procedureAt: string, config: PostopConfig): string | null {
  const finishedMs = Date.parse(procedureAt);
  if (!Number.isFinite(finishedMs)) return null;
  const earliest = finishedMs + config.checkInAfterHours * HOUR;
  return new Date(clampToSendWindow(earliest)).toISOString();
}

/** Whether a procedure is too old for a check-in to be honest. */
export function isStale(procedureAt: string, now: Date, config: PostopConfig): boolean {
  const finishedMs = Date.parse(procedureAt);
  // Unreadable is treated as STALE, deliberately: of the two errors, sending a
  // check-in for a procedure we cannot date is the one that can be wrong in front
  // of a patient.
  if (!Number.isFinite(finishedMs)) return true;
  return now.getTime() - finishedMs > config.maxProcedureAgeHours * HOUR;
}

export type SendDecision =
  | { action: "send" }
  | { action: "wait"; until: string }
  | { action: "drop"; reason: "stale" | "undatable" };

/**
 * Should this target's check-in go out now?
 *
 * STALENESS IS CHECKED FIRST, and that order is the whole safety property. A
 * target that is both stale and not-yet-due (impossible in practice, but a clock
 * skew or a bad Dentally timestamp makes it representable) must be dropped rather
 * than scheduled: "wait" on a stale target would park a message that can only get
 * more wrong the longer it waits.
 */
export function decideSend(
  target: { procedureAt: string; dueAt: string },
  now: Date,
  config: PostopConfig,
): SendDecision {
  if (!Number.isFinite(Date.parse(target.procedureAt))) return { action: "drop", reason: "undatable" };
  if (isStale(target.procedureAt, now, config)) return { action: "drop", reason: "stale" };
  const dueMs = Date.parse(target.dueAt);
  if (!Number.isFinite(dueMs)) return { action: "drop", reason: "undatable" };
  if (now.getTime() < dueMs) return { action: "wait", until: target.dueAt };
  return { action: "send" };
}

/**
 * The instant a queued outbox row may not be sent before.
 *
 * The shared drain has no time-of-day gate of its own — it sends whatever is
 * queued whenever pg_cron wakes it — so quiet hours for this module live on the
 * row, exactly as they do for the diary (diary_outbox.not_before_at). Approving a
 * draft at 22:30 therefore queues a row the drain will not pick up until 08:00.
 */
export function notBeforeFor(approvedAt: Date): string {
  return new Date(clampToSendWindow(approvedAt.getTime())).toISOString();
}
