/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

// A small, dependency-free before/after image comparison slider, used in the dark
// "results" band of the bespoke hygiene landing page. A CLIENT island (it owns the
// split position and a pointer drag), rendered inside a white card.
//
// Layout is layout-shift free: the frame has a FIXED aspect ratio (623/400, the
// asset ratio), both images are absolutely positioned and object-fit:contain, and
// the AFTER image is the base layer. The BEFORE image sits on top, revealed from
// the left by a clip-path inset driven by `pos` (0 to 100, starting at 50).
//
// Accessibility: a full-size, visually hidden <input type="range"> carries the
// value for keyboard and assistive tech (arrow keys move the split, with a clear
// aria-label). It has pointer-events:none so it never eats the custom pointer drag;
// keyboard focus still reaches it, and the frame shows a focus ring via :focus-within.
// The pointer drag (pointerdown + pointermove, with pointer capture) is handled on
// the frame itself, so mouse and touch both work, full width, on mobile too.
//
// The images this renders are ILLUSTRATIONS, never real patient photos; the caller
// passes the verbatim caption that says so.

interface Props {
  beforeSrc: string;
  afterSrc: string;
  beforeAlt: string;
  afterAlt: string;
  beforeLabel?: string;
  afterLabel?: string;
  caption?: string;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

export function BeforeAfterSlider({
  beforeSrc,
  afterSrc,
  beforeAlt,
  afterAlt,
  beforeLabel = "Before",
  afterLabel = "After",
  caption,
}: Props) {
  const [pos, setPos] = useState(50);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const setFromClientX = useCallback((clientX: number) => {
    const el = frameRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    setPos(clamp(((clientX - rect.left) / rect.width) * 100));
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture is unavailable in some environments; drag still works.
      }
      setFromClientX(e.clientX);
    },
    [setFromClientX],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      setFromClientX(e.clientX);
    },
    [setFromClientX],
  );

  const endDrag = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return (
    <figure className="ba-slider">
      <div
        className="ba-frame"
        ref={frameRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
      >
        {/* AFTER is the base layer. */}
        <img className="ba-img ba-after" src={afterSrc} alt={afterAlt} draggable={false} />
        {/* BEFORE sits on top, revealed from the left by the clip inset. */}
        <img
          className="ba-img ba-before"
          src={beforeSrc}
          alt={beforeAlt}
          draggable={false}
          style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
        />

        <span className="ba-badge ba-badge-before" aria-hidden>
          {beforeLabel}
        </span>
        <span className="ba-badge ba-badge-after" aria-hidden>
          {afterLabel}
        </span>

        {/* Visible divider + circular handle at the split. */}
        <div className="ba-divider" style={{ left: `${pos}%` }} aria-hidden>
          <span className="ba-handle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 7l-4 5 4 5" />
              <path d="M15 7l4 5-4 5" />
            </svg>
          </span>
        </div>

        {/* Visually hidden range: keyboard + assistive tech. pointer-events:none so it
            never intercepts the custom pointer drag above. */}
        <input
          className="ba-range"
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(pos)}
          onChange={(e) => setPos(clamp(Number(e.target.value)))}
          aria-label="Drag to compare before and after"
        />
      </div>
      {caption ? <figcaption className="ba-cap">{caption}</figcaption> : null}
    </figure>
  );
}
