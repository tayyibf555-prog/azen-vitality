// THE BROWSER HALF: the visitor's decision, and the only three things that are
// allowed to happen because of it.
//
// ============================================================================
// EVERY ACT THIS FEATURE PERFORMS IN A BROWSER IS IN THIS FILE. There are four
// of them and they are all here, in one place, so that "what does the assessment
// page do to my device?" is a question with a short and checkable answer:
//
//   1. READ our own consent key from localStorage. (Every render.)
//   2. WRITE it. (Only ever inside a click handler, never on render — pinned.)
//   3. INSERT Meta's <script> tag. (Only ever after a grant.)
//   4. CALL fbq('track','Lead'). (Only ever after a grant, and only if 3 ran.)
//
// It sets no cookie of any kind. `document.cookie` does not appear in this file,
// and meta-pixel.test.ts asserts that it does not appear anywhere in the feature.
// The only cookies a consenting visitor ends up with are Meta's own, set by Meta's
// own script — which is precisely what the prompt asks about.
//
// BROWSER-ONLY, WITH NO SERVER IMPORTS, exactly like step-beacon.ts: every entry
// point guards on `typeof window` and returns an inert answer on the server, so
// this is safe to pull into a "use client" component, and safe to import from a
// module the submit path also touches.
//
// NOTHING HERE THROWS. localStorage throws outright in Safari's private mode and
// under some enterprise policies; `fbq` may be missing, blocked, or replaced by an
// extension. A tracking preference is not worth an exception inside a patient's
// click handler, so every path is wrapped and every failure degrades to "no
// consent recorded, no pixel", which is the direction that cannot leak.
// ============================================================================

import {
  META_CONSENT_STORAGE_KEY,
  consentGrantsPixel,
  metaPixelScript,
  parseConsentDecision,
  type MetaConsentDecision,
  type MetaConsentSnapshot,
} from "./meta-pixel";

/**
 * `fbq` as Meta's loader defines it: a queue-backed function that takes a command
 * and some arguments. Declared here rather than as an ambient global so the only
 * file that can reach for it is this one.
 */
type Fbq = (...args: unknown[]) => void;

interface PixelWindow extends Window {
  fbq?: Fbq;
}

/** The marker attribute that makes injection idempotent. */
const SCRIPT_MARKER = "data-meta-pixel";

/* ---------------------------------------------------------------------------
 * 1. Reading and writing the decision.
 * ------------------------------------------------------------------------- */

/**
 * What this device's visitor has already said, or null for "not asked yet".
 *
 * A READ, NOT A WRITE, and that distinction is the reason this can run before any
 * consent exists: looking at a preference the visitor themselves set, in order to
 * honour it, is the storage access every consent implementation has to make.
 * Nothing is created by calling this — including on the very first visit, where
 * the answer is null and the key still does not exist afterwards.
 */
export function readMetaConsent(): MetaConsentDecision | null {
  if (typeof window === "undefined") return null;
  try {
    return parseConsentDecision(window.localStorage.getItem(META_CONSENT_STORAGE_KEY));
  } catch {
    // No storage available (private mode, blocked cookies/storage, an enterprise
    // policy). "Not decided" is the honest answer, and it means the prompt shows
    // again rather than a pixel loading on a device we cannot record a refusal on.
    return null;
  }
}

/**
 * Record what the visitor just chose.
 *
 * THE ONE WRITE IN THE FEATURE, and the whole reason it is a named function
 * rather than an inline setItem: meta-pixel-wiring.test.ts asserts that the only
 * caller is a click handler in the prompt component. A grant and a refusal are
 * both stored, because a refusal that is forgotten is a refusal that gets asked
 * again on the next page — which is nagging, not consent.
 */
export function recordMetaConsent(decision: MetaConsentDecision): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(META_CONSENT_STORAGE_KEY, decision);
  } catch {
    // Unable to persist it. Silent by design: a storage warning helps nobody
    // filling in a dental questionnaire, and the pixel simply does not load.
  }
  // Tell every mounted prompt to look again. OUTSIDE the try, so a browser that
  // cannot persist the decision still takes the banner off the screen rather than
  // leaving the visitor clicking a button that appears to do nothing.
  notifyConsentChanged();
}

/* ---------------------------------------------------------------------------
 * 1b. The decision as an EXTERNAL STORE, which is what it actually is.
 * ------------------------------------------------------------------------- */

/**
 * localStorage is state that lives outside React, is written from a click handler,
 * and has no value at all during server rendering. React has one primitive for
 * exactly that shape — `useSyncExternalStore` — and these three functions are its
 * three arguments.
 *
 * THE ALTERNATIVE, AND WHY IT IS WORSE. The obvious implementation is
 * `useState(null)` plus a mount effect that reads storage and calls setState. It
 * works, and it is a cascading render on every public assessment page: React
 * renders, commits, runs the effect, sets state and renders again, all to discover
 * a value that was available synchronously the whole time. The lint rule that
 * flags it is right.
 */
const consentListeners = new Set<() => void>();

/** Subscribe to changes. Returns the unsubscribe React will call on unmount. */
export function subscribeMetaConsent(listener: () => void): () => void {
  consentListeners.add(listener);
  return () => {
    consentListeners.delete(listener);
  };
}

