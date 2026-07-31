// Axis arithmetic for the dashboard's bar chart.
//
// Kept here rather than inline in the panel because a chart axis is exactly the
// kind of thing that looks right and is wrong: an axis maximum below the tallest
// bar silently clips it, and a bar drawn against the wrong denominator
// misrepresents money on the screen a practice manager reads takings from.
//
// Everything is in PENCE, as the rest of the dashboard is, and only the tick
// LABELS are abbreviated.

/** A "nice" step: 1, 2, 2.5 or 5 times a power of ten. Anything else produces
 *  axis labels nobody reads at a glance (3,700 / 7,400 / 11,100). */
const STEP_MULTIPLES = [1, 2, 2.5, 5, 10];

export interface Axis {
  /** The top of the axis, in pence. Always >= the largest value. */
  max: number;
  /** The gap between ticks, in pence. */
  step: number;
  /** Every tick from 0 to max inclusive, in pence. */
  ticks: number[];
}

/**
 * An axis that comfortably contains `maxValue`, with roughly `targetTicks`
 * intervals landing on round numbers.
 *
 * The maximum is always rounded UP to a whole step, never down, so the tallest
 * bar can never exceed the axis and be clipped. A zero or negative maximum still
 * returns a usable axis rather than dividing by zero later.
 */
export function niceAxis(maxValue: number, targetTicks = 5): Axis {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { max: 100, step: 20, ticks: [0, 20, 40, 60, 80, 100] };
  }

  const rough = maxValue / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  // The first nice step at or above the rough one. The final entry is 10x the
  // magnitude, so a step is always found and the loop cannot fall through.
  const step = (STEP_MULTIPLES.find((m) => m * magnitude >= rough) ?? 10) * magnitude;

  const max = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  // Build by multiplication rather than by repeated addition: 2.5-style steps
  // accumulate floating point error otherwise, and the top tick then misses max
  // by a fraction of a penny and renders as "9,999.99...".
  const count = Math.round(max / step);
  for (let i = 0; i <= count; i += 1) ticks.push(Math.round(i * step));

  return { max: Math.round(max), step, ticks };
}

/**
 * A short axis tick label, in pounds, the way Dentally prints them: "0", "2k",
 * "10k". Abbreviated because an axis is scanned, not read, and six full
 * currency strings down the side of a small chart is noise.
 *
 * Only whole thousands abbreviate. 2,500 would become "2.5k" rather than a
 * misleading "2k" or "3k".
 */
export function axisTickLabel(pence: number): string {
  const pounds = pence / 100;
  if (pounds === 0) return "0";
  if (Math.abs(pounds) < 1000) return String(Math.round(pounds));
  const thousands = pounds / 1000;
  // One decimal only when it says something; 2.0k is just noise for 2k.
  const rounded = Math.round(thousands * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}k`;
}

/**
 * A bar's height as a 0..1 fraction of the axis.
 *
 * Clamped at both ends: a negative value (a credit note larger than the period's
 * billing) draws as nothing rather than as an upside-down bar, and nothing can
 * exceed the axis even if a caller passes a stale maximum.
 */
export function barFraction(pence: number, axisMax: number): number {
  if (!Number.isFinite(pence) || !Number.isFinite(axisMax) || axisMax <= 0) return 0;
  return Math.max(0, Math.min(1, pence / axisMax));
}
