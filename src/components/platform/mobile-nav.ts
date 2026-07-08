"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Shared open/close state for the mobile nav drawer. On phones/tablets the sidebar
 * is hidden off-canvas; the topbar hamburger fires the "azen:toggle-nav" window
 * event (see toggleMobileNav) and the sidebar consumes this to slide in and out.
 * Auto-closes after navigating (so tapping a link dismisses the drawer) and on
 * Escape. On desktop the sidebar is always shown, so this state is inert.
 */
export function useMobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close once the route changes: tapping a nav link should dismiss the drawer.
  useEffect(() => setOpen(false), [pathname]);

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

  return { open, setOpen };
}

/** Fire from the topbar hamburger to open/close the mobile nav drawer. */
export function toggleMobileNav() {
  window.dispatchEvent(new CustomEvent("azen:toggle-nav"));
}
