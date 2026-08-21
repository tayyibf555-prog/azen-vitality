// Treatment-plan closer: what "discard" MEANS.
//
// PURE. No I/O, no clock, no environment. The route reads this and then writes;
// nothing here writes anything, so every rule below is directly unit-testable and
// mutation-checkable.
//
// WHY A DISCARD NEEDS A REASON AT ALL.
//
// A rejected draft is not one thing. "The wording is off" and "we already spoke to
// this patient" are opposite instructions: the first means try again, the second
// means never again. A single unreasoned Discard button has to pick one of those
// for every case, and either choice is wrong half the time — silently. It would
// either keep re-drafting at a patient the practice has already dealt with, or
// retire an opportunity from the cadence because somebody disliked a sentence.
//
// So the reason a human gives is not a note for the audit trail, it is the input to
// the decider's own stop conditions: each reason resolves to EITHER a cool-off (the
// opportunity stays active and the sweep may draft again later) OR a terminal stop
// carrying a real CloserStopReason. Nothing else is representable.

import type { CloserStopReason } from "./types";

/** The reasons a human may give for rejecting a drafted closer message. */
export type CloserDiscardReason =
  | "wrong_tone"
  | "too_soon"
  | "already_contacted"
  | "plan_not_live"
  | "do_not_contact";

/** Ordered as the panel offers them: the two "try again" reasons first. */
export const CLOSER_DISCARD_REASONS: readonly CloserDiscardReason[] = [
  "wrong_tone",
  "too_soon",
  "already_contacted",
  "plan_not_live",
  "do_not_contact",
] as const;

/** Staff-facing wording. Plain English, no jargon, no internal vocabulary. */
export const CLOSER_DISCARD_LABEL: Record<CloserDiscardReason, string> = {
  wrong_tone: "The wording is not right",
  too_soon: "Not the right moment",
  already_contacted: "We have already spoken to this patient",
  plan_not_live: "This plan is not going ahead",
  do_not_contact: "Do not follow this patient up",
};

/** What each reason does to the opportunity, in one line, shown beside the choice. */
export const CLOSER_DISCARD_EFFECT: Record<CloserDiscardReason, string> = {
  wrong_tone: "A new draft can be written later.",
  too_soon: "Nothing is drafted for the next two weeks.",
  already_contacted: "The follow-up stops for good.",
  plan_not_live: "The follow-up stops for good.",
  do_not_contact: "The follow-up stops for good.",
};

export type CloserDiscardOutcome =
  | { kind: "retry"; coolOffHours: number }
  | { kind: "stop"; stopReason: CloserStopReason };

/**
 * "Not the right moment" pushes the next possible draft out two weeks.
 *
 * Longer than the ordinary cool-off on purpose. The ordinary one exists so a
 * systematic refusal cannot burn budget every tick, and a day is plenty for that.
 * This one is a human saying the timing is wrong, and a day later is the same
 * timing. Two weeks clears the cadence's own 7-day gap, so the next draft is a
 * genuinely later moment rather than the same ask with a different date on it.
 */
export const TOO_SOON_COOL_OFF_HOURS = 14 * 24;

/**
 * Resolve a human's reason into what the closer must do with the opportunity.
 *
 * `cooldownHours` comes from the module config so "the wording is not right"
 * shares the one configured cool-off rather than inventing a second number.
 *
 * THE HONEST LIMITATION, stated rather than hidden: after a `wrong_tone` discard
 * the model may well write something very similar next time, because nothing about
 * the rejection is fed back into the prompt. The cool-off is what stops that being
 * an immediate loop; it is not a fix for it. A human who wants different words
 * today should EDIT the draft and approve it, which is why edit-then-approve
 * exists beside this and is the recommended path.
 */
export function discardOutcome(
  reason: CloserDiscardReason,
  opts: { cooldownHours: number },
): CloserDiscardOutcome {
  switch (reason) {
    case "wrong_tone":
      return { kind: "retry", coolOffHours: opts.cooldownHours };
    case "too_soon":
      return { kind: "retry", coolOffHours: TOO_SOON_COOL_OFF_HOURS };
    // The practice has had the conversation. That is exactly what an inbound reply
    // means to the decider, and it is the same fact arriving by a different route,
    // so it records the same reason rather than a near-synonym.
    case "already_contacted":
      return { kind: "stop", stopReason: "patient_replied" };
    // The plan is not going ahead. The decider already stops on a plan that has
    // left the coordinator's open set; this is a human telling us the same thing
    // before the sync catches up.
    case "plan_not_live":
      return { kind: "stop", stopReason: "opportunity_closed" };
    // A person decided, and no other stop reason is that. Reusing `excluded` would
    // claim the patient's admin status excludes them, which is a different and
    // checkable fact; reusing `opted_out` would claim the patient asked, which they
    // did not. Both would be false in the record.
    case "do_not_contact":
      return { kind: "stop", stopReason: "staff_stopped" };
  }
}

/** Narrow an unknown value from a request body. */
export function isCloserDiscardReason(value: unknown): value is CloserDiscardReason {
  return typeof value === "string" && (CLOSER_DISCARD_REASONS as readonly string[]).includes(value);
}
