// THE BROWSER HALF of lead funnel progress: a tiny, fire-and-forget post saying
// "the session holding this token has now reached screen N".
//
// ============================================================================
// ONE CALLER, BY DESIGN: the deterministic quiz
// (src/components/assess/deterministic-assessment-quiz.tsx), and only AFTER the
// contact step has been submitted and the server handed that session a token.
// Before then there is no lead to have progress, and pre-contact visitors stay
// anonymous — which is the whole reason this is a separate thing from the
// anonymous step beacon rather than a field on it. funnel-progress-beacon.test.ts
// pins that the single importer is the quiz.
// ============================================================================
//
// THIS IS NOT step-beacon.ts, AND THE DIFFERENCE IS THE POINT. That one writes
// anonymous rows to assessment_step_event under a nonce the browser minted. This
// one writes to a NAMED PERSON'S LEAD under a token the SERVER minted, so the two
// values are from different mints and can never be the same string. Nothing here
// ever sees the beacon's nonce, so the anonymous table stays unjoinable to a
// person (see supabase/migrations/0094).
//
// BROWSER-ONLY, with no server imports at all: it guards on `typeof window` and
// imports nothing but the pure rules module, so it is safe to pull into a
// "use client" component. Every path is wrapped, so telemetry can never throw into
// a render or a click handler.
//
// PII: NONE. The only things this module can send are an opaque token, a version
// number and one small integer. The call signature offers nowhere to type anything
// else, and the server's parser constructs its result rather than spreading the
// body, so an invented key could not survive the trip either.

import { isValidStepIndex } from "./step-events";

const ENDPOINT = "/api/smile-assessment/funnel-progress";

export interface FunnelProgressReporter {
  /** Record that this session reached screen `step`. No-op on anything invalid. */
  report(step: number): void;
}

/** An inert reporter: every method a no-op. Returned rather than null so no caller needs a guard. */
const INERT: FunnelProgressReporter = { report: () => {} };

/**
 * Make a reporter for one lead's funnel session.
 *
 * NO-OPS RATHER THAN THROWS on anything missing or invalid — no token, a version
 * that is not a version, or being called on the server. The server refuses all
 * three anyway; refusing them here means a broken session sends nothing at all
 * rather than a stream of posts that can only be dropped.
 *
 * FORWARD-ONLY LOCALLY TOO. The server's UPDATE is the real guard (it refuses any
 * step that is not strictly greater than the one on the row), and this keeps the
 * same rule in the browser so a re-render, a Back navigation or a bfcache restore
 * costs no request at all. Cheapest place to do it; not the place it is enforced.
 */
export function createFunnelProgressReporter(opts: {
  token: string;
  flowVersion: number;
}): FunnelProgressReporter {
  // SSR: nothing to send, nothing to break.
  if (typeof window === "undefined") return INERT;
  if (typeof opts.token !== "string" || opts.token === "") return INERT;
  if (!Number.isInteger(opts.flowVersion) || opts.flowVersion < 0) return INERT;

  let highest = -1;

  function report(step: number): void {
    try {
      if (!isValidStepIndex(step)) return;
      if (step <= highest) return;
      highest = step;
      const payload = JSON.stringify({
        token: opts.token,
        flowVersion: opts.flowVersion,
        step,
      });
      try {
        if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
          // sendBeacon survives the page being navigated away, which is exactly
          // when the LAST screen — the one that decides "completed" against
          // "abandoned" — is reached.
          const blob = new Blob([payload], { type: "application/json" });
          if (navigator.sendBeacon(ENDPOINT, blob)) return;
        }
      } catch {
        // fall through to fetch
      }
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Never let progress reporting throw into a render or a handler.
    }
  }

  return { report };
}
