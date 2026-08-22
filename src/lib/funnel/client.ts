// Client-side funnel tracker for the public funnels (smile-assessment quiz +
// booking page). Fire-and-forget by design: it batches PII-free step events and
// flushes them to POST /api/funnel-event through the shared browser transport
// (@/lib/beacon-transport), so a flush survives the page being navigated away and
// NEVER blocks or breaks the UI. Every path is wrapped so telemetry can never
// throw into a render or a click handler — this runs on an UNAUTHENTICATED page,
// in front of a patient, where an exception is a broken quiz.
//
// This is a browser-only module (guards on typeof window) with NO server imports:
// the transport is its only import and imports nothing itself (pinned by
// beacon-transport.test.ts), so it is safe to pull into a "use client" component.
// Emit only non-PII scalars in meta (e.g. a question index) — never names, contact
// details or answers.

import { postJsonBeacon } from "@/lib/beacon-transport";

type FunnelSurface = "assessment" | "booking";
type FunnelMeta = Record<string, string | number | boolean>;

interface QueuedEvent {
  step: string;
  meta?: FunnelMeta;
}

export interface FunnelTracker {
  /** Queue a step (debounced-flushed). No-op on the server or on any failure. */
  track(step: string, meta?: FunnelMeta): void;
  /** Force any queued events out now (e.g. just before a full-page navigation). */
  flush(): void;
}

const ENDPOINT = "/api/funnel-event";
const FLUSH_DEBOUNCE_MS = 1200;
const MAX_QUEUE = 20;

/** A short random session id, with a non-crypto fallback for older browsers. */
function newSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createFunnelTracker(opts: {
  surface: FunnelSurface;
  clientSlug: string;
  campaignSlug?: string;
}): FunnelTracker {
  // On the server (SSR) return an inert tracker: nothing to send, nothing to break.
  if (typeof window === "undefined") {
    return { track: () => {}, flush: () => {} };
  }

  const sessionId = newSessionId();
  let queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function send(events: QueuedEvent[]): void {
    if (events.length === 0) return;
    // WHAT is sent is this module's business; HOW it leaves the page is not, and
    // is shared with every other browser beacon (@/lib/beacon-transport). Only the
    // mechanics are shared: this session id is minted here and goes nowhere else,
    // and the transport keeps nothing between calls that could tie an anonymous
    // visitor's batch to anyone else's.
    postJsonBeacon(
      ENDPOINT,
      JSON.stringify({
        clientSlug: opts.clientSlug,
        surface: opts.surface,
        sessionId,
        campaignSlug: opts.campaignSlug,
        events,
      }),
    );
  }

  function flush(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    send(batch);
  }

  function track(step: string, meta?: FunnelMeta): void {
    try {
      if (!step) return;
      queue.push(meta ? { step, meta } : { step });
      // Cap the buffer: flush immediately if it fills, else debounce.
      if (queue.length >= MAX_QUEUE) {
        flush();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
    } catch {
      // Never let tracking throw into a handler.
    }
  }

  // Flush on the page going away so the last steps (where drop-off happens) are
  // not lost. pagehide + visibilitychange:hidden are the reliable mobile signals;
  // beforeunload is unreliable on mobile Safari and omitted deliberately.
  try {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  } catch {
    // Listener registration failing must not break the tracker.
  }

  return { track, flush };
}
