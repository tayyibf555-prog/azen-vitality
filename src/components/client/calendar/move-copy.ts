// ===========================================================================
// EVERY SENTENCE THE MOVE SPEAKS.
//
// PURE and unit-tested, because these are the words a practice manager acts on
// while a phone is ringing. Two of them are safety copy in the strict sense:
// the texting line in the confirmation dialog, and the "may or may not have
// saved" line after an unreadable write.
//
// The texting line is COMPUTED, never hand-written per case, from the same
// predicate the server uses (willNotifyPatient). A dialog that says "the patient
// will be texted" while the server sends nothing, or the reverse, is worse than
// no line at all.
//
// House rules: British English, no em-dash, no exclamation mark, plain and
// specific. These are STAFF-facing strings, so "NHS" and "private" would be
// allowed here; none is needed. The PATIENT-facing text lives in
// src/lib/calendar/draft.ts and is governed by its own, stricter rules.
// ===========================================================================

import { willNotifyPatient } from "@/lib/calendar/notify";

/** Why a text cannot be sent, in the order the dialog checks them. */
export type NotifyBlocker =
  | "none"
  | "messaging_off"
  | "no_phone"
  | "no_mobile"
  | "opted_out";

export interface NotifyNoticeArgs {
  /** From willNotifyPatient: the SAME instants comparison the server runs. */
  from: { startIso: string };
  to: { startIso: string };
  blocker: NotifyBlocker;
  /** MESSAGING_DRY_RUN: the providers no-op and a send is simulated. */
  dryRun: boolean;
}

export interface NotifyNotice {
  /** True when a row will actually be queued for the shared drain. */
  willQueue: boolean;
  text: string;
  /** "amber" is reserved for the dry-run line, which must be impossible to miss. */
  tone: "plain" | "amber";
}

/**
 * What the dialog says about the patient's text, BEFORE anything is written.
 *
 * IT IS A PREDICTION AND IT SAYS SO IN ITS SHAPE. Consent and suppression are
 * checked at DRAIN time and not at queue time, so this line cannot be a promise.
 * The dialog therefore says "will be texted" and the post-move line reports what
 * actually happened. Pretending the dialog can know would be the quiet lie this
 * platform refuses.
 */
export function notifyNotice(args: NotifyNoticeArgs): NotifyNotice {
  // A clinician-only reassignment is settled FIRST, and by the predicate rather
  // than by any practitioner comparison: willNotifyPatient takes no practitioner
  // argument at all, so a clinician change cannot influence it.
  if (!willNotifyPatient(args.from, args.to)) {
    return {
      willQueue: false,
      text: "The patient will not be texted. Only the clinician is changing.",
      tone: "plain",
    };
  }

  switch (args.blocker) {
    case "messaging_off":
      return {
        willQueue: false,
        text: "The patient will not be texted: messaging is switched off.",
        tone: "plain",
      };
    case "no_phone":
      return {
        willQueue: false,
        text: "The patient will not be texted: no practice phone number is configured.",
        tone: "plain",
      };
    case "no_mobile":
      return {
        willQueue: false,
        text: "The patient will not be texted: there is no mobile number on their record.",
        tone: "plain",
      };
    case "opted_out":
      return {
        willQueue: false,
        text: "The patient will not be texted: they have opted out of messages.",
        tone: "plain",
      };
    default:
      break;
  }

  if (args.dryRun) {
    return {
      willQueue: true,
      text: "The patient will not actually be texted. Messages are simulated on this environment.",
      tone: "amber",
    };
  }

  // NAMED, not implied. Consent and suppression are checked at DRAIN time, so
  // this line cannot promise delivery, and the blockers above are only as good as
  // what the caller could see: today the board can only detect a missing practice
  // number, so an opted-out patient would otherwise be announced flatly as one who
  // "will be texted". The second sentence is the honest remainder.
  return {
    willQueue: true,
    text: "The patient will be texted about the new time. Nothing is sent if they have opted out or have no mobile number on file.",
    tone: "plain",
  };
}

// ---------------------------------------------------------------------------
// The dialog's own lines.
// ---------------------------------------------------------------------------

export interface MoveSubjectArgs {
  /** The short form, e.g. "N.Lamprell": the dialog is dense, like the block. */
  patientShort: string;
  /** The treatment as it will be read: the type label, else the raw reason. */
  treatment: string | null;
  minutes: number | null;
}

