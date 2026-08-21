// ===========================================================================
// IS THIS DROP LEGAL?
//
// PURE, no I/O, and used by BOTH the client and the server so they cannot
// diverge. The client refuses a bad drop before the confirmation dialog; the
// server re-runs exactly these checks against inputs it fetched itself, because
// nothing the client claims is trusted.
//
// An appointment against the wrong clinician or the wrong time is a
// patient-safety event, so every refusal is explicit and carries its own
// sentence. Nothing is ever "permitted with a warning".
// ===========================================================================

import { checkContinuity } from "./continuity";
import type { ColumnWorkState, Span } from "./working-spans";
import { firstOverlap, spanContainedIn } from "./working-spans";

export interface MoveContext {
  /** null = the Unassigned column, which is not a person. */
  targetPractitionerId: string | null;
  targetPractitionerName: string;
  workState: ColumnWorkState;
  /** The union of availability windows and that clinician's own booked spans. */
  workingSpans: readonly Span[];
  /** Booked spans that CONSUME the clinician's time (cancelled and DNA excluded). */
  occupiedSpans: readonly (Span & { appointmentId?: string })[];
  /** Break spans only. A note does not block a drop. */
  breakSpans: readonly Span[];
  /** The drawn extent of the day. */
  bounds: Span;
  /** Excluded from occupancy, so a five minute nudge onto itself is legal. */
  movingAppointmentId: string;
  /**
   * The three inputs to the CONTINUING-TREATMENT rule. Required, with no
   * defaults, so a caller cannot forget them and quietly get the pre-rule
   * behaviour: an omitted reason would read as "nothing recorded", which the
   * rule refuses, and an omitted source practitioner would read as Unassigned,
   * which it allows. One of those two failures is silent and wrong, and a
   * required field is the only thing that stops it.
   */
  movingReason: string | null;
  /** Who has the appointment NOW. null is Unassigned. */
  sourcePractitionerId: string | null;
  /** Named in the refusal. */
  sourcePractitionerName: string | null;
}

export interface MoveProposal {
  appointmentId: string;
  startMin: number;
  endMin: number;
  practitionerId: string | null;
  dayKey: string;
}

export type MoveRefusalCode =
  | "unassigned"
  | "continuing_treatment"
  | "continuity_unclear"
  | "hours_unknown"
  | "hours_past"
  | "site_unconfirmed"
  | "outside_day"
  | "outside_hours"
  | "occupied"
  | "on_break";

export type MoveValidation =
  | { ok: true }
  | { ok: false; code: MoveRefusalCode; message: string };

function hhmm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Nine checks, in a fixed order. The order is part of the contract: when several
 * apply, the reader is told the most fundamental reason first.
 *
 *  1 unassigned     Unassigned is not a person and has no availability, so it is
 *                   settled before anything that would consult availability.
 *  2 continuity     THE CLINICAL RULE, and it is second because it needs no read
 *                   at all: whether a course of treatment may change hands is a
 *                   property of the appointment and the two clinicians, not of
 *                   anybody's diary. Told before "we could not read their hours"
 *                   because "this has to stay with Dana Hale" is the more useful
 *                   of the two sentences and stays true whatever the read did.
 *                   A move that keeps the SAME clinician never reaches it.
 *  3 hours_unknown  A read that failed REFUSES the move. It does not warn. The
 *                   whole point of building availability first was so a drop
 *                   could be checked, and a feature that silently stops checking
 *                   is worse than one that stops working.
 *  4 hours_past     The day has ENDED, so Dentally will not answer for it at all
 *                   and there are no hours to check against. Separated from
 *                   hours_unknown because nothing failed: it is a fact about the
 *                   calendar, and no retry can change it.
 *  5 site_unconfirmed  Their windows may describe another of these practices.
 *  6 outside_day    Outside the drawn extent.
 *  7 outside_hours  The GREY check. The whole span must lie inside the union of
 *                   the clinician's availability windows and their own bookings.
 *  8 occupied       The day's own appointments are subtracted EXPLICITLY rather
 *                   than trusting the window to have excluded them. Live Dentally
 *                   was measured on 2026-08-21 and its windows DO exclude booked
 *                   time -- which is why the union in 7 exists -- but subtracting
 *                   here as well is what keeps this correct if that ever changes.
 *  9 on_break       A break occupies; a note does not.
 */
