import { clampToSendWindow, SEND_WINDOW_START_HOUR, SEND_WINDOW_END_HOUR } from "@/lib/calendar/notify";
import type { TriageConfig } from "./types";

// ===========================================================================
// WHEN THE PRE-VISIT LINK GOES OUT. PURE, no I/O.
//
// APPOINTMENT-RELATIVE, like the no-show cadence and unlike recall or
// reactivation, which are enrolment-relative. There is exactly one send per
// appointment, `leadHours` before it, so this is a single instant rather than a
// cadence engine.
//
// Three rules, and rule 3 is what makes rule 2 safe:
//
//   1. DUE. The appointment start minus `leadHours` (24 by default, the number
//      the practice named and the number the medical-history link's own comment
//      assumes, so the two pre-visit asks land in the same part of the day).
//   2. QUIET HOURS. Clamped into 08:00-20:00 Europe/London using the DIARY'S own
//      window (src/lib/calendar/notify.ts), so the practice has one definition of
//      "not the middle of the night" rather than two that can drift. The shared
//      drain has NO time-of-day gate at all — quiet hours live on the row, exactly
//      as they do for the diary and for post-op.
//   3. STALE. A link that would arrive after the appointment it refers to is not
//      sent. "Before your visit, a few quick questions" delivered on the way home
//      is worse than silence: it reads as a practice that is not paying attention,
//      and the patient has nothing useful to do with it.
//
// Clamping a 21:00 send to 08:00 tomorrow is right for a diary notice. Here it is
// only right because anything clamped PAST the appointment is dropped instead,
// which is what `decideSend` checks first.
// ===========================================================================

export { SEND_WINDOW_START_HOUR, SEND_WINDOW_END_HOUR };

const HOUR = 3_600_000;

/**
 * The earliest instant the link for an appointment starting at `appointmentAt`
 * may be sent: the appointment minus the lead, clamped into the send window.
 *
 * Returns null when the instant cannot be read. Null is a REFUSAL, not "send
 * now": an appointment we cannot date is one whose staleness we cannot establish
 * either, and this module would rather send nothing than send a "before your
 * visit" message at an unknown distance from the visit.
 */
export function dueAtFor(appointmentAt: string, config: TriageConfig): string | null {
  const startMs = Date.parse(appointmentAt);
  if (!Number.isFinite(startMs)) return null;
  return new Date(clampToSendWindow(startMs - config.leadHours * HOUR)).toISOString();
}

export type TriageSendDecision =
  | { action: "send" }
  | { action: "wait"; until: string }
  | { action: "drop"; reason: "stale" | "undatable" | "past" };

/**
 * Should this target's link go out now?
 *
 * THE ORDER IS THE SAFETY PROPERTY, and there are three drops before the wait:
 *
 *   undatable  an appointment or a due time we cannot parse. Dropped, never
 *              waited on, because a wait needs an instant to wait until.
 *   past       the appointment has already started. Nothing sent after this
 *              instant is a pre-visit message, whatever the due time says.
 *   stale      the due time is more than `stalenessHours` behind us. This catches
 *              the outage case: a target that sat queued through a two-day
 *              incident must be retired, not fired the moment the lights come on.
 *
 * Only then "wait". A target that is both stale and not-yet-due is representable
 * (clock skew, a bad Dentally timestamp) and must drop rather than park: waiting
 * on a stale target parks a message that can only get more wrong.
 */
export function decideSend(
  target: { appointmentAt: string; dueAt: string },
  now: Date,
  config: TriageConfig,
): TriageSendDecision {
  const startMs = Date.parse(target.appointmentAt);
  const dueMs = Date.parse(target.dueAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(dueMs)) {
    return { action: "drop", reason: "undatable" };
  }
  const nowMs = now.getTime();
  if (nowMs >= startMs) return { action: "drop", reason: "past" };
  if (nowMs - dueMs > config.stalenessHours * HOUR) return { action: "drop", reason: "stale" };
  if (nowMs < dueMs) return { action: "wait", until: target.dueAt };
  return { action: "send" };
}

/**
 * The window of appointment START times a sweep run should look at, given `now`.
 *
 * Derived from the lead rather than hard-coded, so changing PREVISIT_LEAD_HOURS
 * moves the scan with it instead of silently scanning the wrong day.
 *
 * The window opens at `now` (an appointment that has already started is dropped by
 * decideSend anyway, so there is nothing to gain by scanning behind us) and closes
 * at `now + leadHours + slackHours`. The slack exists because the sweep runs on a
 * cadence, not continuously: without it, an appointment whose due instant fell
 * between two ticks would never be examined at all. One hour of slack covers an
 * hourly sweep with room to spare, and examining a target early costs nothing —
 * decideSend returns "wait" and the row is left alone.
 */
export function scanWindow(
  now: Date,
  config: TriageConfig,
  slackHours = 2,
): { fromIso: string; toIso: string } {
  return {
    fromIso: new Date(now.getTime()).toISOString(),
    toIso: new Date(now.getTime() + (config.leadHours + slackHours) * HOUR).toISOString(),
  };
}

/** YYYY-MM-DD for a Date, which is the form /v1/appointments takes. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
