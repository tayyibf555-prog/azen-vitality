// Treatment-plan closer: the cadence and the qualification decider.
//
// PURE. No I/O, no clock of its own, no environment reads. Everything the
// decision depends on is passed in, so every rule below is directly unit-testable
// and mutation-checkable. The sweep route does the reading and the writing; this
// module decides, and nothing else.

import type {
  CloserConfig,
  CloserState,
  CloserStep,
  CloserStopReason,
  TouchChannel,
} from "./types";
import type { OpportunityStatus } from "@/lib/coordinator/types";

const DAY = 86_400_000;

/**
 * The closer cadence: three touches, then done, ever.
 *
 * `waitDays` is the gap since the PREVIOUS SENT touch (step 1 measures from the
 * moment the opportunity qualifies), matching the reactivation/coordinator
 * cadence engine's own semantics. So 0 / 7 / 14 here is an ABSOLUTE schedule of
 * day 0, day 7 and day 21 from qualification.
 *
 * Why this shape, from what the coordinator's data actually supports:
 *
 * - The only signals stored on a treatment_opportunity are the plan's age
 *   (acceptedAt), its remaining value, whether finance was presented, and when
 *   the practice last made contact. There is no open, no click, no engagement
 *   score. So the one thing a cadence can honestly tune is the DECAY of an
 *   unanswered ask, and the answer to decay is fewer touches spaced wider, not
 *   more touches spaced evenly.
 *
 * - Widening 7 then 14 keeps the total at three contacts while spanning 21 days.
 *   That span is chosen to straddle a monthly pay cycle: when finance has not
 *   been presented, affordability is the single most common reason a planned
 *   treatment stalls, and a follow-up that lands in a different part of the month
 *   from the first one is asking at a genuinely different moment rather than
 *   asking the same question louder.
 *
 * - Channels alternate SMS, email, SMS. Step 2 is email because the "let us talk
 *   through the options" message is the one that needs room to breathe, and
 *   because it reads the OTHER consent flag: a patient who consented to only one
 *   channel therefore receives fewer touches rather than two of the same thing.
 *
 * - Three steps and then `exhausted`, permanently. Combined with the shared
 *   drain's once-per-day-per-patient cross-module cap, the worst case a patient
 *   can experience from this module is three messages per treatment plan, ever.
 */
export const CLOSER_CADENCE: CloserStep[] = [
  { step: 1, channel: "sms", waitDays: 0, purpose: "open" },
  { step: 2, channel: "email", waitDays: 7, purpose: "options" },
  { step: 3, channel: "sms", waitDays: 14, purpose: "close" },
];

/** The definition of step `n` (1-based), or null when the cadence is exhausted. */
export function closerStepDef(n: number, cadence: CloserStep[] = CLOSER_CADENCE): CloserStep | null {
  return cadence.find((s) => s.step === n) ?? null;
}

// ---------------------------------------------------------------------------
// Inbound reply classification.
//
// FAILS SAFE BY CONSTRUCTION: the classifier's job is only to pick the REASON.
// Any inbound reply at all stops the cadence (see decideCloserAction), so a
// mis-classification can never result in the patient being chased; it can only
// result in a less specific reason being recorded.
// ---------------------------------------------------------------------------

export type ReplyKind = "dispute" | "optout" | "reply";

/**
 * Wording that means the patient is contesting something. These need a HUMAN,
 * not another message: the closer stops for good and records `dispute` so the
 * opportunity shows up as needing a person rather than as simply quiet.
 */
