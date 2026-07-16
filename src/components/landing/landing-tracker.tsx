"use client";

import { useEffect, useRef, useState } from "react";
import { trackLandingEvent, newSessionId } from "@/lib/landing/track";
import type { VariantKey } from "@/lib/landing/winner";

// Client wrapper around the (server-rendered) landing content. It owns the two
// side effects the pure content renderer deliberately does not:
//   1. fires the 'viewed' event on mount and wires 'cta_clicked' on the CTA,
//   2. persists the sticky variant cookie when this was a fresh 50/50 assignment.
//
// Keeping these here (not in LandingContent) is what lets LandingContent stay a
// pure, function-prop-free component that renders on the server. All analytics go
// through the single seam helper (lib/landing/track.ts); this file has no other
// knowledge of the events endpoint.

interface Props {
  clientSlug: string;
  landingSlug: string;
  variant: VariantKey;
  /** Set the sticky cookie when this render freshly assigned the variant. */
  cookie?: { name: string; path: string } | null;
  children: React.ReactNode;
}

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function LandingTracker({ clientSlug, landingSlug, variant, cookie, children }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Stable per-mount session id via a lazy state initialiser (runs once).
  const [sessionId] = useState<string>(() => newSessionId());

  // Persist the sticky variant cookie on a fresh assignment. Not httpOnly by
  // design (a harmless bucket label), scoped to this page's path.
  useEffect(() => {
    if (!cookie) return;
    document.cookie = `${cookie.name}=${variant}; path=${cookie.path}; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
  }, [cookie, variant]);

  // Fire 'viewed' once on mount.
  useEffect(() => {
    trackLandingEvent({ clientSlug, landingSlug, variant, step: "viewed", sessionId });
  }, [clientSlug, landingSlug, variant, sessionId]);

  // Wire 'cta_clicked' on the tagged CTA link(s). Fire-and-forget; the navigation
  // proceeds normally (keepalive lets the beacon survive the page change).
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const onClick = () => {
      trackLandingEvent({ clientSlug, landingSlug, variant, step: "cta_clicked", sessionId });
    };
    const ctas = Array.from(root.querySelectorAll<HTMLElement>("[data-lp-cta]"));
    ctas.forEach((el) => el.addEventListener("click", onClick));
    return () => ctas.forEach((el) => el.removeEventListener("click", onClick));
  }, [clientSlug, landingSlug, variant, sessionId]);

  return <div ref={containerRef}>{children}</div>;
}