function notifyConsentChanged(): void {
  // A copy, so a listener that unsubscribes itself mid-notify cannot skip the
  // next one; and each call is isolated, because one broken subscriber must not
  // stop the others being told.
  for (const listener of [...consentListeners]) {
    try {
      listener();
    } catch {
      /* a subscriber that throws is its own problem */
    }
  }
}

/**
 * What the BROWSER renders from.
 *
 * DELIBERATELY UNCACHED. `getSnapshot` runs on every render and React requires the
 * result to be stable when nothing has changed — which a primitive string is, by
 * value, for free. A cache here would buy one synchronous map lookup and cost the
 * one thing that must never go stale: a decision taken in another tab, or cleared
 * by a visitor emptying their site data.
 *
 * "undecided" and not null: see MetaConsentSnapshot. The distinction between "we
 * looked and there is nothing" and "we have not looked" is what keeps the banner
 * off a returning visitor's screen.
 */
export function metaConsentSnapshot(): MetaConsentSnapshot {
  return readMetaConsent() ?? "undecided";
}

/**
 * What the SERVER renders from: "unknown", always.
 *
 * There is no device to ask, so there is no honest answer other than "we have not
 * looked" — and because `shouldAskConsent` draws the banner only for "undecided",
 * the consequence is that the prompt is never in the server's HTML. Which is
 * exactly right: it is a question about this browser, and only this browser can
 * say whether it has already been answered.
 */
export function metaConsentServerSnapshot(): MetaConsentSnapshot {
  return "unknown";
}

/** Did this device's visitor say yes? The predicate the submit path sends. */
export function metaConsentGranted(): boolean {
  return consentGrantsPixel(readMetaConsent());
}

/* ---------------------------------------------------------------------------
 * 2. Loading the pixel.
 * ------------------------------------------------------------------------- */

/**
 * Insert Meta's base code and fire its PageView. Returns true if it inserted.
 *
 * WHY THE SCRIPT IS BUILT HERE, IN AN EFFECT, AND NOT RENDERED.
 *
 * The obvious implementation is a <script dangerouslySetInnerHTML> in the
 * component's JSX, or next/script. Both put `connect.facebook.net` into the HTML
 * the server sends — for every visitor, before anybody has clicked anything, and
 * regardless of what the component does with it afterwards. React would then
 * "hydrate" a decision that had already been taken by the parser.
 *
 * Building the element imperatively, after a grant, means the page's markup has
 * no reference to any Meta domain in it at all until the moment consent exists.
 * That is a property that can be asserted on the rendered bytes rather than
 * argued about, and meta-pixel.test.ts asserts it.
 *
 * IDEMPOTENT, because React effects re-run: a marker attribute makes a second
 * call a no-op rather than a second copy of fbq (which would double every event).
 */
export function injectMetaPixel(pixelId: string): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  try {
    if (document.querySelector(`script[${SCRIPT_MARKER}]`)) return false;
    const code = metaPixelScript(pixelId);
    // The grammar gate, one last time. A pixel id that is not digits produces no
    // snippet, and no snippet produces no script tag.
    if (!code) return false;
    const script = document.createElement("script");
    script.setAttribute(SCRIPT_MARKER, "");
    script.type = "text/javascript";
    script.text = code;
    document.head.appendChild(script);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * 3. The conversion.
 * ------------------------------------------------------------------------- */

/**
 * A per-submission event id, shared with the server-side event so Meta counts one
 * conversion rather than two.
 *
 * The same construction as the step beacon's nonce, and for the same reason: it
 * needs to be unlikely to collide, not unguessable. It identifies nobody, is
 * never persisted, and lives for the length of one submit.
 */
export function newMetaEventId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The two fields a quiz adds to its submit body.
 *
 * ONE FUNCTION RATHER THAN TWO PROPERTIES, so the three quiz components cannot
 * drift: each spreads this into its body and passes the returned id to
 * `trackMetaLead` afterwards. `metaConsent` is what unlocks hashed matching keys
 * on the server — the server never infers consent from anything else, and never
 * defaults it to true.
 */
export function metaSubmitFields(): { metaConsent: boolean; metaEventId: string } {
  return { metaConsent: metaConsentGranted(), metaEventId: newMetaEventId() };
}

/**
 * Tell the pixel a submission happened.
 *
 * THE CONSENT CHECK IS REPEATED HERE and is not redundant: this runs seconds after
 * the page loaded, in a different handler, and a visitor may have declined in
 * between (or `fbq` may be present because some other script defined it). Asking
 * again costs one localStorage read and removes the possibility of a conversion
 * event on a device that never agreed to one.
 *
 * A missing `fbq` is the normal case, not an error: no consent, an ad blocker, or
 * a network that never delivered fbevents.js. There is nothing to report and
 * nothing to retry — the server-side event is the fallback, and it is the reason
 * this one is allowed to be best-effort.
 */
export function trackMetaLead(eventId?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (!metaConsentGranted()) return;
    const fbq = (window as PixelWindow).fbq;
    if (typeof fbq !== "function") return;
    // Meta's shape: (command, event, custom data, options). The custom data is
    // deliberately empty — no value, no currency, no treatment, no score. The
    // options carry the shared id and nothing else.
    fbq("track", "Lead", {}, eventId ? { eventID: eventId } : undefined);
  } catch {
    // Never let tracking throw into a submit handler.
  }
}
