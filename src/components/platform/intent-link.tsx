"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PREFETCH_INTENT_DELAY_MS } from "@/lib/nav-intent";

/**
 * A <Link> that prefetches its DYNAMIC route once the reader shows intent.
 *
 * THE PROBLEM IT SOLVES, stated precisely because the default looks like it
 * already does this. Next 16 prefetches a link when it enters the viewport — but
 * only a STATIC route in full. For a dynamic route, `prefetch="auto"` (the
 * default) prefetches down to the nearest `loading.tsx`, and where there is no
 * loading.tsx it prefetches NOTHING. Every authed page here is force-dynamic and
 * this app has no loading.tsx anywhere on purpose (feb8677: a streamed one left
 * authed pages unhydrated and every button on them dead). So the entire nav —
 * the rail, the section bar, the patient record's eleven tabs — was doing a cold
 * server round trip on every single click, with no prefetch of any kind.
 *
 * `prefetch={true}` is the documented opt-in: it prefetches the full route for
 * dynamic routes too, and parks it in the `static` client-cache bucket (120s in
 * next.config.ts) rather than the 30s `dynamic` one.
 *
 * WHY IT IS ARMED RATHER THAN ALWAYS ON. `prefetch={true}` fires on viewport
 * entry, and a patient record paints eleven tabs at once: the reader who opens
 * one tab would silently commission eleven full dynamic renders — Dentally
 * reads, the cross-module task generator, the twelve correspondence stores. This
 * codebase has already taken a production outage from being over-eager about
 * warming Dentally, and the standing rule from it is that no work may be
 * amplified behind the user's back. Intent-armed prefetch is the opposite of a
 * background sweep: it is one route, chosen by the person, a fraction of a second
 * before they ask for it anyway.
 *
 * ARMING IS ONE-WAY AND PERMANENT for the life of the component. Disarming on
 * mouseleave would drop the prefetched entry and re-fetch it on the reader's
 * second pass, which is both slower and MORE server work than leaving it armed.
 */
export function IntentLink({
  href,
  children,
  ref,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onPointerDown,
  onTouchStart,
  ...rest
}: Omit<React.ComponentProps<typeof Link>, "prefetch">) {
  const [armed, setArmed] = useState(false);
  // A ref, not state: the timer must be clearable from a handler that runs before
  // React commits anything, and re-rendering on "a hover started" would repaint
  // the whole strip on every pointer crossing for no visible change.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // A strip that unmounts mid-hover (navigating away, a drawer closing) must not
  // leave a timer that arms a link nobody is looking at any more.
  useEffect(() => cancel, [cancel]);

  // Deliberate hover: arm only after the pointer RESTS. Crossing this link on the
  // way to another one clears the timer on the way out and costs nothing.
  const startDwell = useCallback(() => {
    if (armed || timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setArmed(true);
    }, PREFETCH_INTENT_DELAY_MS);
  }, [armed]);

  // Focus, press and touch are UNAMBIGUOUS intent, so they skip the dwell
  // entirely. pointerdown in particular is the last chance to be useful: it still
  // lands a few tens of milliseconds ahead of the click, and it is the only signal
  // a reader who clicks straight through without pausing ever gives.
  const armNow = useCallback(() => {
    cancel();
    setArmed(true);
  }, [cancel]);

  return (
    <Link
      href={href}
      ref={ref}
      // false until armed, then the FULL dynamic prefetch. Flipping the prop is
      // the pattern the Next docs themselves use for hover-prefetching; the only
      // difference here is `true` rather than `null`, because `null` means "auto"
      // and auto is exactly the mode that does nothing for these routes.
      prefetch={armed ? true : false}
      onMouseEnter={(e) => {
        startDwell();
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        cancel();
        onMouseLeave?.(e);
      }}
      onFocus={(e) => {
        armNow();
        onFocus?.(e);
      }}
      onPointerDown={(e) => {
        armNow();
        onPointerDown?.(e);
      }}
      onTouchStart={(e) => {
        armNow();
        onTouchStart?.(e);
      }}
      {...rest}
    >
      {children}
    </Link>
  );
}
