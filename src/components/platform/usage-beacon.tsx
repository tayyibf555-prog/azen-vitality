"use client";

import { useEffect, useRef } from "react";
import { useParams, usePathname } from "next/navigation";
import { postJsonBeacon } from "@/lib/beacon-transport";
import { surfaceFromPath } from "@/lib/telemetry-surface";

// Product-usage beacon, mounted ONCE in the authed client shell (c/[client]/layout,
// alongside FeedbackWidget). On every route change it records WHICH module surface
// the internal user landed on, so the owner can see what the team actually uses.
//
// Privacy: it sends only the module-family surface (surfaceFromPath collapses a
// record path like /c/vitality/patients/123 to "patients", so ids never leave the
// browser) and the client slug. The server derives WHO (email/role) from the
// verified session and re-sanitises the surface against the nav allowlist. No
// patient data is ever read or sent.
//
// Robustness: fire-and-forget through the shared browser transport
// (@/lib/beacon-transport — sendBeacon, with a keepalive-fetch fallback), and it
// de-dupes repeat views of the same surface within a short window, so flicking a
// tab back and forth is not double-counted. Telemetry must never break the app:
// every failure is swallowed there and it renders nothing.

const ENDPOINT = "/api/telemetry";
const DEDUPE_MS = 30_000;

export function UsageBeacon() {
  const params = useParams<{ client: string }>();
  const pathname = usePathname();
  const clientSlug = params?.client ?? "";
  // Per-surface last-sent timestamps, kept across route changes for this mount.
  const lastSent = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!clientSlug) return;
    const surface = surfaceFromPath(pathname);
    if (!surface) return;

    const now = Date.now();
    const key = `${clientSlug}:${surface}`;
    const prev = lastSent.current.get(key);
    if (prev && now - prev < DEDUPE_MS) return; // same surface seen moments ago
    lastSent.current.set(key, now);

    // WHAT is sent is this component's business; HOW it leaves the page is not,
    // and is shared with the public funnel beacons (@/lib/beacon-transport). Only
    // the mechanics are shared — the transport holds no state, so nothing about
    // this AUTHED user can end up alongside an anonymous visitor's session there.
    postJsonBeacon(ENDPOINT, JSON.stringify({ clientSlug, surface }));
  }, [clientSlug, pathname]);

  return null;
}
