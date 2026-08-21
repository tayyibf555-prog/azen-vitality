// WHERE IN THE FUNNEL A LEAD STOPPED: the rules, and the sentence the practice
// reads. Nothing else — no I/O, no React, no server imports.
//
// PURE, AND IT HAS TO BE. Three very different callers share these rules and must
// not each own a copy:
//   - the public SUBMIT route, which decides at capture whether this session's
//     position can be recorded at all and what N and M are;
//   - the public PROGRESS route, which reads a post from a patient's browser;
//   - the Leads WORKLIST and DRAWER, which are client components rendering the
//     sentence.
// A second copy of "N of M" or of the quiet period would be two answers to one
// question, and the one on the screen would be the one nobody tested.
//
// THE NONCE VALIDATOR IS BORROWED FROM step-events.ts ON PURPOSE. One closed
// charset rule for every opaque session value in this module, so an email address,
// a name or a sentence is not a token here either. What is NOT shared is the
// VALUE: 0080's nonce is minted in the browser and stays inside the anonymous
// beacon; this one is minted on the server, per lead. They are different mints and
// can never collide, which is what keeps assessment_step_event unjoinable to a
// person. See 0094's header.
//
// NO PII. The only things this module handles are integers, timestamps and an
// opaque random.

import { isValidNonce, isValidStepIndex, MAX_STEP_INDEX } from "./step-events";
import type { StepNumbering } from "./step-numbering";

/**
 * How long a funnel session may sit still before the practice is told it was
 * ABANDONED rather than merely reached.
 *
 * THIRTY MINUTES, and the number is chosen against the failure it prevents rather
 * than for tidiness. A patient can legitimately be slow: they put the phone down,
 * read a treatment page in another tab, get interrupted, come back. Labelling a
 * live session "abandoned" would put a person who is still typing at the top of a
 * chase list, and the first thing the practice would learn is that the label
 * cannot be trusted. A real funnel session is minutes long, so half an hour is far
 * past any of them and still short enough that a morning's drop-offs are visible
 * the same morning.
 *
 * COMPUTED AT DISPLAY TIME, never stored. There is no sweep, no cron and no
 * "abandoned" flag that could be wrong: the age is `now - funnel_last_step_at`,
 * decided while the row is being rendered, so it is right at the instant somebody
 * is actually reading it.
 */
export const FUNNEL_QUIET_MINUTES = 30;

const QUIET_MS = FUNNEL_QUIET_MINUTES * 60 * 1000;

/**
 * The shortest funnel this feature will describe: one question, the contact
 * screen, the result. Below that "question N of M" has no M to speak of, and the
 * honest thing is to record nothing rather than a fraction with a zero in it.
 */
export const MIN_FUNNEL_STEPS = 3;

/** The highest step count a lead may carry, inherited from the ordinal's own ceiling. */
export const MAX_FUNNEL_STEPS = MAX_STEP_INDEX + 1;

// ---------------------------------------------------------------------------
// What a lead carries.
// ---------------------------------------------------------------------------

/**
 * The funnel-progress half of a lead, as both the worklist and the drawer see it.
 * Every field nullable together: a lead with no funnel behind it (a missed call, a
 * website form, every lead created before 0094) carries nulls and renders nothing.
 */
export interface LeadFunnelProgress {
  /** 0-based screen ordinal, in the numbering of `flowVersion`. */
  lastStep: number | null;
  /** How many screens that funnel version has. */
  totalSteps: number | null;
  /** Which save of the funnel the two numbers above describe. */
  flowVersion: number | null;
  /** ISO. When the position above was last raised. */
  lastStepAt: string | null;
  /** ISO. Set once, when the last screen was reached. */
  completedAt: string | null;
}

/** The empty progress: what every non-funnel lead has, spelled once. */
export const NO_FUNNEL_PROGRESS: LeadFunnelProgress = {
  lastStep: null,
  totalSteps: null,
  flowVersion: null,
  lastStepAt: null,
  completedAt: null,
};

// ---------------------------------------------------------------------------
// Capture: may this session's position be recorded, and as what?
// ---------------------------------------------------------------------------

/** What gets stamped on the lead at the moment contact details are captured. */
export interface FunnelCaptureStamp {
  /** The contact screen's ordinal — where the person was when they gave details. */
  lastStep: number;
  /** The whole funnel's screen count, for this version. */
  totalSteps: number;
}

