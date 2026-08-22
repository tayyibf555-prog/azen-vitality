// HOW a fire-and-forget browser beacon actually leaves the page. Nothing about
// WHAT is sent, or about who is allowed to send it, lives here.
//
// ============================================================================
// FOUR CALLERS, AND THEY MUST NOT SHARE ANYTHING ELSE.
//
//   step-beacon.ts            ANONYMOUS step rows, under a nonce the BROWSER minted
//   funnel-progress-beacon.ts a NAMED LEAD's position, under a token the SERVER minted
//   funnel/client.ts          ANONYMOUS public-funnel steps, under a session id the
//                             browser minted, from an unauthenticated page
//   components/platform/usage-beacon.tsx  which module surface an AUTHED INTERNAL
//                             user opened; the server derives WHO from the session
//
// Keeping those apart is a privacy property (see supabase/migrations/0094 and the
// note at the top of funnel-progress-beacon.ts), so what is shared here is
// deliberately the dumbest possible thing: a string, an endpoint, and the delivery
// mechanics. A patient's anonymous quiz session and a staff member's authed page
// view now go out through the same function, which is only tolerable because that
// function cannot remember either of them.
//
// This module holds no state, mints nothing, and has no idea which caller it is
// serving. It cannot become the place a nonce and a token meet.
// ============================================================================
//
// WHY IT IS SHARED AT ALL. The mechanics are fiddly and were copied line for line
// into every one of those files: sendBeacon first because it survives the page being
// navigated away — which is exactly when the LAST screen of a session happens, the
// one every one of these features cares about most — then a keepalive fetch when
// sendBeacon is absent, refuses the payload (it returns false past the browser's
// queue budget) or throws behind a blocking extension. Four copies meant a fix to
// delivery landed in a quarter of the telemetry.
//
// WHY IT LIVES AT src/lib AND NOT UNDER A FEATURE. Half its callers are not
// smile-assessment: the public funnel tracker serves the booking page too, and the
// usage beacon belongs to the authed shell. A feature-named home would have the
// platform shell importing @/lib/smile-assessment/* for its own telemetry, and
// invited that feature's other modules into the shell's graph behind it.
//
// BROWSER-ONLY, AND IMPORTS NOTHING. Every caller is pulled into a "use client"
// component, and each is pinned to a graph with no server in it; a single import
// here would widen all of those graphs at once. Zero imports is the cheapest way to
// keep that impossible, and beacon-transport.test.ts pins it.
//
// EVERY PATH IS SWALLOWED. Telemetry must never throw into a render or a click
// handler, so there is no error to report and nothing useful to return: the
// caller cannot know whether a beacon arrived, and must not behave as if it could.

/**
 * Post a JSON string to a same-origin endpoint, best effort, never throwing.
 *
 * `payload` is already-serialised JSON rather than an object on purpose: each
 * caller owns its body shape and its own validation of it, and none of them wants
 * this module deciding what a body may contain.
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
