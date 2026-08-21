// HOW a fire-and-forget browser beacon actually leaves the page. Nothing about
// WHAT is sent, or about who is allowed to send it, lives here.
//
// ============================================================================
// TWO CALLERS, AND THEY MUST NOT SHARE ANYTHING ELSE. step-beacon.ts posts
// ANONYMOUS step rows under a nonce the browser minted; funnel-progress-beacon.ts
// posts a NAMED LEAD's position under a token the server minted. Keeping those two
// apart is a privacy property (see supabase/migrations/0094 and the note at the
// top of funnel-progress-beacon.ts), so what is shared here is deliberately the
// dumbest possible thing: a string, an endpoint, and the delivery mechanics.
//
// This module holds no state, mints nothing, and has no idea which caller it is
// serving. It cannot become the place a nonce and a token meet.
// ============================================================================
//
// WHY IT IS SHARED AT ALL. The mechanics are fiddly and were copied line for line
// between the two beacons: sendBeacon first because it survives the page being
// navigated away — which is exactly when the LAST screen of a session happens, the
// one both features care about most — then a keepalive fetch when sendBeacon is
// absent, refuses the payload (it returns false past the browser's queue budget)
// or throws behind a blocking extension. A fix to one copy was a fix to one half
// of the telemetry.
//
// BROWSER-ONLY, AND IMPORTS NOTHING. Both callers are pulled into a "use client"
// quiz, and both are pinned to a graph with no server in it; a single import here
// would widen both graphs at once. Zero imports is the cheapest way to keep that
// impossible, and beacon-transport.test.ts pins it.
//
// EVERY PATH IS SWALLOWED. Telemetry must never throw into a render or a click
// handler, so there is no error to report and nothing useful to return: the
// caller cannot know whether a beacon arrived, and must not behave as if it could.

/**
 * Post a JSON string to a same-origin endpoint, best effort, never throwing.
 *
 * `payload` is already-serialised JSON rather than an object on purpose: the two
 * callers each own their body shape and their own validation of it, and neither
 * wants this module deciding what a body may contain.
 */
export function postJsonBeacon(endpoint: string, payload: string): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // sendBeacon survives the page being navigated away, which is exactly when
      // the last thing a session did — the thing that matters most — happens.
      const blob = new Blob([payload], { type: "application/json" });
      // It returns false when the browser refuses to queue the payload; that is a
      // "not sent", so fall through rather than reporting a delivery that is not one.
      if (navigator.sendBeacon(endpoint, blob)) return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    void fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      // keepalive, or the request is cancelled by the very navigation this exists
      // to outlive.
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Give up silently: telemetry must never surface an error.
  }
}
