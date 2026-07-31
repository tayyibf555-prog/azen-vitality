// ===========================================================================
// DOES THIS MOVE TEXT THE PATIENT?
//
// The rule: a change of START TIME texts. A move that only reassigns the
// appointment to a different clinician, at the same time, sends NOTHING. A move
// that changes both time and clinician DOES send.
//
// The proof is the SIGNATURE, not the tests. willNotifyPatient TAKES NO
// PRACTITIONER ARGUMENT AT ALL, so a clinician change cannot influence it. And
// it compares INSTANTS rather than strings, so a Z versus +01:00 reformat of the
// same moment is correctly not a change: the mock emits Z and live Dentally emits
// London offsets, and a string comparison would text every patient on every
// reassignment the first time this ran against the real API.
// ===========================================================================

import { londonDayKey } from "@/lib/time/london";
import { londonInstantMs, londonWallMinutes, nextDayKey } from "./availability";

export function willNotifyPatient(from: { startIso: string }, to: { startIso: string }): boolean {
  const fromMs = Date.parse(from.startIso);
  const toMs = Date.parse(to.startIso);
  // An instant we cannot read is treated as a CHANGE, deliberately and not by
  // accident: of the two errors, a patient who is never told their appointment
  // moved arrives at an empty surgery, and a patient told about a move that did
  // not happen makes a phone call. The route never reaches here with unreadable
  // values anyway (it re-reads `from` from Dentally and derives `to` itself), and
  // draftMoveText refuses an unreadable time, so nothing garbled can be sent.
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return true;
  return fromMs !== toMs;
}

/** The diary's own quiet hours, in Europe/London wall clock. */
export const SEND_WINDOW_START_HOUR = 8;
export const SEND_WINDOW_END_HOUR = 20;

/**
 * Clamp a send time into 08:00 to 20:00 Europe/London.
 *
 * There is NO quiet-hours guard anywhere else in this codebase: no send window
 * and no time-of-day gate, in the shared drain or in any sweep. The effective
 * quiet hours today are whatever the pg_cron schedule happens to give. Rather
 * than claim a guard that does not exist, this build adds one confined to the
 * diary's own table (diary_outbox.not_before_at), which this function computes.
 *
 * Before 08:00 -> 08:00 the same London day. At or after 20:00 -> 08:00 the NEXT
 * London day. A move made at 21:15 queues for 08:00 tomorrow.
 */
export function clampToSendWindow(atMs: number): number {
  if (!Number.isFinite(atMs)) return atMs;
  const dayKey = londonDayKey(new Date(atMs));
  const minutes = londonWallMinutes(atMs);
  if (minutes < SEND_WINDOW_START_HOUR * 60) {
    return londonInstantMs(dayKey, SEND_WINDOW_START_HOUR, 0);
  }
  if (minutes >= SEND_WINDOW_END_HOUR * 60) {
    return londonInstantMs(nextDayKey(dayKey), SEND_WINDOW_START_HOUR, 0);
  }
  return atMs;
}
