// Outstanding-balance collection agent: the cadence, the reply classifier, and
// the decider.
//
// PURE. No I/O, no clock of its own, no environment reads. Everything a decision
// depends on is passed in, so every rule below is directly unit-testable and
// mutation-checkable. The sweep route does the reading and the writing; this
// module decides, and nothing else.

import type {
  CollectionConfig,
  CollectionEscalationReason,
  CollectionState,
  CollectionStep,
  CollectionStopReason,
  TouchChannel,
} from "./types";

const DAY = 86_400_000;

/**
 * The cadence: three messages, then done, ever.
 *
 * `waitDays` is the gap since the PREVIOUS SENT touch (step 1 measures from the
 * moment the patient qualifies), matching every other cadence engine here. So
 * 0 / 10 / 21 is an absolute schedule of day 0, day 10 and day 31.
 *
 * WHY WIDER THAN THE CLOSER'S 0/7/14, and why it starts on email.
 *
 * - A reminder about money is the least welcome message this platform sends. The
 *   difference between a practice and a debt collector is, in practice, entirely
 *   about frequency and tone: three messages over a month is a practice keeping a
 *   patient informed, and the same three over ten days is somebody being chased.
 *   Ten days also clears a normal monthly pay cycle between the first and second
 *   ask, so the second lands at a genuinely different moment rather than being the
 *   same question asked louder.
 *
 * - Step 1 is EMAIL because an unpaid invoice is a paperwork matter and email is
 *   where paperwork belongs. It has room for the balance, the reference and the
 *   invitation to query it without any of them being cut for length, and it does
 *   not arrive on a handset that may be shared, glanced at by somebody else, or
 *   read on a lock screen. Step 2 moves to SMS because by then the email has had
 *   ten days to be missed. Step 3 returns to email to close.
 *
 * - Channels are never SUBSTITUTED. A patient who consented to only one of the two
 *   receives fewer messages, not the same number redirected onto the channel they
 *   did agree to.
 */
export const COLLECTION_CADENCE: CollectionStep[] = [
  { step: 1, channel: "email", waitDays: 0, purpose: "notice" },
  { step: 2, channel: "sms", waitDays: 10, purpose: "offer_help" },
  { step: 3, channel: "email", waitDays: 21, purpose: "close" },
];

/** The definition of step `n` (1-based), or null when the cadence is exhausted. */
export function collectionStepDef(
  n: number,
  cadence: CollectionStep[] = COLLECTION_CADENCE,
): CollectionStep | null {
  return cadence.find((s) => s.step === n) ?? null;
}

// ---------------------------------------------------------------------------
// Inbound reply classification.
//
// THE HARD STOP. Every inbound reply — every single one, whatever it says and
// whether or not this classifier understands it — stops the cadence for good AND
// raises a human escalation. The classifier's only job is to choose the REASON and
// the urgency, so a misclassification can never cause a patient to be messaged
// again; it can only put a slightly less specific label on a work item a person is
// already looking at.
//
// THAT IS DELIBERATELY WIDER THAN THE CLOSER'S ESCAPE HATCH. The closer stops on
// a reply and leaves it at that, because a patient who does not answer a follow-up
// about elective treatment has simply not answered. A patient who replies to a
// message about money is telling the practice something about their finances, and
// there is no version of that a machine should be handling: they are disputing it,
// they cannot afford it, they do not understand it, or they have paid it, and all
// four need a person. `unclear` is therefore not a fallback that does nothing, it
// is an URGENT escalation, which is what "fail safe" has to mean here.
// ---------------------------------------------------------------------------

export type CollectionReplyKind =
  | "dispute"
  | "hardship"
  | "optout"
  | "confusion"
  | "acknowledgement"
  | "unclear";

/**
 * The patient is contesting something: the amount, the fact of the debt, whether
 * it is theirs at all, or the practice's conduct. Deliberately broad — a bare
 * "wrong" or "error" lands here — because every false positive costs one work item
 * and every false negative is a machine arguing with somebody about their money.
 */
