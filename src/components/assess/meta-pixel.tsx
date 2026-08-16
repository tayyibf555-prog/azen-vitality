"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  injectMetaPixel,
  metaConsentServerSnapshot,
  metaConsentSnapshot,
  recordMetaConsent,
  subscribeMetaConsent,
} from "@/lib/assess/meta-pixel-consent";
import { shouldAskConsent } from "@/lib/assess/meta-pixel";

/**
 * THE CONSENT PROMPT AND THE PIXEL, on the public assessment pages.
 *
 * ============================================================================
 * THE FOUR PROPERTIES THIS COMPONENT EXISTS TO HOLD.
 *
 * 1. NO CONFIGURATION, NO ANYTHING. `pixelId` null returns null before a single
 *    hook does any work: no banner, no storage read, no listener, no bytes. A
 *    practice that does not run ads must not have its patients asked about
 *    cookies that were never going to be set — the commonest dark pattern on the
 *    web is a consent banner for tracking a site does not do.
 *
 * 2. THE MARKUP NEVER MENTIONS META UNTIL SOMEBODY SAYS YES. The snippet is not
 *    rendered; it is inserted imperatively by `injectMetaPixel`, in an effect,
 *    after a grant. So the HTML the server sends contains no reference to any
 *    Facebook domain, for any visitor, ever — which is a claim that can be
 *    asserted on the bytes (meta-pixel.test.ts renders this component and looks).
 *    A <script> in the JSX, or next/script, would have put it in the page for
 *    everyone and left React to "hydrate" a decision the parser already took.
 *
 * 3. THE PROMPT WRITES NOTHING. It is on screen because no decision exists, and
 *    it reads storage once to find that out. `recordMetaConsent` is called from
 *    the two click handlers and from nowhere else, so nothing at all is stored on
 *    a device whose visitor has not chosen — including a device that simply
 *    scrolls past it.
 *
 * 4. THE QUIZ IS UNAFFECTED EITHER WAY. This renders beside the quiz, not around
 *    it; it holds no state the quiz reads; declining changes nothing about what a
 *    patient can do, see, or submit. That is not politeness, it is what makes the
 *    consent freely given rather than a toll gate.
 * ============================================================================
 *
 * WHY THE DECISION IS AN EXTERNAL STORE AND NOT COMPONENT STATE. It lives in
 * localStorage, which does not exist during server rendering — so the server
 * cannot know whether to draw the prompt, and must draw nothing. The usual way to
 * express that is `useState(null)` plus a mount effect that reads storage and
 * calls setState, which is a cascading render on every public assessment page and
 * a lint error besides. `useSyncExternalStore` says the same thing in the shape
 * React actually has for it: `metaConsentServerSnapshot` answers "unknown" (so
 * the banner is not in the server's HTML, and a visitor who declined last week
 * never sees a frame of it), `metaConsentSnapshot` answers what this browser
 * knows, and `subscribeMetaConsent` is how a click re-renders every mounted copy.
 */
export function MetaPixel({ pixelId }: { pixelId: string | null }) {
  const snapshot = useSyncExternalStore(
    subscribeMetaConsent,
    metaConsentSnapshot,
    metaConsentServerSnapshot,
  );

  // Load the pixel — and ONLY on a grant. Both halves of the condition are
  // load-bearing and neither is implied by the other: `pixelId` is the practice's
  // decision, `snapshot === "granted"` is this visitor's.
  useEffect(() => {
    if (!pixelId) return;
    if (snapshot !== "granted") return;
    injectMetaPixel(pixelId);
  }, [pixelId, snapshot]);

  // Nothing configured: this component is not on this page in any meaningful
  // sense. Checked after the hooks so their order is stable across renders, and
  // before anything is drawn.
  if (!pixelId) return null;
  if (!shouldAskConsent(pixelId, snapshot)) return null;

  return (
    <MetaConsentPrompt
      // The ONE write in the feature, in the two places a visitor can ask for it.
      // Both outcomes are recorded: a refusal that is forgotten on the next page
      // view is not a refusal, it is a nag.
      onAccept={() => recordMetaConsent("granted")}
      onDecline={() => recordMetaConsent("denied")}
    />
  );
}

/**
 * The banner itself: presentational, and deliberately separated from every
 * decision above.
 *
 * TWO REASONS IT IS ITS OWN EXPORT. It can be rendered in a test without
 * localStorage, an effect or a mock — so the words a patient reads, and the
 * absence of any Meta domain among them, are asserted on real output. And it
 * cannot accidentally acquire a storage call: it has no access to one.
 *
 * THE TWO BUTTONS ARE EQUALLY PROMINENT, and that is a compliance property rather
 * than a taste one. A refusal that is a grey link under a bright "Accept all" is
 * not a freely given choice, and the ICO says so in as many words. Same size, same
 * weight, same shape; the accept is filled only because one of them has to carry
 * the page's accent and the alternative is two identical buttons nobody can tell
 * apart.
 *
 * THE COPY NAMES THE COMPANY, THE PURPOSE AND THE MECHANISM — "Meta (Facebook and
 * Instagram)", "which of our adverts brought you here", "sets cookies" — because
 * consent to an unnamed third party for an unstated purpose is not consent. It
 * also says, in the same breath, that the assessment is identical either way, so
 * that nobody clicks yes believing it is the price of the questionnaire.
 */
export function MetaConsentPrompt({
  onAccept,
  onDecline,
}: {
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Cookie choice"
      className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-3"
    >
      <div className="w-full max-w-2xl rounded-xl border border-line-strong bg-card p-4 shadow-lg">
        <p className="text-[13px] font-semibold text-navy">Measuring our adverts</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
          We&apos;d like to use Meta&apos;s measurement tools (Facebook and Instagram) to understand
          which of our adverts brought you here. Doing that sets cookies on your device. Your
          assessment works exactly the same either way, and you can say no.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onAccept}
            className="pressable inline-flex items-center justify-center rounded-lg bg-blue-dark px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          >
            Yes, that&apos;s fine
          </button>
          <button
            type="button"
            onClick={onDecline}
            className="pressable inline-flex items-center justify-center rounded-lg border border-line-strong bg-card px-4 py-2 text-[13px] font-semibold text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          >
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
