// THE BROWSER HALF of step drop-off: a tiny, fire-and-forget beacon that tells the
// server which screen of an authored funnel a session reached.
//
// ============================================================================
// ONE CALLER, BY DESIGN: the deterministic quiz
// (src/components/assess/deterministic-assessment-quiz.tsx), which creates a
// beacon on mount and calls view() once per screen it shows.
//
// It shipped exported and uncalled while the STEP NUMBERING was undecided, because
// none of the numbers already in the tree is a screen ordinal: `phoneFlowLayout`'s
// `step` is a 1-based QUESTION chip for the preview strip (a welcome screen shares
// the first question's number), and `walkFlow`'s `asked` is a list of question ids,
// i.e. the path one SESSION took. The stitch settled it in step-numbering.ts — a
// screen's position in the funnel's own canonical order — and that ONE module is
// called by both halves: this beacon's caller to decide what to post, and the
// guarded read route to label the chart and pad it to the funnel's length.
//
// So this file still refuses to invent an ordinal. It takes one, validates it
// against the rules the server validates with, and posts nothing it cannot stand
// behind. step-beacon.test.ts pins that the single importer is the quiz.
// ============================================================================
//
// BROWSER-ONLY, with no server imports at all: it guards on `typeof window` and
// imports nothing but the pure rules module and the shared beacon transport (which
// itself imports nothing), so it is safe to pull into a "use client" component.
// Every path is wrapped, so telemetry can never throw into a render or a click
// handler.
//
// PII: NONE, and it is not a matter of care at the call site. The only things this
// module can send are a client slug, a campaign slug, a version number, an opaque
// nonce and small integers. There is no free-form field to put anything else in —
// the server's parser would refuse it anyway (step-events.ts), but the point is
// that the call signature offers nowhere to type it.

import { postJsonBeacon } from "./beacon-transport";
import {
  MAX_EVENTS_PER_BATCH,
  isValidFlowVersion,
  isValidNonce,
  isValidStepIndex,
} from "./step-events";

const ENDPOINT = "/api/smile-assessment/step-event";
const FLUSH_DEBOUNCE_MS = 1200;

export interface StepBeacon {
  /** Record that the session reached this screen. No-op on anything invalid. */
  view(stepIndex: number): void;
  /** Force whatever is queued out now (e.g. just before a full-page navigation). */
  flush(): void;
}

/** An inert beacon: every method a no-op. Returned rather than null so no caller needs a guard. */
const INERT: StepBeacon = { view: () => {}, flush: () => {} };

/**
 * A per-session nonce: opaque, URL-safe, and inside the length the server accepts.
 *
 * crypto.randomUUID() where it exists; otherwise time + randomness, which is not
 * cryptographic and does not need to be — this value's only job is to be unlikely
 * to collide with another session's within the same campaign, so that a session
 * counts once per step. It identifies nobody and is never persisted in the browser.
 */
function newNonce(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  // Hyphen-joined base36: inside NONCE_PATTERN, and comfortably over NONCE_MIN_LENGTH.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Make a beacon for one session of one campaign's funnel.
 *
 * NO-OPS RATHER THAN THROWS on anything missing or invalid — no campaign, no
 * client, a version that is not a version, or being called on the server. A funnel
 * with no campaign behind it (the generic /assess/<client> quiz, the internal live
 * preview) has nothing to attribute a step to, and the honest behaviour there is to
 * send nothing at all rather than rows nobody can read.
 */
export function createStepBeacon(opts: {
  clientSlug: string;
  campaignSlug: string;
  flowVersion: number;
}): StepBeacon {
  // SSR: nothing to send, nothing to break.
  if (typeof window === "undefined") return INERT;
  if (!opts.clientSlug || !opts.campaignSlug) return INERT;
  if (!isValidFlowVersion(opts.flowVersion)) return INERT;

  const nonce = newNonce();
  // Belt and braces: a fallback nonce that somehow failed the shared validator
  // would be silently dropped by the server on every post, so refuse up front
  // rather than send a session's whole funnel into a bin.
  if (!isValidNonce(nonce)) return INERT;

  // Every step this session has ALREADY had accepted, so a re-render, a back
  // navigation or a bfcache restore does not re-queue a screen. The server and the
  // aggregation both de-duplicate as well; this is simply the cheapest place to do
  // it, and it is what keeps one session to one small post.
  const sent = new Set<number>();
  let queue: number[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function send(steps: number[]): void {
    if (steps.length === 0) return;
    // WHAT is sent is this module's business; HOW it leaves the page is not, and
    // is shared with the lead progress beacon (beacon-transport.ts). Only the
    // mechanics are shared: this nonce is minted here and goes nowhere else.
    postJsonBeacon(
      ENDPOINT,
      JSON.stringify({
        clientSlug: opts.clientSlug,
        campaignSlug: opts.campaignSlug,
        flowVersion: opts.flowVersion,
        nonce,
        steps,
      }),
    );
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    send(batch);
  }

  function view(stepIndex: number): void {
    try {
      if (!isValidStepIndex(stepIndex)) return;
      if (sent.has(stepIndex)) return;
      sent.add(stepIndex);
      queue.push(stepIndex);
      // Cap the buffer at the server's own batch limit: a bigger post would have
      // its tail dropped at the door, so flushing here keeps every step.
      if (queue.length >= MAX_EVENTS_PER_BATCH) {
        flush();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
    } catch {
      // Never let tracking throw into a handler.
    }
  }

  // Flush on the page going away, or the last screen a session saw — the one the
  // whole chart is about — is the one that never gets sent. pagehide and
  // visibilitychange:hidden are the reliable mobile signals; beforeunload is
  // unreliable on mobile Safari and omitted deliberately (funnel/client.ts takes
  // the same line).
  try {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  } catch {
    // Listener registration failing must not break the beacon.
  }

  return { view, flush };
}
