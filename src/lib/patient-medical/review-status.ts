import { londonOverdueDays } from "@/lib/time/london";

// ===========================================================================
// THE MEDICAL-HISTORY REVIEW RULE — pure, and the whole clinical point.
//
// "Medical history must be marked as reviewed at every appointment" is a legal
// obligation, and whether a review is DUE is the single decision this feature
// turns on. So it is written ONCE, here, as a pure function over plain data —
// never inside a React component, which is the defect class this repository has
// already paid for. tab-medical.tsx and the header both hand it the same shape
// and render whatever it returns; neither re-decides.
//
// THREE STATES, and they are not interchangeable:
//   never-captured  no questionnaire has been captured in this platform. This is
//                   "we hold none", NEVER "the patient has no medical history".
//   review-due      a questionnaire exists, an appointment is today or upcoming,
//                   and the current answers have not been reviewed since they were
//                   last captured or updated.
//   up-to-date      a questionnaire exists and either nothing is scheduled that
//                   demands a fresh review, or a review has happened since the
//                   latest questionnaire.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not read the clock (the caller
// passes `now`), it does not read a database, and it makes no claim about a
// patient who has never been captured beyond "not captured here". A failed READ
// is the caller's concern — see medicalHeaderPill's `review.ok`; the state
// machine only ever runs on data that was read successfully.
// ===========================================================================

export type MedicalReviewState = "never-captured" | "review-due" | "up-to-date";

/** The minimum an appointment needs to be for this rule: when it starts. */
export interface ReviewAppointment {
  start: string;
}

export interface ReviewStatusInput {
  /** ISO of the newest questionnaire captured here, or null if none ever was. */
  latestQuestionnaireAt: string | null;
  /** ISO of the newest review event, or null if none ever was. */
  latestReviewAt: string | null;
  /** The patient's appointments. Only whether any is today-or-later matters. */
  appointments: readonly ReviewAppointment[];
  /** ISO. Supplied by the caller — nothing here reads a clock. */
  now: string;
}

/** Whether an appointment falls on today's London day or later. */
function isTodayOrLater(startIso: string, now: string): boolean {
  // londonOverdueDays > 0 is in the past, 0 is today, < 0 is the future; an
  // unparseable date returns -Infinity, which is treated as "not upcoming" rather
  // than silently counting as a reason to demand a review.
  const overdue = londonOverdueDays(startIso, new Date(now));
  return Number.isFinite(overdue) && overdue <= 0;
}

/**
 * The review state for one patient. See the header for the three states and why
 * each is worded the way it is.
 */
export function medicalReviewStatus(input: ReviewStatusInput): MedicalReviewState {
  if (!input.latestQuestionnaireAt) return "never-captured";

  const hasUpcoming = input.appointments.some((a) => isTodayOrLater(a.start, input.now));
  if (!hasUpcoming) return "up-to-date";

  const questionnaireAt = Date.parse(input.latestQuestionnaireAt);
  const reviewAt = input.latestReviewAt ? Date.parse(input.latestReviewAt) : null;

  // A review counts only if it is at or after the current questionnaire: answers
  // captured or updated AFTER the last review have not been reviewed, so a fresh
  // review is due at the next appointment. An unparseable questionnaire timestamp
  // fails SAFE to review-due rather than quietly reading as up-to-date.
  if (Number.isNaN(questionnaireAt)) return "review-due";
  const reviewedSinceCapture = reviewAt !== null && !Number.isNaN(reviewAt) && reviewAt >= questionnaireAt;
  return reviewedSinceCapture ? "up-to-date" : "review-due";
}

// ---------------------------------------------------------------------------
// THE HEADER PILL — also pure, because the record header is a dumb component.
//
// The header slot where Dentally prints a red medical-alert flag has to say one
// of exactly four things, and getting the fallbacks wrong is a patient-safety
// event, not a copy nit. So the decision lives here and the header renders the
// object it returns.
// ---------------------------------------------------------------------------

export type MedicalPillTone = "alert" | "review-due" | "unread" | "none";

export interface MedicalHeaderPill {
  tone: MedicalPillTone;
  /** The pill's words. Empty string when tone is "none" (render nothing). */
  label: string;
  /** The medical_alert free text, shown only on the red alert pill. */
  detail: string | null;
}

/**
 * The review read as the pill sees it. `null` means "not computed" — the gate is
 * off, so no read was attempted and the pill falls back to the Dentally alert
 * mirror alone. When it is not null, `ok` says whether the read SUCCEEDED: a
 * failed read must never render as "none" (which reads as up-to-date), and an
 * empty successful read is a real "no review due".
 */
export interface MedicalReviewRead {
  ok: boolean;
  state: MedicalReviewState | null;
}

export interface MedicalPillInput {
  /** patient.medicalAlert — Dentally's own boolean, read on the base patient
   *  payload the record already fetched. This is the ONLY Dentally medical mirror. */
  medicalAlert: boolean;
  /** patient.medicalAlertText — the free text behind the alert, when there is one. */
  medicalAlertText: string | null;
  /** Our own review read, or null when the feature is off / not computed. */
  review: MedicalReviewRead | null;
}

/**
 * The record header's medical pill.
 *
 *   alert       Dentally has a medical alert on this patient. The most important
 *               state, so it WINS over everything: red, with the alert text.
 *   unread      our review read FAILED. Never rendered as "none": we say plainly
 *               that the review status could not be read, so silence is not misread
 *               as up-to-date.
 *   review-due  a review is outstanding (review-due) or no questionnaire has been
 *               captured while the feature is on (never-captured) — both are a
 *               prompt to act, shown amber.
 *   none        no alert, and either the feature is off or a review is up to date.
 *               Renders NOTHING, which mirrors Dentally: their alert slot is empty
 *               when there is no alert.
 *
 * The alert branch reads only patient.medicalAlert, which rides the base patient
 * payload — if THAT read had failed the record would not render at all — so the
 * red pill is never a claim built on a failed read.
 */
export function medicalHeaderPill(input: MedicalPillInput): MedicalHeaderPill {
  if (input.medicalAlert) {
    return { tone: "alert", label: "Medical alert", detail: input.medicalAlertText };
  }
  const review = input.review;
  if (review && !review.ok) {
    // The failed-read fallback. This string is the canonical neutral wording kept as
    // CANNOT_READ_COPY.medicalHistoryFlag ("Medical history not read"); a test there
    // pins the value so the two cannot drift. Never rendered as "none".
    return { tone: "unread", label: "Medical history not read", detail: null };
  }
  if (review && review.state === "review-due") {
    return { tone: "review-due", label: "Medical review due", detail: null };
  }
  if (review && review.state === "never-captured") {
    return { tone: "review-due", label: "Medical history not captured", detail: null };
  }
  return { tone: "none", label: "", detail: null };
}