const DISPUTE_PATTERNS: RegExp[] = [
  /\bdisput/i,
  /\bcomplain/i,
  /\balready paid\b/i,
  /\bpaid (?:this|that|it|for it|in full|already)\b/i,
  /\bnot (?:mine|correct|right|true)\b/i,
  /\b(?:this|that|it)(?:'s| is) (?:wrong|incorrect|not right)\b/i,
  /\bwrong (?:person|number|patient|amount|plan|treatment)\b/i,
  /\bnever (?:agreed|asked|booked|had|wanted|consented)\b/i,
  /\bdid ?n[o']?t (?:agree|ask|book|have|want|consent)\b/i,
  /\bmistake\b/i,
  /\bsolicitor\b/i,
  /\blegal action\b/i,
  /\bharass/i,
  /\bombudsman\b/i,
  /\brefund\b/i,
];

/** Wording that means "stop messaging me". The suppression layer owns the actual
 *  opt-out record; this only decides the closer's own stop reason. */
const OPTOUT_PATTERNS: RegExp[] = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bopt ?out\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bdo not contact\b/i,
  /\bdon'?t contact me\b/i,
  /\bleave me alone\b/i,
  /\bno more (?:messages|texts|emails)\b/i,
];

/**
 * Classify one inbound reply.
 *
 * DISPUTE WINS over OPTOUT when a message is both ("this is wrong, stop texting
 * me"). Both stop the closer identically, so precedence only changes what a human
 * sees, and a contested plan is the one that needs a person to pick it up. The
 * opt-out itself is not lost: the suppression layer records it independently from
 * the same inbound message.
 */
export function classifyInboundReply(body: string): ReplyKind {
  const text = body ?? "";
  if (DISPUTE_PATTERNS.some((re) => re.test(text))) return "dispute";
  if (OPTOUT_PATTERNS.some((re) => re.test(text))) return "optout";
  return "reply";
}

// ---------------------------------------------------------------------------
// The decider.
// ---------------------------------------------------------------------------

/** The fields of a treatment_opportunity the closer actually reasons about. */
export interface CloserOpportunityFacts {
  id: string;
  siteId: string;
  status: OpportunityStatus;
  /** ISO. When the plan was accepted / created. */
  acceptedAt: string;
  /** GBP of treatment still to be done. NOT money owed. */
  amountOutstanding: number;
  consent: { sms: boolean; email: boolean };
}

export interface CloserDecisionInput {
  opportunity: CloserOpportunityFacts;
  /** Null the first time the closer ever looks at this opportunity. */
  state: CloserState | null;
  /**
   * Bodies of every inbound reply correlated to this patient, from the closer's
   * OWN touches and from the treatment coordinator's (the same patient, the same
   * conversation as far as they are concerned).
   */
  inboundBodies: string[];
  /** Patient admin status excludes them from outreach (inactive / do not contact). */
  excluded: boolean;
  /** A suppression row already covers this patient ref on the step's channel. */
  suppressed: boolean;
  now: Date;
  config: CloserConfig;
  cadence?: CloserStep[];
}

export type CloserSkipReason =
  | "already_terminal"
  | "touch_pending"
  | "plan_too_new"
  | "below_value_floor"
  | "not_due"
  | "no_channel_consent"
  | "cooling_off";

export type CloserDecision =
  | { action: "draft"; step: CloserStep }
  | { action: "stop"; reason: CloserStopReason }
  | { action: "skip"; reason: CloserSkipReason };

/** The coordinator's own open set. Anything else is closed as far as we are concerned. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(["accepted", "in_progress", "stalled"]);

function consentedFor(o: CloserOpportunityFacts, channel: TouchChannel): boolean {
  // WhatsApp rides on the SMS consent flag and the same handset, exactly as the
  // coordinator's sweep and its action route both treat it.
  return channel === "email" ? o.consent.email : o.consent.sms;
}

function ageDays(acceptedAt: string, now: Date): number | null {
  const t = Date.parse(acceptedAt);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / DAY;
}

/**
 * Decide what the closer should do with one opportunity, right now.
 *
 * ORDER MATTERS and is deliberate: every STOP condition is evaluated before every
 * SKIP condition, so a patient who replied, opted out, disputed, or whose plan
 * completed is stopped even while a draft of theirs is sitting awaiting approval.
 * A skip that ran first would leave the closer holding a stale draft for someone
 * who has already told us to stop.
 */
export function decideCloserAction(input: CloserDecisionInput): CloserDecision {
  const { opportunity: o, state, now, config } = input;
  const cadence = input.cadence ?? CLOSER_CADENCE;

  // 1. Terminal is terminal. Nothing below can revive a stopped or exhausted
  //    opportunity; only a human clearing the state can.
  if (state && (state.status === "stopped" || state.status === "exhausted")) {
    return { action: "skip", reason: "already_terminal" };
  }

  // 2/3. The plan itself is finished or closed. 'completed' is the coordinator's
  //      own terminal status; anything outside its open set is closed to us.
  if (o.status === "completed") return { action: "stop", reason: "plan_completed" };
  if (!OPEN_STATUSES.has(o.status)) return { action: "stop", reason: "opportunity_closed" };

  // 4. Nothing left to do on the plan means there is nothing to talk about. This
  //    is the same test the coordinator's normaliser uses to decide a plan is not
  //    an opportunity at all.
  if (!(o.amountOutstanding > 0)) return { action: "stop", reason: "plan_completed" };

  // 5. Platform admin status (inactive / do not contact).
  if (input.excluded) return { action: "stop", reason: "excluded" };

  // 6. An existing opt-out on this patient ref.
  if (input.suppressed) return { action: "stop", reason: "opted_out" };

  // 7. ANY reply stops the cadence. The classifier only chooses the reason, so a
  //    reply we cannot classify still stops (fail safe).
  if (input.inboundBodies.length > 0) {
    const kinds = input.inboundBodies.map(classifyInboundReply);
    if (kinds.includes("dispute")) return { action: "stop", reason: "dispute" };
    if (kinds.includes("optout")) return { action: "stop", reason: "opted_out" };
    return { action: "stop", reason: "patient_replied" };
  }

  // 8. We cannot reach them. Repeated failed or blocked deliveries mean the
  //     channel is dead (or every send is being blocked), and replaying the same
  //     step against it forever is exactly the behaviour we set out not to build.
  if (state && state.consecutiveFailures >= config.maxConsecutiveFailures) {
    return { action: "stop", reason: "undeliverable" };
  }

  // 9. A plan past the age ceiling is not a live opportunity any more. An
  //    unparseable acceptedAt is treated the same way: we will not follow up on a
  //    plan whose age we cannot establish.
  const age = ageDays(o.acceptedAt, now);
  if (age === null) return { action: "stop", reason: "too_old" };
  if (age > config.maxPlanAgeDays) return { action: "stop", reason: "too_old" };

  // 10. A touch is already pending, either with a human for approval or with the
  //     shared drain for delivery. Do not stack a second one on top of it.
  if (state && (state.status === "awaiting_approval" || state.status === "in_flight")) {
    return { action: "skip", reason: "touch_pending" };
  }

  // 11. Where we are in the cadence. `step` counts SENT touches, so the next step
  //     is step+1; past the end the opportunity is exhausted for good.
  const nextStep = closerStepDef((state?.step ?? 0) + 1, cadence);
  if (!nextStep) return { action: "stop", reason: "exhausted" };

  // 12. Settling window. A plan the patient accepted days ago may simply be
  //     booked already, and the coordinator's own 0/3/7 nudge may still be
  //     running. minPlanAgeDays > that span is what keeps the two apart.
  if (age < config.minPlanAgeDays) return { action: "skip", reason: "plan_too_new" };

  // 13. Value floor. The drain allows ONE outreach message per patient per day
  //     across every module, so a contact spent here is a recall or reactivation
  //     not sent. Small remainders do not earn that.
  if (o.amountOutstanding < config.minRemainingValue) {
    return { action: "skip", reason: "below_value_floor" };
  }

  // 14. Consent for THIS step's channel. Deliberately a skip, not a channel
  //     substitution: a patient who consented to SMS only should receive fewer
  //     touches, not have an email step silently re-routed onto their phone.
  if (!consentedFor(o, nextStep.channel)) {
    return { action: "skip", reason: "no_channel_consent" };
  }

  // 15. Cooling off after a compliance refusal, a discarded draft or a failed
  //     send, so an opportunity that keeps failing cannot burn the AI budget on
  //     every tick.
  if (state?.retryNotBefore) {
    const until = Date.parse(state.retryNotBefore);
    if (Number.isFinite(until) && now.getTime() < until) {
      return { action: "skip", reason: "cooling_off" };
    }
  }

  // 16. Due? Step 1 is due as soon as the settling window has passed. Later steps
  //     wait `waitDays` from the previous SENT touch.
  const last = state?.lastTouchAt ? Date.parse(state.lastTouchAt) : null;
  if (last !== null && Number.isFinite(last)) {
    if (now.getTime() - last < nextStep.waitDays * DAY) {
      return { action: "skip", reason: "not_due" };
    }
  }

  return { action: "draft", step: nextStep };
}
