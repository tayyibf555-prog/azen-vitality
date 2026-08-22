// Landing-page client-side event tracker.
//
// INTEGRATION SEAM — reconciled to the real /api/funnel-event contract.
// The funnel-events endpoint (owned by the booking workstream) accepts a BATCHED
// envelope, not a per-event top-level shape. This file is the SINGLE place that
// knows that shape, so any future endpoint change is a one-file edit here.
//
//   POST /api/funnel-event
//   body: {
//     clientSlug,                 // top-level, resolved server-side to a client id
//     surface: "landing",         // one of the funnel surfaces (see lib/funnel/events)
//     sessionId,                  // top-level, PII-free random id
//     events: [                   // the batch (one entry here; fire-and-forget)
//       { step, meta: { variant, landingSlug } }
//     ]
//   }
//
// `variant` and `landingSlug` ride inside meta as plain strings so they survive
// the endpoint's sanitizeMeta (which keeps only small scalars and drops nested
// values) — that is what lets funnelVariantSummary group results per variant.
//
// Deliberately silent: analytics must never break or slow the public page, so the
// call is fire-and-forget and swallows every error. No-ops during SSR.
//
// DELIVERY IS NOT THIS FILE'S BUSINESS. It goes out through postJsonBeacon, the one
// transport every browser beacon in the platform uses. This module hand-rolled a
// keepalive fetch instead, and carried a named exemption in beacon-transport.test.ts
// arguing that it was "a smaller shape, not a copy" — a bare keepalive fetch with no
// sendBeacon in front of it. That was the wrong half to be missing. `cta_clicked`
// fires as the visitor is ALREADY NAVIGATING to the booking page, and sendBeacon is
// the API that survives that navigation; keepalive is the fallback for when it does
// not exist or refuses the payload. The shared transport does both, in that order,
// and swallows everything, so this file is strictly better delivered and now holds
// no transport of its own.

import { postJsonBeacon } from "@/lib/beacon-transport";

// 'viewed' and 'cta_clicked' feed the A/B counters; 'section_<name>' steps are
// per-section scroll-depth markers (the endpoint accepts arbitrary step strings,
// and the variant aggregation ignores steps it does not know).
export type LandingStep = "viewed" | "cta_clicked" | `section_${string}`;

export interface LandingEvent {
  clientSlug: string;
  landingSlug: string;
  variant: "a" | "b";
  step: LandingStep;
  sessionId: string;
}

const FUNNEL_EVENT_ENDPOINT = "/api/funnel-event";

/**
 * Record one landing-page event. Fire-and-forget: returns immediately, never
 * throws, and does nothing on failure or outside a browser. `variant` and
 * `landingSlug` are carried inside `meta` (as scalars) per the funnel-event
 * contract, inside the endpoint's batched `events` envelope.
 */
export function trackLandingEvent(event: LandingEvent): void {
  // SSR-INERT, and the guard stays here rather than moving into the transport: a
  // landing page is server-rendered, this runs during that render, and there is no
  // visitor to attribute an event to yet. (The transport is browser-safe either
  // way — it feature-detects — but "did this page get viewed?" is a question only
  // the browser can answer, so not asking it on the server is this file's rule.)
  if (typeof window === "undefined") return;
  try {
    // Serialised HERE, not by the transport: the funnel-event envelope is this
    // file's contract with that endpoint, and the transport takes a string exactly
    // so it never gets a say in what a body may contain.
    postJsonBeacon(
      FUNNEL_EVENT_ENDPOINT,
      JSON.stringify({
        clientSlug: event.clientSlug,
        surface: "landing",
        sessionId: event.sessionId,
        events: [
          {
            step: event.step,
            meta: { variant: event.variant, landingSlug: event.landingSlug },
          },
        ],
      }),
    );
  } catch {
    // Swallow synchronous throws (e.g. serialisation). The transport swallows
    // every delivery failure of its own; this catch covers the line above it.
  }
}

/** A lightweight, url-safe session id for correlating a visitor's landing events. */
export function newSessionId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