const DISPUTE_PATTERNS: RegExp[] = [
  /\bdisput/i,
  /\bcomplain/i,
  /\balready (?:paid|settled|sorted)\b/i,
  /\bpaid (?:this|that|it|these|them|in full|already|last|weeks?|months?|yesterday|today)\b/i,
  /\bi(?:'ve| have)? paid\b/i,
  /\bwe(?:'ve| have)? paid\b/i,
  /\bwrong\b/i,
  /\berror\b/i,
  /\bincorrect\b/i,
  /\bmistake\b/i,
  /\bnot mine\b/i,
  /\bnot (?:my|our) (?:bill|invoice|account|debt)\b/i,
  /\bnot (?:correct|right|true)\b/i,
  /\b(?:this|that|it)(?:'s| is) not right\b/i,
  /\bnever (?:had|agreed|asked|booked|received|wanted|consented)\b/i,
  /\bdid ?n[o']?t (?:have|agree|ask|book|receive|want|consent)\b/i,
  /\bdo ?n[o']?t owe\b/i,
  /\bnothing (?:owed|outstanding|to pay)\b/i,
  /\brefund\b/i,
  /\bchargeback\b/i,
  /\bsolicitor\b/i,
  /\blegal action\b/i,
  /\bombudsman\b/i,
  /\bharass/i,
  /\bscam\b/i,
  /\bfraud\b/i,
];

/**
 * The patient cannot pay, or cannot pay it all at once. This is the class this
 * module exists to hand over gently: the ONE thing an automated system must never
 * do is negotiate, so the agent stops and a person talks to them.
 */
const HARDSHIP_PATTERNS: RegExp[] = [
  /\bca ?n[o']?t afford\b/i,
  /\bcannot afford\b/i,
  /\bafford it\b/i,
  /\bno money\b/i,
  /\bstruggl/i,
  /\bhardship\b/i,
  /\bskint\b/i,
  /\bbroke\b/i,
  /\blost my job\b/i,
  /\bmade redundant\b/i,
  /\bon (?:benefits|universal credit)\b/i,
  /\bpayment plan\b/i,
  /\bin ?stal?ments?\b/i,
  /\bspread (?:it|the cost|payments?)\b/i,
  /\bbit by bit\b/i,
  /\ba bit at a time\b/i,
  /\bpay (?:it )?(?:off )?(?:weekly|monthly|in bits)\b/i,
  /\bgive me (?:more )?time\b/i,
  /\bneed (?:more )?time\b/i,
];

/** "Stop messaging me". The suppression layer owns the actual opt-out record;
 *  this only decides this module's own stop reason. */
const OPTOUT_PATTERNS: RegExp[] = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bopt ?out\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bdo not contact\b/i,
  /\bdo ?n[o']?t contact me\b/i,
  /\bleave me alone\b/i,
  /\bno more (?:messages|texts|emails)\b/i,
];

/** The patient does not understand what the message is about. A machine that
 *  answers this is a machine explaining somebody's bill to them, which is exactly
 *  the conversation that has to be had by a person. */
const CONFUSION_PATTERNS: RegExp[] = [
  /\bwhat(?:'s| is) (?:this|that|it)\b/i,
  /\bwhat for\b/i,
  /\bwhat(?:'s| is) (?:this|it) (?:for|about)\b/i,
  /\bwhich (?:invoice|bill|appointment|treatment|one)\b/i,
  /\bwhen was (?:this|that|it)\b/i,
  /\bdo ?n[o']?t understand\b/i,
  /\bconfus/i,
  /\bnot sure what\b/i,
  /\bexplain\b/i,
  /\bwho (?:is|are) (?:this|you)\b/i,
  /\bnever (?:got|seen) (?:an? )?(?:invoice|bill|statement)\b/i,
];

/** A plain acknowledgement. It still stops the cadence and still raises a work
 *  item, because "I will pay it on Friday" is a promise somebody has to hold. */
const ACKNOWLEDGEMENT_PATTERNS: RegExp[] = [
  /^\s*(?:ok(?:ay)?|k|thanks?|thank you|ta|cheers|noted|got it|sure|yes|yep|yeah|fine|will do)\b/i,
  /\bi(?:'ll| will) (?:pay|sort|settle|transfer|call|ring|pop in)\b/i,
  /\bwill (?:pay|sort|settle|call|ring)\b/i,
  /\bpaying (?:it|this|today|tomorrow)\b/i,
  /\bsort(?:ing)? (?:it|this) out\b/i,
  /\bon (?:my|its) way\b/i,
];

/**
 * Classify one inbound reply.
 *
 * PRECEDENCE, and why it is this order:
 *   dispute  first, because a contested charge is the one thing that must never be
 *            softened into anything else. "I already paid, stop texting me" is a
 *            dispute that also happens to be an opt-out, and the suppression layer
 *            records the opt-out independently from the same message, so nothing
 *            is lost by reading it as the dispute it is.
 *   hardship next, so "I cannot afford this, please stop" reaches a person rather
 *            than being filed as a quiet unsubscribe.
 *   optout   next: a clean "STOP" is a clean instruction.
 *   confusion, then acknowledgement.
 *   unclear  last, and it is NOT a no-op: see the header.
 *
 * An empty or whitespace-only body is `unclear`, never `acknowledgement`. A blank
 * inbound message is a thing we failed to read, not a patient saying yes.
 */
export function classifyCollectionReply(body: string): CollectionReplyKind {
  const text = (body ?? "").trim();
  if (text.length === 0) return "unclear";
  if (DISPUTE_PATTERNS.some((re) => re.test(text))) return "dispute";
  if (HARDSHIP_PATTERNS.some((re) => re.test(text))) return "hardship";
  if (OPTOUT_PATTERNS.some((re) => re.test(text))) return "optout";
  if (CONFUSION_PATTERNS.some((re) => re.test(text))) return "confusion";
  if (ACKNOWLEDGEMENT_PATTERNS.some((re) => re.test(text))) return "acknowledgement";
  return "unclear";
}

/** The stop reason a reply of this kind produces. */
export function stopReasonForReply(kind: CollectionReplyKind): CollectionStopReason {
  switch (kind) {
    case "dispute":
      return "dispute";
    case "hardship":
      return "hardship";
    case "confusion":
      return "confusion";
    case "optout":
      return "opted_out";
    default:
      // An acknowledgement and an unread reply are both "the patient replied". No
      // narrower reason is TRUE of either, and recording one would be a claim about
      // what they said that nobody could stand behind.
      return "patient_replied";
  }
}

/** The escalation a reply of this kind raises. EVERY kind raises one. */
export function escalationForReply(kind: CollectionReplyKind): CollectionEscalationReason {
  switch (kind) {
    case "dispute":
      return "dispute";
    case "hardship":
      return "hardship";
    case "confusion":
      return "confusion";
    case "optout":
      return "opted_out";
    case "acknowledgement":
      return "acknowledgement";
    default:
      return "unclear_reply";
  }
}

/**
 * How quickly a person needs to look. `unclear` is URGENT on purpose: a reply the
 * classifier could not place is the case where the practice has the least idea
 * what a patient just told them about their money.
 */
export function escalationPriority(kind: CollectionReplyKind): "urgent" | "normal" {
  return kind === "acknowledgement" || kind === "optout" ? "normal" : "urgent";
}

// ---------------------------------------------------------------------------
// The decider.
// ---------------------------------------------------------------------------

/** The facts about a debtor the decider reasons about. Deliberately CHEAP: no
 *  invoice detail, because the balance verification is a live read and only
 *  happens once this decider has already said a message is due. */
export interface CollectionTargetFacts {
  patientId: string;
  siteId: string;
  /** Patient admin state in Dentally. An archived record is not messaged. */
  active: boolean;
  consent: { sms: boolean; email: boolean };
}

export interface CollectionDecisionInput {
  target: CollectionTargetFacts;
  /** Null the first time this patient is ever looked at. */
  state: CollectionState | null;
  /** Bodies of every inbound reply correlated to this patient's collection touches. */
  inboundBodies: string[];
  /** Platform admin status excludes them from outreach (inactive / do not contact). */
  excluded: boolean;
  /** A suppression row already covers this patient on either channel. */
  suppressed: boolean;
  now: Date;
  config: CollectionConfig;
  cadence?: CollectionStep[];
}

export type CollectionSkipReason =
  | "already_terminal"
  | "touch_pending"
  | "not_due"
  | "no_channel_consent"
  | "cooling_off";

export type CollectionDecision =
  | { action: "draft"; step: CollectionStep }
  | { action: "stop"; reason: CollectionStopReason; escalate: CollectionEscalationReason | null }
  | { action: "skip"; reason: CollectionSkipReason };

function consentedFor(t: CollectionTargetFacts, channel: TouchChannel): boolean {
  // WhatsApp rides the SMS consent flag and the same handset, exactly as every
  // other module here treats it.
  return channel === "email" ? t.consent.email : t.consent.sms;
}

/**
 * Decide what the agent should do about one debtor, right now.
 *
 * ORDER MATTERS and is deliberate: every STOP is evaluated before every SKIP, so a
 * patient who replied, opted out, disputed or was archived is stopped even while a
 * draft of theirs sits awaiting approval. A skip evaluated first would leave the
 * module holding a live draft for somebody who has already told the practice to
 * stop, and a human could then approve it.
 */
export function decideCollectionAction(input: CollectionDecisionInput): CollectionDecision {
  const { target, state, now, config } = input;
  const cadence = input.cadence ?? COLLECTION_CADENCE;

  // 1. Terminal is terminal. Only a person clearing the state revives it.
  if (state && (state.status === "stopped" || state.status === "exhausted")) {
    return { action: "skip", reason: "already_terminal" };
  }

  // 2. The record itself is archived or admin-excluded.
  if (!target.active || input.excluded) {
    return { action: "stop", reason: "excluded", escalate: null };
  }

  // 3. An existing opt-out on this patient.
  if (input.suppressed) return { action: "stop", reason: "opted_out", escalate: "opted_out" };

  // 4. ANY reply stops the cadence AND calls a person. See the classifier header:
  //    the classifier picks the reason, it does not decide whether to stop, and a
  //    reply it cannot place escalates as `unclear_reply` rather than being ignored.
  if (input.inboundBodies.length > 0) {
    const kinds = input.inboundBodies.map(classifyCollectionReply);
    // The most serious classification present wins, in the classifier's own order.
    const order: CollectionReplyKind[] = [
      "dispute",
      "hardship",
      "optout",
      "confusion",
      "unclear",
      "acknowledgement",
    ];
    const kind = order.find((k) => kinds.includes(k)) ?? "unclear";
    return {
      action: "stop",
      reason: stopReasonForReply(kind),
      escalate: escalationForReply(kind),
    };
  }

  // 5. We genuinely cannot deliver to them. Counted separately from blocks (see
  //    CollectionState.consecutiveBlocks for why that distinction exists).
  if (state && state.consecutiveFailures >= config.maxConsecutiveFailures) {
    return { action: "stop", reason: "undeliverable", escalate: null };
  }
  if (state && state.consecutiveBlocks >= config.maxConsecutiveBlocks) {
    return { action: "stop", reason: "undeliverable", escalate: null };
  }

  // 6. A touch is already pending, with a human or with the drain. Never stack.
  if (state && (state.status === "awaiting_approval" || state.status === "in_flight")) {
    return { action: "skip", reason: "touch_pending" };
  }

  // 7. Where we are in the cadence. `step` counts SENT touches.
  const nextStep = collectionStepDef((state?.step ?? 0) + 1, cadence);
  if (!nextStep) return { action: "stop", reason: "exhausted", escalate: null };

  // 8. Cooling off after a refusal, a discarded draft, a failed send or a block.
  if (state?.retryNotBefore) {
    const until = Date.parse(state.retryNotBefore);
    if (Number.isFinite(until) && now.getTime() < until) {
      return { action: "skip", reason: "cooling_off" };
    }
  }

  // 9. Consent for THIS step's channel. A skip, never a substitution.
  if (!consentedFor(target, nextStep.channel)) {
    return { action: "skip", reason: "no_channel_consent" };
  }

  // 10. Due? Step 1 is due immediately; later steps wait from the previous SENT touch.
  const last = state?.lastTouchAt ? Date.parse(state.lastTouchAt) : null;
  if (last !== null && Number.isFinite(last)) {
    if (now.getTime() - last < nextStep.waitDays * DAY) {
      return { action: "skip", reason: "not_due" };
    }
  }

  return { action: "draft", step: nextStep };
}