export function validateMove(p: MoveProposal, ctx: MoveContext): MoveValidation {
  const name = ctx.targetPractitionerName.trim() === "" ? "this clinician" : ctx.targetPractitionerName;

  if (p.practitionerId === null || ctx.targetPractitionerId === null) {
    return {
      ok: false,
      code: "unassigned",
      message: "An appointment cannot be moved to Unassigned. Choose a clinician.",
    };
  }

  // The same dentist has to continue a course of treatment. See continuity.ts.
  const continuity = checkContinuity({
    reason: ctx.movingReason,
    fromPractitionerId: ctx.sourcePractitionerId,
    fromPractitionerName: ctx.sourcePractitionerName,
    toPractitionerId: ctx.targetPractitionerId,
  });
  if (!continuity.ok) {
    return { ok: false, code: continuity.code, message: continuity.message };
  }

  if (ctx.workState === "unknown") {
    return {
      ok: false,
      code: "hours_unknown",
      message: `Working hours could not be read for ${name}, so this move cannot be checked.`,
    };
  }

  // The day is over, so Dentally cannot report the hours this move would be
  // checked against: its availability endpoint refuses any window that is not in
  // the future. The drop is REFUSED rather than checked against the day's
  // bookings alone, which would accept a patient into whatever gap happened to
  // sit between two appointments on a day nobody can verify.
  if (ctx.workState === "past") {
    return {
      ok: false,
      code: "hours_past",
      message: `Dentally cannot report working hours for a date that has passed, so this move cannot be checked.`,
    };
  }

  // The cross-site refusal. Availability carries no site, so a clinician who
  // works at more than one of these practices can only be placed HERE by a
  // site-scoped booking. Without one, their windows may belong to another
  // practice entirely, and a drop into them books a patient with somebody who is
  // not in the building. See site-presence.ts.
  if (ctx.workState === "unconfirmed") {
    return {
      ok: false,
      code: "site_unconfirmed",
      message: `${name} works across more than one practice and nothing confirms they are at this one that day, so this move cannot be checked.`,
    };
  }

  const span: Span = { startMin: p.startMin, endMin: p.endMin };
  if (span.endMin <= span.startMin || span.startMin < ctx.bounds.startMin || span.endMin > ctx.bounds.endMin) {
    return {
      ok: false,
      code: "outside_day",
      message: "That is outside the diary's hours for this day.",
    };
  }

  if (!spanContainedIn(span, ctx.workingSpans)) {
    return {
      ok: false,
      code: "outside_hours",
      message: `The proposed time is outside ${name}'s working hours.`,
    };
  }

  const others = ctx.occupiedSpans.filter((s) => s.appointmentId !== ctx.movingAppointmentId);
  const clash = firstOverlap(span, others);
  if (clash) {
    return {
      ok: false,
      code: "occupied",
      message: `${name} already has an appointment at ${hhmm(clash.startMin)}.`,
    };
  }

  if (firstOverlap(span, ctx.breakSpans)) {
    return {
      ok: false,
      code: "on_break",
      message: `${name} has a break booked at that time.`,
    };
  }

  return { ok: true };
}

export const MIN_DURATION_MIN = 5;
export const MAX_DURATION_MIN = 480;

/**
 * A duration the server will accept: 5 to 480 minutes, on a five minute mark.
 *
 * Returns null rather than clamping silently when the input is not a number: a
 * duration we cannot read is a 400, not a guess.
 */
export function normaliseDurationMin(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < MIN_DURATION_MIN || rounded > MAX_DURATION_MIN) return null;
  if (rounded % MIN_DURATION_MIN !== 0) return null;
  return rounded;
}
