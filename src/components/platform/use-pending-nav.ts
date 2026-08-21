"use client";

import { usePathname } from "next/navigation";
import { useCallback, useState } from "react";
import { isPlainNavigationClick, pendingHrefFor } from "@/lib/nav-intent";

// ---------------------------------------------------------------------------
// THE OPTIMISTIC MARK, ONCE, FOR EVERY NAV SURFACE.
//
// Every authed page here is force-dynamic and this app may never have a
// loading.tsx (feb8677), so a click gets NOTHING back from the framework until
// the server answers: no skeleton, no route transition, no highlight move. The
// replacement is four lines of state that every nav surface has to run —
// remember the href the click is in flight to, derive it stale the moment the
// pathname moves, ignore modified clicks, and light the progress bar while it
// runs.
//
// Those four lines were hand-copied into the rail, the section bar and the
// patient tab strip, and the agency sidebar was about to become the fourth copy.
// Hand-copied optimistic state drifts in the direction that is invisible: drop
// the `isPlainNavigationClick` guard in ONE of them and a cmd-click leaves that
// surface permanently lying about which page is open, with no navigation left to
// clear it, and every screenshot still looks right. So the rule lives here once
// and the surfaces keep only what is genuinely theirs — which link is settled.
//
// WHAT STAYS IN @/lib/nav-intent AND WHY. The rules themselves are pure and are
// tested there in the node suite. This file is only the React glue over them; it
// exists because the glue is what was being copied, not the rules.
// ---------------------------------------------------------------------------

/**
 * The subset of a click the guard reads — taken straight from the rule itself so
 * the two can never disagree. Structural, so a React MouseEvent, a synthetic
 * event and a plain object in a test all satisfy it.
 */
type NavClickLike = Parameters<typeof isPlainNavigationClick>[0];

export interface PendingNav {
  /**
   * The href a click is currently in flight to, or null. Feed it to
   * `isActiveWithPending` for each link, and to `<NavProgressBar active={...} />`.
   */
  pendingHref: string | null;
  /**
   * A click handler for the link pointing at `href`.
   *
   * `onNavigate` is the surface's own side effect for a real navigation — the
   * mobile drawer closes itself here. It runs for every PLAIN click, including a
   * click on the page you are already on (the drawer must still close when you
   * tap the current page's link, because no pathname change will close it), and
   * never for a modified one.
   */
  markPending: (href: string, onNavigate?: () => void) => (e: NavClickLike) => void;
}

export function usePendingNav(): PendingNav {
  const pathname = usePathname();

  // The click's destination AND the pathname it was recorded on, so staleness is
  // DERIVED during render rather than cleared by an effect a frame later: the
  // record is spent on the very render that shows the new page, so there is no
  // window in which two links look active. See pendingHrefFor.
  const [pending, setPending] = useState<{ href: string; from: string } | null>(null);
  const pendingHref = pendingHrefFor(pending, pathname);

  const markPending = useCallback(
    (href: string, onNavigate?: () => void) => (e: NavClickLike) => {
      // Modified clicks (cmd/ctrl/shift/alt/middle) open somewhere else and leave
      // THIS page exactly where it is, so marking anything active for one would
      // move the highlight to a page nobody went to and nothing would move it back.
      if (!isPlainNavigationClick(e)) return;
      onNavigate?.();
      // Mark pending only when something will actually change: on the current
      // page nothing navigates, so nothing would ever clear the mark.
      if (href !== pathname) setPending({ href, from: pathname });
    },
    [pathname],
  );

  return { pendingHref, markPending };
}
