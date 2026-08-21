"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { IntentLink } from "@/components/platform/intent-link";
import { NavProgressBar } from "@/components/platform/nav-progress";
import { usePendingNav } from "@/components/platform/use-pending-nav";
import { isActiveWithPending } from "@/lib/nav-intent";
import { PATIENT_TABS, patientTabHref } from "@/lib/patient/tabs";
import { cn } from "@/lib/utils";

/**
 * The record's eleven tabs, in Dentally's order.
 *
 * A horizontal UNDERLINE strip, which is Dentally's own convention and is
 * deliberately distinct from the segmented pills this app uses for filters: a
 * Dentally user should read this as "sections of this record", not as "a filter on
 * one list". Copying the convention is the whole point of the exercise.
 *
 * Every tab is a real link to its own URL, so browser Back works between tabs,
 * a tab can be bookmarked, and cmd-click opens it in a new tab.
 *
 * ALL ELEVEN ARE ALWAYS SHOWN, and none of them is marked. Hiding a tab reads to a
 * Dentally user as a lost capability; marking four of eleven is the amber-chip
 * failure PRODUCT.md names. Each panel states what it can and cannot do once you
 * are in it.
 *
 * WHY THE TABS FELT SLOW, and it was not the panels. Each tab is its own URL under
 * a shared layout, which is the right shape — the layout is preserved, so switching
 * tabs re-renders only the panel. But every one of these routes is force-dynamic,
 * and Next 16 does not prefetch a dynamic route at all unless there is a
 * `loading.tsx` to prefetch down to. There is none here and there must never be
 * one (feb8677), so the default `prefetch="auto"` on these links was prefetching
 * NOTHING: every tab click was a cold round trip, and the strip sat frozen with the
 * old tab still highlighted until the server answered.
 *
 * Two changes, and they fix different halves of "slow":
 *
 *   1. IntentLink arms `prefetch={true}` — the full dynamic prefetch — once the
 *      reader hovers, focuses or presses a tab. The panel is usually already in the
 *      client cache by the time the click lands, and staleTimes.static keeps it
 *      there for two minutes, so going back to a tab is free.
 *   2. The clicked tab is marked active ON THE CLICK, before the server has said
 *      anything, and the progress bar runs while the panel is in flight. Even on a
 *      cold click the interface answers immediately instead of appearing to hang.
 */
export function PatientTabStrip({ basePath }: { basePath: string }) {
  const pathname = usePathname();
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  // The tab a click is currently in flight to. The hook records the pathname it
  // was clicked from, so staleness is DERIVED during render rather than cleared by
  // an effect a frame later, and it ignores modified clicks. See usePendingNav.
  const { pendingHref, markPending } = usePendingNav();

  // On a narrow viewport the strip scrolls; bring the active tab into view so the
  // reader is never looking at a strip whose selected item is off-screen. Keyed on
  // the OPTIMISTIC target too, so the strip scrolls to the tab on the click rather
  // than a round trip later.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname, pendingHref]);

  return (
    <>
      {/* Nothing to draw until a navigation is actually in flight, and its own
          150ms animation delay means a prefetched (instant) switch never flashes
          it. It is fixed-position, so it costs no layout. */}
      <NavProgressBar active={pendingHref !== null} />
      <nav aria-label="Patient record sections" className="border-b border-line">
        <ul className="-mb-px flex gap-0.5 overflow-x-auto">
          {PATIENT_TABS.map((tab) => {
            const href = patientTabHref(basePath, tab.slug);
            // Details lives at the record root, so its settled rule is a match on
            // basePath rather than on a tab segment.
            const settled = tab.slug === "details" ? pathname === basePath : pathname === href;
            const active = isActiveWithPending(href, pendingHref, settled);
            return (
              <li key={tab.slug} className="shrink-0">
                <IntentLink
                  ref={active ? activeRef : undefined}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  // Modified clicks open elsewhere and leave this page where it is;
                  // the hook's guard drops them, because marking a tab active for
                  // one would move the highlight to a tab nobody navigated to, with
                  // nothing to move it back.
                  onClick={markPending(href)}
                  className={cn(
                    "inline-block border-b-2 px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                    active
                      ? "border-navy font-semibold text-navy"
                      : "border-transparent text-muted hover:border-line-strong hover:text-navy",
                  )}
                >
                  {tab.label}
                </IntentLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
