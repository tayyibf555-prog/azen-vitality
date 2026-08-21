/**
 * THE RULES BEHIND INTENT-DRIVEN PREFETCH AND OPTIMISTIC TAB HIGHLIGHTING.
 *
 * PURE. No I/O, no React, no DOM. Tested — which is the whole reason it is here
 * rather than inline in three .tsx files that vitest cannot collect (the suite is
 * node-only and takes `src/**\/*.test.ts`, so logic buried in a component is logic
 * nobody can pin).
 *
 * WHY ANY OF THIS EXISTS. Every authed page in this app is `force-dynamic`, and
 * Next 16 does NOT prefetch a dynamic route: with `prefetch` left at its default
 * ("auto"), a dynamic route is prefetched only down to the nearest `loading.tsx`
 * boundary, and this app deliberately has none anywhere (a streamed loading.tsx
 * once left every button on an authed page dead — commit feb8677 — and it must
 * never come back). No boundary means the prefetch is skipped ENTIRELY, so every
 * tab click was a cold server round trip and the strip sat frozen until it landed.
 *
 * `prefetch={true}` is the documented escape: "the full route will be prefetched
 * for both static and dynamic routes". It also promotes the entry to the `static`
 * client-cache bucket (staleTimes.static, 120s here) instead of `dynamic` (30s).
 *
 * WHY NOT SIMPLY PREFETCH EVERY TAB ON SIGHT. `prefetch={true}` on a viewport-
 * visible link fires as soon as the strip paints, and the patient record's strip
 * carries ELEVEN tabs — eleven full dynamic renders (Dentally reads, the task
 * generator, the twelve correspondence stores) for a reader who will open one.
 * This codebase has already caused a real production outage by being over-eager
 * about warming Dentally, and the lesson written down from it is that amplifying
 * work behind the user's back is worse than being slow. So prefetch is armed by
 * INTENT — a deliberate hover, a focus, a press — and never by mere presence.
 */

/**
 * How long the pointer must REST on a link before its route is prefetched.
 *
 * A horizontal tab strip is crossed constantly: reaching the eleventh tab drags
 * the cursor over ten others, and arming on the first mouseenter would turn one
 * intended navigation into eleven server renders. A short dwell separates
 * "travelling over" (tens of milliseconds per tab) from "looking at this one".
 *
 * 90ms is chosen to sit well below the human hover-then-click dwell (typically
 * 300ms and up, since the click still has to be aimed and pressed) while sitting
 * well above pass-through. So a genuine hover still buys most of the round trip,
 * and a sweep across the strip buys nothing and costs nothing.
 */
export const PREFETCH_INTENT_DELAY_MS = 90;

/**
 * Whether a click should be treated as "this app is navigating now" — the signal
 * for the optimistic highlight and the progress bar.
 *
 * FALSE for every modified click, and that is the point rather than a nicety:
 * cmd/ctrl-click, shift-click, middle-click and alt-click all open or download
 * somewhere else and leave the CURRENT page exactly where it is. Marking the
 * clicked tab active for one of those would move the highlight to a tab the
 * reader never went to, and nothing would ever move it back, because no
 * navigation happens here to clear it.
 */
export function isPlainNavigationClick(e: {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  if ((e.button ?? 0) !== 0) return false;
  return !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * The optimistic destination of an in-flight click, or null.
 *
 * DERIVED DURING RENDER from the pathname the click was recorded on, rather than
 * cleared by an effect a frame later. Once `pathname` has moved, the record is
 * self-evidently spent and this returns null on the very same render that shows
 * the new page — so there is no window in which two tabs look active, and no
 * set-state-in-an-effect to schedule an extra paint.
 *
 * It also self-heals on the failure case that matters: if the navigation never
 * completes (a 404, a redirect back, a dropped response), `pathname` never moves,
 * the mark stays on the tab the reader asked for, and the progress bar keeps
 * running — which is honest. Clicking anything else replaces the record.
 */
export function pendingHrefFor(
  pending: { href: string; from: string } | null,
  pathname: string | null | undefined,
): string | null {
  if (!pending || !pathname) return null;
  return pending.from === pathname ? pending.href : null;
}

/**
 * Is this link the selected one, taking an in-flight click into account?
 *
 * While a click is in flight EXACTLY ONE tab is active — the clicked one — even
 * though the router still reports the old pathname. That is the whole of the
 * "instant" feeling: the strip answers the click on the same frame it happens,
 * and the server response, when it lands, agrees with what is already drawn.
 *
 * `matches` is the surface's own settled rule (an exact pathname match for the
 * patient tabs, a prefix match for the section bar, whose modules have nested
 * pages beneath them), so this can serve both without knowing either.
 */
export function isActiveWithPending(
  href: string,
  pendingHref: string | null,
  matches: boolean,
): boolean {
  if (pendingHref !== null) return pendingHref === href;
  return matches;
}
