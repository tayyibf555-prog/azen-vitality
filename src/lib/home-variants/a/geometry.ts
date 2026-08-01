// ---------------------------------------------------------------------------
// Variant A ("Quiet"): the arithmetic behind the appointments ring and the two
// places a share is printed as a percentage.
//
// It lives here rather than inline in the panel because a ring that draws its
// arcs from running totals is exactly the kind of thing that looks right and is
// wrong: one arc a fraction long and every arc after it is offset, which on this
// screen misstates how much of the day is finished.
//
// Pure functions: no React, no clock, no I/O.
// ---------------------------------------------------------------------------

export interface DonutSlice {
  key: string;
  value: number;
}

export interface DonutArc {
  key: string;
  /** Arc length along the circumference, in user units. */
  length: number;
  /** Where the arc starts, as a NEGATIVE stroke-dashoffset. */
  offset: number;
}

/**
 * Lay the slices out head to tail around the ring.
 *
 * Each arc begins where the ones before it ended, so the ring reads as one
 * continuous band rather than as overlapping rings. Anything that cannot be
 * drawn honestly draws as nothing: a non-positive total, a negative value, or a
 * set summing past the total all yield zero-length arcs rather than a ring that
 * wraps over itself and reports the wrong proportion.
 */
export function donutArcs(
  slices: readonly DonutSlice[],
  total: number,
  circumference: number,
): DonutArc[] {
  const drawable = Number.isFinite(total) && total > 0 && Number.isFinite(circumference) && circumference > 0;
  let cursor = 0;
  return slices.map((slice) => {
    if (!drawable || !Number.isFinite(slice.value) || slice.value <= 0) {
      return { key: slice.key, length: 0, offset: -cursor };
    }
    const raw = (slice.value / total) * circumference;
    // Never let the running total overrun the ring: a source that reports more
    // completed appointments than appointments would otherwise draw a full ring
    // plus a lap, which reads as a finished day.
    const length = Math.max(0, Math.min(raw, circumference - cursor));
    const arc = { key: slice.key, length, offset: -cursor };
    cursor += length;
    return arc;
  });
}

/**
 * A share of the total, as a whole percentage.
 *
 * Zero total is 0 rather than NaN, and a non-zero value never rounds down to a
 * bare 0: a single missed appointment out of four hundred is still a missed
 * appointment, and printing it as 0% next to the count reads as a defect.
 */
export function sharePercent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0 || value <= 0) return 0;
  const exact = (value / total) * 100;
  const rounded = Math.round(exact);
  return rounded === 0 ? 1 : Math.min(100, rounded);
}