/**
 * The capture stamp for a funnel, or null when this funnel cannot be described.
 *
 * THE INVARIANT THIS GATE BUYS, and it is the reason the function exists rather
 * than two lines at the call site. `stepNumbering` lays a funnel out as
 * [questions... , contact, result]: questions sorted by longest-path depth, then
 * the single contact screen (which every question must precede, because every path
 * ends at a result and rule 6 makes the contact screen dominate every result), then
 * ONE collapsed result ordinal. So in any funnel this returns a stamp for:
 *
 *     contact  == totalSteps - 2
 *     result   == totalSteps - 1
 *
 * Refusing to stamp anything else is what lets the DISPLAY name the screen a lead
 * stopped on without storing its kind: below totalSteps-2 is a question, and the
 * question count is totalSteps-2. A funnel that does not satisfy the invariant —
 * no reachable contact screen, no result, a hand-edited graph — is recorded as
 * nothing at all, because a wrong sentence on a worklist is worse than no sentence.
 */
export function funnelCaptureStamp(numbering: StepNumbering): FunnelCaptureStamp | null {
  const { contactStep, outcomeStep, stepCount } = numbering;
  if (contactStep === null || outcomeStep === null) return null;
  if (stepCount < MIN_FUNNEL_STEPS || stepCount > MAX_FUNNEL_STEPS) return null;
  if (outcomeStep !== stepCount - 1) return null;
  if (contactStep !== stepCount - 2) return null;
  return { lastStep: contactStep, totalSteps: stepCount };
}

// ---------------------------------------------------------------------------
// The public progress post.
// ---------------------------------------------------------------------------

/** One browser saying "this session has now reached screen `step`". */
export interface FunnelProgressPost {
  /** The bearer: the opaque value the submit response handed this session. */
  token: string;
  /** Which save of the funnel the session is walking. Must match the lead's. */
  flowVersion: number;
  /** The screen reached, 0-based, in that version's numbering. */
  step: number;
}

/**
 * Read a posted body as a progress report, or refuse it.
 *
 * CONSTRUCTED, NEVER SPREAD, exactly as parseStepEventBatch is: the returned
 * object holds these three keys and no key the caller invented, whatever they
 * named it. That is what makes "the endpoint can never touch another column" a
 * property of the shape rather than of the SQL alone — there is no field here for
 * a stage, a phone number or a name to arrive in.
 *
 * null means "nothing usable", and the caller's contract is to drop it silently
 * and answer the same opaque acknowledgement it answers everything with.
 */
export function parseFunnelProgressPost(raw: unknown): FunnelProgressPost | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (!isValidNonce(body.token)) return null;
  if (typeof body.flowVersion !== "number" || !Number.isInteger(body.flowVersion)) return null;
  if (body.flowVersion < 0) return null;
  if (!isValidStepIndex(body.step)) return null;
  return { token: body.token, flowVersion: body.flowVersion, step: body.step };
}

/**
 * May `step` become this lead's new position?
 *
 * THE THREE RULES, in one pure place so the endpoint's SQL and its tests are
 * talking about the same thing:
 *   FORWARD ONLY   strictly greater than where the lead already is. A funnel is
 *                  walked forwards; a post that moves somebody backwards is either
 *                  a stale retry arriving late or somebody playing, and both
 *                  answers are "no".
 *   INSIDE THE FUNNEL  never past the last screen. The ordinal becomes "N of M" on
 *                  a worklist, and "question 9 of 5" is not a fact.
 *   SAME VERSION   the post must be about the save the lead's N and M came from.
 *                  Otherwise a session still walking v3 could advance a lead into
 *                  a v4 ordinal that means a different screen, and the fraction on
 *                  the screen would quietly stop being true.
 */
export function canAdvanceFunnelProgress(args: {
  current: LeadFunnelProgress;
  flowVersion: number;
  step: number;
}): boolean {
  const { current, flowVersion, step } = args;
  if (current.lastStep === null || current.totalSteps === null) return false;
  if (current.flowVersion === null || current.flowVersion !== flowVersion) return false;
  if (!isValidStepIndex(step)) return false;
  if (step <= current.lastStep) return false;
  if (step > current.totalSteps - 1) return false;
  return true;
}

