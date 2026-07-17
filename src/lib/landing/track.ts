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
// call is fire-and-forget, uses keepalive (so a click that navigates away still
// sends), and swallows every error. No-ops during SSR or when fetch is absent.

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
  if (typeof window === "undefined" || typeof fetch === "undefined") return;
  try {
    void fetch(FUNNEL_EVENT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
      keepalive: true,
    }).catch(() => {
      // Swallow: analytics is best-effort and must never surface to the visitor.
    });
  } catch {
    // Swallow synchronous throws (e.g. serialisation) too.
  }
}

/** A lightweight, url-safe session id for correlating a visitor's landing events. */
export function newSessionId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
