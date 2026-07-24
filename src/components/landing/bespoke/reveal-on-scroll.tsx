"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Scroll-reveal + sticky-header controller for the bespoke .vd-landing pages. A tiny
// CLIENT island, mounted ONCE inside a .vd-landing root (it locates the root from its
// own inert anchor). No animation libraries: it only toggles classes that the scoped
// stylesheet animates with CSS transitions.
//
// On mount it:
//   1. Marks the root with `vd-js` so the reveal CSS engages. The stylesheet hides
//      [data-reveal] content ONLY under `.vd-landing.vd-js`, so without JS (SSR / no-JS)
//      the class is never added and every section stays fully visible — the no-JS guard.
//      Under prefers-reduced-motion it also skips marking, so nothing is ever hidden and
//      there is no motion.
//   2. Observes each [data-reveal] section via IntersectionObserver and adds `is-revealed`
//      once, as it scrolls into view. Sections already on screen at load are revealed
//      immediately so above-the-fold content never flickers.
//   3. Toggles `is-stuck` on the sticky <header> past a small scroll threshold (the CSS
//      compacts + deepens the header shadow).
//
// It renders any `children` (used by the unit test) plus the inert anchor; in production
// it is mounted childless as a pure controller.
export function RevealOnScroll({ children }: { children?: ReactNode }) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const root = anchorRef.current?.closest<HTMLElement>(".vd-landing") ?? null;
    if (!root) return;

    const prefersReduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Sticky-header compaction. Kept even under reduced motion (it is a layout
    // affordance, not decorative motion; the reduced-motion CSS makes it instant).
    const header = root.querySelector<HTMLElement>("header");
    const onScroll = () => {
      if (header) header.classList.toggle("is-stuck", window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    let observer: IntersectionObserver | null = null;

    // Reveal is opt-in on JS + motion. Under reduced motion nothing is ever hidden.
    if (!prefersReduced) {
      root.classList.add("vd-js");
      const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));

      if (typeof IntersectionObserver === "function") {
        observer = new IntersectionObserver(
          (entries, obs) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                entry.target.classList.add("is-revealed");
                obs.unobserve(entry.target);
              }
            }
          },
          { rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
        );
        const viewportH = window.innerHeight || document.documentElement.clientHeight;
        for (const el of targets) {
          const rect = el.getBoundingClientRect();
          // Already on screen → reveal now (prevents an above-the-fold flash);
          // otherwise wait for it to scroll into view.
          if (rect.top < viewportH && rect.bottom > 0) el.classList.add("is-revealed");
          else observer.observe(el);
        }
      } else {
        for (const el of targets) el.classList.add("is-revealed");
      }
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, []);

  return (
    <>
      {children}
      <span ref={anchorRef} data-vd-reveal-anchor hidden aria-hidden="true" />
    </>
  );
}
