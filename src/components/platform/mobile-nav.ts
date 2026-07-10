"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Shared open/close state for the mobile nav drawer. On phones/tablets the sidebar
 * is hidden off-canvas; the topbar hamburger fires the "azen:toggle-nav" window
 * event (see toggleMobileNav) and the sidebar consumes this to slide in and out.
 * Auto-closes after navigating (so tapping a link dismisses the drawer) and on
 * Escape. On desktop the sidebar is always shown, so this state is inert.
 *
 * Accessibility: while CLOSED on mobile the off-canvas drawer must not be
 * keyboard/screen-reader reachable (`hiddenFromA11y` drives inert/aria-hidden),
 * and while OPEN on mobile the page behind must not scroll.
 */
export function useMobileNav() {
  const [open, setOpen] = useState(false);
  // SSR default TRUE: desktop never hides the sidebar, so first paint carries no
  // inert/aria-hidden and hydration matches; mobile corrects after mount.
  const [isDesktop, setIsDesktop] = useState(true);
  const pathname = usePathname();

  // Close once the route changes: tapping a nav link should dismiss the drawer.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Body scroll lock while the drawer is open on mobile.
  useEffect(() => {
    if (open && !isDesktop) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open, isDesktop]);

  useEffect(() => {
    const toggle = () => setOpen((v) => !v);
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("azen:toggle-nav", toggle);
    window.addEventListener("azen:close-nav", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("azen:toggle-nav", toggle);
      window.removeEventListener("azen:close-nav", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return { open, setOpen, hiddenFromA11y: !open && !isDesktop };
}

/** Fire from the topbar hamburger to open/close the mobile nav drawer. */
export function toggleMobileNav() {
  window.dispatchEvent(new CustomEvent("azen:toggle-nav"));
}
