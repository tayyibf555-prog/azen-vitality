// Outstanding-balance collection agent: what "discard" MEANS.
//
// PURE. No I/O, no clock, no environment. The route reads this and then writes;
// nothing here writes anything, so every rule below is directly unit-testable and
// mutation-checkable.
//
// A rejected draft is not one thing, and on a money conversation the difference
// between the reasons is larger than anywhere else in the platform. "The wording
// is off" means try again. "We have spoken to them" means never again. "They are
// disputing it" means never again AND a person owns this now. A single unreasoned
// Discard button has to guess between those for every case, silently, and would
// either keep drafting reminders at somebody who is already mid-complaint or
// retire a genuine balance because a receptionist disliked a sentence.
//
// So the reason a human gives is an INPUT to the decider, not a note for the audit
// trail: it resolves to a cool-off, a terminal stop, or a terminal stop that also
// raises an escalation. Nothing else is representable.

import type { CollectionEscalationReason, CollectionStopReason } from "./types";

/** The reasons a human may give for rejecting a drafted reminder. */
export type CollectionDiscardReason =
  | "wrong_tone"
  | "too_soon"
  | "already_contacted"
  | "balance_wrong"
  | "patient_disputing"
  | "do_not_chase";

/** Ordered as the panel offers them: the two "try again" reasons first, then the
 *  three that end it, with the two that call a person last. */
export const COLLECTION_DISCARD_REASONS: readonly CollectionDiscardReason[] = [
  "wrong_tone",
  "too_soon",
  "already_contacted",
  "balance_wrong",
  "patient_disputing",
  "do_not_chase",
] as const;

/** Staff-facing wording. Plain English, no jargon, no internal vocabulary. */
export const COLLECTION_DISCARD_LABEL: Record<CollectionDiscardReason, string> = {
  wrong_tone: "The wording is not right",
  too_soon: "Not the right moment",
  already_contacted: "We have already spoken to this patient",
  balance_wrong: "The balance is wrong",
  patient_disputing: "The patient is querying this",
  do_not_chase: "Do not chase this patient",
};

/** What each reason does, in one line, shown beside the choice. */
export const COLLECTION_DISCARD_EFFECT: Record<CollectionDiscardReason, string> = {
  wrong_tone: "A new draft can be written later.",
  too_soon: "Nothing is drafted for the next three weeks.",
  already_contacted: "The reminders stop for good.",
  balance_wrong: "The reminders stop for good and this is flagged for someone to look at.",
  patient_disputing: "The reminders stop for good and this is flagged for someone to look at.",
  do_not_chase: "The reminders stop for good.",
};

export type CollectionDiscardOutcome =
  | { kind: "retry"; coolOffHours: number }
  | {
      kind: "stop";
      stopReason: CollectionStopReason;
      /** Null when the stop needs no human follow-up. */
      escalate: CollectionEscalationReason | null;
    };

/**
 * "Not the right moment" pushes the next possible draft out three weeks.
 *
 * Longer than the ordinary cool-off on purpose, and longer than the closer's two
 * weeks. The ordinary cool-off exists so a systematically-refusing patient cannot
 * burn budget every tick, and a day is plenty for that. This one is a person
 * saying the timing is wrong, and on a money conversation "later" has to mean
 * genuinely later: three weeks clears the cadence's own ten-day gap and lands past
 * a pay cycle, so the next draft is a different moment rather than the same ask
 * with a new date on it.
 */
export const TOO_SOON_COOL_OFF_HOURS = 21 * 24;

/**
 * Resolve a human's reason into what the agent must do with the patient.
 *
 * `cooldownHours` comes from the module config so "the wording is not right"
 * shares the one configured cool-off rather than inventing a second number.
 *
 * THE HONEST LIMITATION, stated rather than hidden: after a `wrong_tone` discard
 * the model may write something very similar next time, because nothing about the
 * rejection is fed back into the prompt. The cool-off is what stops that being an
 * immediate loop; it is not a fix for it. A human who wants different words today
 * should EDIT the draft and approve it, which is why edit-then-approve exists
 * beside this and is the recommended path.
 */
export function collectionDiscardOutcome(
  reason: CollectionDiscardReason,
  opts: { cooldownHours: number },
): CollectionDiscardOutcome {
  switch (reason) {
    case "wrong_tone":
      return { kind: "retry", coolOffHours: opts.cooldownHours };
    case "too_soon":
      return { kind: "retry", coolOffHours: TOO_SOON_COOL_OFF_HOURS };
    // The practice has had the conversation. That is exactly what an inbound reply
    // means to the decider, and it is the same fact arriving by a different route,
    // so it records the same reason rather than a near-synonym.
    case "already_contacted":
      return { kind: "stop", stopReason: "patient_replied", escalate: null };
    // A person is telling us the figure is wrong. That is the most important thing
    // anybody can say about this module, because it means the chain of reads
    // produced a number the practice does not stand behind, and it must never be
    // filed as an ordinary rejection: the reminders stop AND somebody looks.
    case "balance_wrong":
      return { kind: "stop", stopReason: "needs_a_person", escalate: "unreadable_invoice" };
    // The patient is querying it. Same shape as an inbound dispute, arriving by the
    // front desk rather than by text.
    case "patient_disputing":
      return { kind: "stop", stopReason: "dispute", escalate: "dispute" };
    // A person decided, and no other stop reason is that. Reusing `excluded` would
    // claim the patient's admin status excludes them and `opted_out` would claim the
    // patient asked us to stop; both would be false in the record.
    case "do_not_chase":
      return { kind: "stop", stopReason: "staff_stopped", escalate: null };
  }
}

/** Narrow an unknown value from a request body. */
export function isCollectionDiscardReason(value: unknown): value is CollectionDiscardReason {
  return (
    typeof value === "string" && (COLLECTION_DISCARD_REASONS as readonly string[]).includes(value)
  );
}
