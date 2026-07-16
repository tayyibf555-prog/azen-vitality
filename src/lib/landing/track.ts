// Landing-page client-side event tracker.
//
// !!! INTEGRATION SEAM !!!
// A PARALLEL workstream owns the events endpoint (/api/funnel-event) and its exact
// request/response contract. This file is the SINGLE place that knows the endpoint
// shape: it POSTs { surface: "landing", ..., meta: { variant, ... } } fire-and-
// forget. Fable 5 will reconcile the precise field names at integration; keep ALL
// endpoint knowledge HERE so that reconciliation is a one-file change.
//
// Contract chosen here (best-effort, to be confirmed):
//   POST /api/funnel-event
//   body: { surface: "landing", clientSlug, landingSlug, step, sessionId,
//           meta: { variant } }
//
// Deliberately silent: analytics must never break or slow the public page, so the
// call is fire-and-forget, uses keepalive (so a click that navigates away still
// sends), and swallows every error. No-ops during SSR or when fetch is absent.

export type LandingStep = "viewed" | "cta_clicked";

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
 * throws, and does nothing on failure or outside a browser. `variant` is carried
 * inside `meta` per the agreed surface contract.
 */
export function trackLandingEvent(event: LandingEvent): void {
  if (typeof window === "undefined" || typeof fetch === "undefined") return;
  try {
    void fetch(FUNNEL_EVENT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "landing",
        clientSlug: event.clientSlug,
        landingSlug: event.landingSlug,
        step: event.step,
        sessionId: event.sessionId,
        meta: { variant: event.variant },
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