/** "N.Lamprell, Scale & Polish, 30 minutes." Missing parts are omitted, never blanked. */
export function moveSubjectLine(args: MoveSubjectArgs): string {
  const parts: string[] = [];
  const name = args.patientShort.trim();
  if (name !== "") parts.push(name);
  const treatment = (args.treatment ?? "").trim();
  if (treatment !== "") parts.push(treatment);
  if (args.minutes !== null && Number.isFinite(args.minutes)) {
    parts.push(`${args.minutes} ${args.minutes === 1 ? "minute" : "minutes"}`);
  }
  return parts.length === 0 ? "" : `${parts.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Announcements. Every one of these reaches assistive tech through the board's
// dedicated live region, which is SEPARATE from the one carrying the date and
// caption: that one would not retrigger on a move (dayCounts does not change)
// and would fight the day-change announcement.
// ---------------------------------------------------------------------------

export function moveModeAnnouncement(
  mode: "move" | "resize",
  patientShort: string,
  timeLabel: string,
  clinicianName: string | null,
): string {
  const who = clinicianName && clinicianName.trim() !== "" ? `, ${clinicianName.trim()}` : "";
  return mode === "move"
    ? `Move mode. ${patientShort}, ${timeLabel}${who}. Arrow keys to move, Enter to confirm, Escape to cancel.`
    : `Resize mode. ${patientShort}, ${timeLabel}${who}. Arrow keys to change the length, Enter to confirm, Escape to cancel.`;
}

export function proposedAnnouncement(
  patientShort: string,
  timeLabel: string,
  clinicianName: string | null,
  minutes: number,
): string {
  const who = clinicianName && clinicianName.trim() !== "" ? ` with ${clinicianName.trim()}` : "";
  return `${patientShort} to ${timeLabel}${who}, ${minutes} minutes.`;
}

export function savingAnnouncement(
  patientShort: string,
  timeLabel: string,
  clinicianName: string | null,
): string {
  const who = clinicianName && clinicianName.trim() !== "" ? ` with ${clinicianName.trim()}` : "";
  return `Saving: ${patientShort} to ${timeLabel}${who}.`;
}

export function movedAnnouncement(
  patientShort: string,
  timeLabel: string,
  clinicianName: string | null,
): string {
  const who = clinicianName && clinicianName.trim() !== "" ? ` with ${clinicianName.trim()}` : "";
  return `Moved. ${patientShort} is now ${timeLabel}${who}. Press Control Z to undo.`;
}

/** The rollback sentence. It names where the appointment ACTUALLY is, not where it was dropped. */
export function notSavedAnnouncement(
  patientShort: string,
  timeLabel: string,
  clinicianName: string | null,
): string {
  const who = clinicianName && clinicianName.trim() !== "" ? ` with ${clinicianName.trim()}` : "";
  return `That move did not save. ${patientShort} is still at ${timeLabel}${who}.`;
}

/**
 * The one outcome that must NOT claim to know.
 *
 * A timed-out write may or may not have landed, so the block neither commits nor
 * snaps back: snapping back would assert something we do not know, and telling
 * the patient either way could be wrong.
 */
export function unknownOutcomeSentence(patientShort: string): string {
  return `The move may or may not have saved. Open ${patientShort} in Dentally and check before telling the patient.`;
}

export function cancelledAnnouncement(
  patientShort: string,
  timeLabel: string,
  clinicianName: string | null,
): string {
  const who = clinicianName && clinicianName.trim() !== "" ? ` with ${clinicianName.trim()}` : "";
  return `Move cancelled. ${patientShort} is still at ${timeLabel}${who}.`;
}

/** Said, in full, when 'm' is pressed at a site whose hours or breaks could not be read. */
export const MOVE_BLOCKED_BY_READ =
  "Working hours could not be read, so appointments cannot be moved right now. Reload the page.";

/**
 * The APPOINTMENT read, which is a different failure from the hours read and
 * needs its own noun: a receptionist told the wrong thing failed looks in the
 * wrong place.
 */
export const MOVE_BLOCKED_BY_APPOINTMENTS =
  "This day's appointments could not be read, so appointments cannot be moved right now. Reload the page.";

export const MOVE_BLOCKED_BY_ENTRIES =
  "Breaks and notes could not be read, so appointments cannot be moved right now. Reload the page.";

/**
 * STILL LOADING, which is not a failure and must not be dressed as one.
 *
 * Only the initially selected day is seeded by the server, so every other day
 * costs a fetch, and during it there is genuinely nothing to check a move
 * against. Saying "could not be read. Reload the page." at that moment is a
 * false alarm, and an alarm people learn to ignore is worse than none.
 */
export const MOVE_BLOCKED_BY_PENDING =
  "Working hours are still loading, so appointments cannot be moved for a moment.";

/**
 * Said when a move is attempted on a cancelled or did-not-attend booking.
 *
 * Neither is a booking any more. Moving one would write a new time into Dentally
 * for an appointment that is not happening and text the patient that theirs "has
 * been moved to" it.
 */
export const NOT_MOVABLE =
  "This appointment is cancelled or marked as did not attend, so it cannot be moved. Book a new appointment instead.";

/** The panel's foot, when the Dentally write gate is shut. */
export const WRITE_GATE_OFF_PANEL =
  "Moving appointments in Dentally is not switched on yet. Nothing here has been changed. Ask your administrator to enable it.";

/** The panel's foot, when it is open. Appointment UPDATE is unproven against live Dentally. */
export const WRITE_GATE_ON_PANEL =
  "Drag an appointment, or press M on it, to move it. Every move is confirmed before it is saved.";

/**
 * The refusal, on the drag preview chip.
 *
 * Truncated to forty characters because the chip sits on a 112px column, and the
 * FULL sentence always goes to the live region, so nothing is lost. Red is
 * transient here and always paired with words: red already means did-not-attend
 * on this grid.
 */
export const REFUSAL_CHIP_MAX = 40;

export function truncateRefusal(message: string, max = REFUSAL_CHIP_MAX): string {
  const s = message.trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
