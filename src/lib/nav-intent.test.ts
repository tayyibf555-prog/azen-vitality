import { describe, it, expect } from "vitest";
import {
  PREFETCH_INTENT_DELAY_MS,
  isActiveWithPending,
  isPlainNavigationClick,
  pendingHrefFor,
} from "./nav-intent";

// ===========================================================================
// The rules behind "the tabs feel instant". Three of them, and each one is a bug
// this app has actually had.
// ===========================================================================

describe("isPlainNavigationClick", () => {
  const plain = { button: 0 };

  it("accepts an unmodified left click", () => {
    expect(isPlainNavigationClick(plain)).toBe(true);
    expect(isPlainNavigationClick({})).toBe(true);
  });

  // EVERY ONE OF THESE LEAVES THE CURRENT PAGE WHERE IT IS. Marking the clicked
  // tab active for a cmd-click would move the highlight to a tab the reader never
  // went to, and because no navigation happens, nothing would ever move it back:
  // the strip would sit permanently lying about which section is open.
  it.each([
    ["cmd (new tab)", { ...plain, metaKey: true }],
    ["ctrl (new tab / context menu)", { ...plain, ctrlKey: true }],
    ["shift (new window)", { ...plain, shiftKey: true }],
    ["alt (download)", { ...plain, altKey: true }],
    ["middle button (new tab)", { button: 1 }],
    ["right button (context menu)", { button: 2 }],
  ])("rejects %s", (_label, event) => {
    expect(isPlainNavigationClick(event)).toBe(false);
  });
});

describe("pendingHrefFor", () => {
  it("is null when nothing is in flight", () => {
    expect(pendingHrefFor(null, "/c/v/patients/1")).toBeNull();
  });

  it("reports the clicked href while the pathname has not moved", () => {
    const pending = { href: "/c/v/patients/1/notes", from: "/c/v/patients/1" };
    expect(pendingHrefFor(pending, "/c/v/patients/1")).toBe("/c/v/patients/1/notes");
  });

  // THE SELF-CLEARING PROPERTY, and the reason this is derived during render
  // rather than cleared from an effect: the moment the router commits the new
  // pathname the mark is spent, on that very render. There is no frame in which
  // two tabs are active and no extra paint to schedule.
  it("goes stale on the same render that the pathname commits", () => {
    const pending = { href: "/c/v/patients/1/notes", from: "/c/v/patients/1" };
    expect(pendingHrefFor(pending, "/c/v/patients/1/notes")).toBeNull();
  });

  it("goes stale when the reader lands somewhere else entirely (a redirect)", () => {
    const pending = { href: "/c/v/patients/1/notes", from: "/c/v/patients/1" };
    expect(pendingHrefFor(pending, "/c/v/patients")).toBeNull();
  });

  it("is null with no pathname yet, rather than guessing", () => {
    const pending = { href: "/a", from: "/b" };
    expect(pendingHrefFor(pending, null)).toBeNull();
    expect(pendingHrefFor(pending, undefined)).toBeNull();
  });
});

describe("isActiveWithPending", () => {
  it("falls through to the surface's settled rule when nothing is in flight", () => {
    expect(isActiveWithPending("/a", null, true)).toBe(true);
    expect(isActiveWithPending("/a", null, false)).toBe(false);
  });

  // EXACTLY ONE tab is active during a click. The clicked one wins even though the
  // router still reports the old pathname, and — the half that is easy to miss —
  // the tab the reader is LEAVING must stop being active at the same instant, or
  // the strip briefly shows two open sections.
  it("moves the mark to the clicked tab and off the one being left", () => {
    const clicked = "/c/v/patients/1/notes";
    expect(isActiveWithPending(clicked, clicked, false)).toBe(true);
    expect(isActiveWithPending("/c/v/patients/1", clicked, true)).toBe(false);
  });
});

describe("PREFETCH_INTENT_DELAY_MS", () => {
  // A dwell that is too long buys the reader nothing (the prefetch starts after
  // they have already clicked); one that is zero turns a single mouse sweep across
  // an eleven-tab strip into eleven full dynamic server renders, which is the
  // over-eager-warming failure this codebase has already taken an outage for.
  it("sits between pass-through and a human hover-then-click", () => {
    expect(PREFETCH_INTENT_DELAY_MS).toBeGreaterThan(50);
    expect(PREFETCH_INTENT_DELAY_MS).toBeLessThan(200);
  });
});
