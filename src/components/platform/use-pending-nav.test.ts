import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";

// ===========================================================================
// THE OPTIMISTIC MARK, TESTED AS BEHAVIOUR RATHER THAN AS SOURCE.
//
// usePendingNav is the one piece of the "instant navigation" wiring that four
// surfaces share — the rail, the section bar, the patient tab strip and the
// agency sidebar. Each of them used to carry its own hand-copied version, and
// the thing that made that dangerous is that every way of getting it wrong is
// INVISIBLE: drop the modified-click guard and a cmd-click leaves the surface
// permanently highlighting a page the reader never opened, with no navigation
// left to clear it, and the screenshot still looks perfect.
//
// So the guard is pinned by exercising it, not by grepping for it.
//
// HOW A HOOK IS OBSERVED IN A NODE-ONLY SUITE. There is no DOM here (vitest runs
// `environment: "node"` and collects only src/-star-star/*.test.ts), so no event
// can be dispatched and no client render can be committed. What CAN be done is a
// static render: the probe below calls the handler DURING its first render pass,
// which is a same-component render-phase update — react-dom/server re-runs the
// component with the new state, so the second pass observes exactly what the
// click produced. The markup is the readout.
// ===========================================================================

const nav = vi.hoisted(() => ({ pathname: "/agency" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

import { usePendingNav } from "./use-pending-nav";

type Click = {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

const PLAIN: Click = { button: 0 };

/**
 * Fire one click at `href` through the hook and report what it left behind:
 * the pendingHref after the click, and whether the surface's own side effect ran.
 */
function clickThrough(href: string, click: Click) {
  const seen: (string | null)[] = [];
  let sideEffects = 0;

  function Probe() {
    const { pendingHref, markPending } = usePendingNav();
    seen.push(pendingHref);
    // Once, on the first pass. A render-phase update re-runs this component; a
    // second click here would be a loop.
    if (seen.length === 1) markPending(href, () => void sideEffects++)(click);
    return createElement("i", null, pendingHref ?? "none");
  }

  const markup = renderToStaticMarkup(createElement(Probe));
  return { markup, sideEffects, pendingHref: seen[seen.length - 1] ?? null, passes: seen.length };
}

describe("usePendingNav", () => {
  it("starts with nothing in flight", () => {
    nav.pathname = "/agency";
    function Probe() {
      const { pendingHref } = usePendingNav();
      return createElement("i", null, pendingHref ?? "none");
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<i>none</i>");
  });

  // THE WHOLE POINT: the clicked link is marked on the SAME frame as the click,
  // long before the force-dynamic route answers.
  it("marks the clicked href pending on a plain left click", () => {
    nav.pathname = "/agency";
    const result = clickThrough("/agency/feedback", PLAIN);
    expect(result.pendingHref).toBe("/agency/feedback");
    expect(result.markup).toBe("<i>/agency/feedback</i>");
    expect(result.sideEffects).toBe(1);
  });

  // EVERY ONE OF THESE LEAVES THE CURRENT PAGE WHERE IT IS, so recording a
  // pending href for one would strand the highlight on a page nobody opened.
  // Breaking the guard in usePendingNav turns these red and nothing else.
  it.each([
    ["cmd (new tab)", { ...PLAIN, metaKey: true }],
    ["ctrl (new tab / context menu)", { ...PLAIN, ctrlKey: true }],
    ["shift (new window)", { ...PLAIN, shiftKey: true }],
    ["alt (download)", { ...PLAIN, altKey: true }],
    ["middle button (new tab)", { button: 1 }],
    ["right button (context menu)", { button: 2 }],
  ])("ignores a %s click entirely", (_label, click) => {
    nav.pathname = "/agency";
    const result = clickThrough("/agency/feedback", click);
    expect(result.pendingHref).toBeNull();
    expect(result.markup).toBe("<i>none</i>");
    // The surface's own side effect is part of "navigating", so it must not run
    // either: the mobile drawer closing under a cmd-click would hide the nav for
    // a navigation that happened in another tab.
    expect(result.sideEffects).toBe(0);
  });

  // Clicking the page you are already on navigates nowhere, so nothing would ever
  // clear a mark recorded for it — but the drawer must still close, which is the
  // only reason the side effect is separate from the mark at all.
  it("records nothing for the page already open, but still runs the side effect", () => {
    nav.pathname = "/agency";
    const result = clickThrough("/agency", PLAIN);
    expect(result.pendingHref).toBeNull();
    expect(result.markup).toBe("<i>none</i>");
    expect(result.sideEffects).toBe(1);
  });
});
