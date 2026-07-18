"use client";

import { useEffect, useRef } from "react";
import { useParams, usePathname } from "next/navigation";
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
// Robustness: fire-and-forget via sendBeacon (keepalive-fetch fallback), and it
// de-dupes repeat views of the same surface within a short window, so flicking a
// tab back and forth is not double-counted. Telemetry must never break the app:
// every failure is swallowed and it renders nothing.

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

    const payload = JSON.stringify({ clientSlug, surface });
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch {
      // fall through to fetch
    }
    try {
      void fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Give up silently: telemetry must never surface an error.
    }
  }, [clientSlug, pathname]);

  return null;
}
