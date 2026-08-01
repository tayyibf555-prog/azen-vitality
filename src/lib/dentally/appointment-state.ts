// Canonicalise a Dentally appointment `state` into the app's lowercase vocabulary,
// and answer the three questions every consumer actually asks of it.
//
// Real Dentally states are Title Case with spaces - "Pending", "Confirmed",
// "Arrived", "In surgery", "Completed", "Cancelled", "Did not attend" - while
// every consumer (the diary gap/done sets, the daily-brief gap count, the
// no-show terminal checks and risk history) compares lowercase underscored
// strings. Normalising once at the ingestion boundary keeps both the real API
// and the mock's legacy vocabulary ("booked", "did_not_attend") working
// everywhere downstream.
//
// WHY THE PREDICATES LIVE HERE TOO. The patient record used to decide "is this a
// live booking" with an ALLOW-list of two states, `booked` and `pending`. `booked`
// is the mock's word and does not exist on live Dentally, so the moment a patient
// replied YES to a confirmation and Dentally moved the appointment to "Confirmed",
// the record printed "Next appointment: None booked" for a patient who was sitting
// in the chair that afternoon. The rule that survives contact with a vocabulary we
// do not control is a DENY-list of the three terminal states, which is exactly what
// lib/noshow/normalise.ts already does. Anything unrecognised is therefore treated
// as a live booking rather than silently dropped.
export function normaliseAppointmentState(raw: unknown, fallback = "booked"): string {
  if (typeof raw !== "string") return fallback;
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return s === "" ? fallback : s;
}

/** The appointment did not happen and never will: it is not a visit and not a booking. */
export const CANCELLED_STATE = "cancelled";
/** The patient did not turn up. Counted, never hidden, and never a visit. */
export const DID_NOT_ATTEND_STATE = "did_not_attend";

/**
 * States that CLOSE an appointment. Everything else is still live.
 * Deny-list, not allow-list: see the file header.
 */
const TERMINAL_STATES = new Set([CANCELLED_STATE, DID_NOT_ATTEND_STATE, "completed"]);

/**
 * States in which the patient physically turned up.
 *
 * "Arrived" and "In surgery" are not yet "Completed", but the patient is in the
 * building, so counting them as a visit is true and NOT counting them means a
 * receptionist looking at a record mid-appointment reads "Last seen: no record".
 */
const ATTENDED_STATES = new Set(["completed", "arrived", "in_surgery"]);

export function isCancelledState(state: string): boolean {
  return state === CANCELLED_STATE;
}

export function isDidNotAttendState(state: string): boolean {
  return state === DID_NOT_ATTEND_STATE;
}

/** The patient turned up (or is here now). Drives "Last seen" and the visit count. */
export function isAttendedState(state: string): boolean {
  return ATTENDED_STATES.has(state);
}

/**
 * Still a live booking: not cancelled, not a did-not-attend, not completed.
 * Pending, Confirmed, Arrived, In surgery and the mock's Booked all qualify, and so
 * does any state Dentally adds tomorrow.
 */
export function isLiveBookingState(state: string): boolean {
  return !TERMINAL_STATES.has(state);
}

/** The words a receptionist reads on a pill, for the states we know. */
const STATE_LABEL: Record<string, string> = {
  booked: "Booked",
  pending: "Pending",
  confirmed: "Confirmed",
  arrived: "Arrived",
  in_surgery: "In surgery",
  completed: "Completed",
  cancelled: "Cancelled",
  did_not_attend: "No-show",
};

/**
 * A human label for any state, including one we have never seen.
 *
 * An unknown state is title-cased rather than printed raw: "in_surgery" on a pill in
 * a clinical record is a leaked internal identifier, and the fallback that renders a
 * raw lowercase word is how this defect stayed invisible in the first place.
 */
export function appointmentStateLabel(state: string): string {
  const known = STATE_LABEL[state];
  if (known) return known;
  const words = state.replace(/_/g, " ").trim();
  if (!words) return "Unknown";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
