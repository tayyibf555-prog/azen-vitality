// ===========================================================================
// WHAT THE OWNER'S SCREEN DOES BETWEEN BUILD TICKS — a PURE LEAF.
//
// The segment builder is a resumable loop: the Campaigns screen POSTs
// /api/outreach/build over and over until the tick says it is finished. Deciding
// when to STOP that loop, and what sentence to leave on the screen when it does,
// is a rule with four outcomes and one of them is a safety refusal — so it lives
// here, as a function with no imports, rather than inside a React callback where
// nothing can reach it.
//
// WHY IT MOVED. The loop used to break on `done` and `stopped` only. A tick that
// REFUSED — because the list of patients who must never be contacted could not
// be read while messaging is live (ruling W1-B/2, and the fail-direction law
// W1-B/1-5) — comes back ok:true / done:false / stopped:null, which is
// indistinguishable from a healthy mid-scan tick unless `skipped` is read. So the
// screen span its full MAX_BUILD_TICKS against a table that could not be read and
// left the owner watching "scanned 0 / matched 0" with no note at all: a blank
// screen that reads as a broken build rather than as a safety check declining to
// guess.
//
// This file imports NOTHING, deliberately, for the reason write-vocabulary.ts
// gives: a "use client" component reads it, and a leaf that reaches for a
// database or an environment variable is a leaf that drags the server into the
// browser bundle the day somebody adds one line to it.
// ===========================================================================

/** The fields of a build tick's JSON that decide what the loop does next. */
export interface BuildTickResponse {
  ok?: boolean;
  done?: boolean;
  stopped?: "403" | "429" | null;
  /**
   * Present when the tick did no work and that is NOT a failure. Two producers,
   * and they mean opposite things: "already built" (arrives with done:true, so
   * the done branch answers it first) and "exclusions unavailable" — the refusal
   * this file exists for.
   */
  skipped?: string;
  error?: string;
}

/** The generic failure, used only when the server sent no sentence of its own. */
export const BUILD_FAILED_NOTE = "The build hit a problem and stopped. You can try again.";

/** A Dentally 403/429: the scan is resumable and the owner may simply continue. */
export const BUILD_RATE_LIMITED_NOTE =
  "Dentally paused us briefly (rate limit); the scan will pick up where it left off if you continue.";

/**
 * THE REFUSAL, in the words of the person at the desk.
 *
 * What happened, what it means, and what to do — in that order. It says NOBODY
 * was added rather than "the build paused", because those are different facts
 * and only one of them is true; and it says nothing has been sent, because that
 * is the first thing anybody wants to know about a campaign screen behaving
 * strangely.
 */
export const BUILD_EXCLUSIONS_UNAVAILABLE_NOTE =
  "We could not check the do-not-contact list just now, so nobody was added to this list. Nothing has been sent. Try again in a few minutes.";

export interface BuildLoopStep {
  /** Stop looping. */
  stop: boolean;
  /** The sentence to leave on screen, or null to leave it clear. */
  note: string | null;
  /**
   * TRUE when the response is a failure and the tick's counts must not be
   * painted — the body may carry nothing but an error. The caller keeps whatever
   * the previous tick showed rather than blanking the screen to zero.
   */
  failed: boolean;
}

/**
 * What the build loop does after one tick.
 *
 * ORDER IS THE RULE, and it is the same order the sweep's own continuation uses:
 * a transport or server failure first, then a finished build, then a rate-limit
 * back-off, then a refusal. `done` is asked before `skipped` on purpose — the
 * "already built" tick carries both, and it is finished, not refused.
 *
 * A tick that is none of those keeps the loop going with no note: a healthy
 * mid-scan tick has nothing to say beyond its counts.
 */
export function buildLoopStep(httpOk: boolean, data: BuildTickResponse): BuildLoopStep {
  if (!httpOk || data.ok === false) {
    return { stop: true, note: data.error || BUILD_FAILED_NOTE, failed: true };
  }
  if (data.done) return { stop: true, note: null, failed: false };
  if (data.stopped) return { stop: true, note: BUILD_RATE_LIMITED_NOTE, failed: false };
  if (data.skipped) return { stop: true, note: BUILD_EXCLUSIONS_UNAVAILABLE_NOTE, failed: false };
  return { stop: false, note: null, failed: false };
}