/** True when `step` is the funnel's last screen, i.e. this session finished it. */
export function isFunnelFinalStep(totalSteps: number, step: number): boolean {
  return totalSteps >= MIN_FUNNEL_STEPS && step === totalSteps - 1;
}

// ---------------------------------------------------------------------------
// The sentence.
// ---------------------------------------------------------------------------

export interface FunnelProgressLabel {
  /** The full sentence, for the lead drawer. */
  text: string;
  /** The compact form, for the worklist's sub-line under Source. */
  short: string;
  /** A subset of the StatusPill tones, assignable to `Tone` without a cast. */
  tone: "success" | "warning" | "info";
  /** True only when the session reached the result screen. */
  complete: boolean;
  /** True once the quiet period has passed with no further progress. */
  abandoned: boolean;
}

/**
 * What the practice reads about this lead's funnel, or null when there is nothing
 * to say (no progress recorded, or a shape that cannot be described honestly).
 *
 * THE WORDING IS A DECISION, and there are three cases rather than two:
 *
 *   COMPLETED        "Completed the assessment". Unambiguous, and it is the
 *                    majority — most people who give their details do go on to the
 *                    result screen a moment later.
 *   STOPPED ON A QUESTION  "Abandoned at question N of M" once the funnel has been
 *                    quiet for FUNNEL_QUIET_MINUTES, and "Reached question N of M"
 *                    before that. Same fact, and the second wording is the honest
 *                    one while the person may still be answering: the word
 *                    "abandoned" is a judgement about a session that has ENDED, and
 *                    a worklist that applies it to somebody mid-quiz is telling the
 *                    practice to chase a patient who has not gone anywhere.
 *   STOPPED ON THE CONTACT SCREEN  "Gave their details, never finished" (quiet) or
 *                    "Gave their details, not finished yet" (recent). This case is
 *                    deliberately NOT worded as a question number: the screen they
 *                    are on is the contact form, not question M-1, and "abandoned
 *                    at question 6 of 5" is what counting screens as questions
 *                    produces. M is the QUESTION count (totalSteps - 2), which is
 *                    the number a patient would recognise if they counted.
 */
export function funnelProgressLabel(
  progress: LeadFunnelProgress,
  nowIso: string,
): FunnelProgressLabel | null {
  const { lastStep, totalSteps, lastStepAt, completedAt } = progress;

  if (completedAt) {
    return {
      text: "Completed the assessment",
      short: "Assessment complete",
      tone: "success",
      complete: true,
      abandoned: false,
    };
  }

  if (lastStep === null || totalSteps === null) return null;
  if (totalSteps < MIN_FUNNEL_STEPS || totalSteps > MAX_FUNNEL_STEPS) return null;
  if (!isValidStepIndex(lastStep) || lastStep > totalSteps - 1) return null;

  const abandoned = isQuiet(lastStepAt, nowIso);
  const tone = abandoned ? "warning" : "info";

  // The contact screen: they gave their details here (which is why this lead
  // exists) and went no further.
  if (lastStep >= totalSteps - 2) {
    return {
      text: abandoned ? "Gave their details, never finished" : "Gave their details, not finished yet",
      short: abandoned ? "Never finished" : "Not finished yet",
      tone,
      complete: false,
      abandoned,
    };
  }

  // A question screen. Questions are every ordinal below the contact screen, so
  // there are totalSteps - 2 of them and this is the (lastStep + 1)th.
  const n = lastStep + 1;
  const of = totalSteps - 2;
  return {
    text: abandoned ? `Abandoned at question ${n} of ${of}` : `Reached question ${n} of ${of}`,
    short: abandoned ? `Left at question ${n} of ${of}` : `At question ${n} of ${of}`,
    tone,
    complete: false,
    abandoned,
  };
}

/**
 * Has this funnel been quiet long enough to call it abandoned?
 *
 * An unreadable or missing timestamp answers NO. The two wordings differ only in
 * whether they accuse somebody of leaving, so the failure has a right direction:
 * with no idea how long it has been, say the gentler thing.
 */
function isQuiet(lastStepAt: string | null, nowIso: string): boolean {
  if (!lastStepAt) return false;
  const then = new Date(lastStepAt).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(then) || Number.isNaN(now)) return false;
  return now - then >= QUIET_MS;
}
