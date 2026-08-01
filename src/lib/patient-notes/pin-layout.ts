/**
 * How the pinned-notes band behaves as the count grows.
 *
 * PURE. No I/O, no DOM, no React. The band's whole degradation story lives here so it
 * can be tested at the counts that matter rather than discovered on a real patient.
 *
 * WHY THIS EXISTS AT ALL. Dentally's band is the right shape and is kept: coloured
 * cards along the top of the record, present on every tab. The reference screenshot
 * looks messy because that particular patient carries five pinned notes at once, and
 * because nothing in it degrades: ten notes simply push the record off the screen.
 * Ten is the case worth designing for, so it is the case with an explicit rule.
 *
 * THE RULES, and each one is a test below:
 *   0        no band at all. Not an empty shell, not a heading: the record starts at
 *            the tab strip. This is the commonest case and it must cost nothing.
 *   1        one full-width card, body clamped to 3 lines.
 *   2 to 3   one row of equal columns, 3 lines each.
 *   4 to 6   the same grid wraps to a second row and the clamp drops to 2 lines, so
 *            two rows cost roughly what one and a half did.
 *   7+       two rows only (six cards), the remainder behind one "N more pinned
 *            notes" control that expands the band IN PLACE. Collapsed is the default
 *            on every record open.
 *
 * ORDER is pinned_at descending, always, so what someone just pinned is never the one
 * hidden behind "N more". That is the property most likely to be lost in a refactor,
 * so it is asserted directly rather than left to the caller.
 *
 * The 40%-of-viewport ceiling is NOT here: it is a CSS max-height on the band, because
 * it depends on the viewport rather than on the count.
 */

/** Two rows of three. Above this a collapsed band shows a "N more" control instead. */
const COLLAPSED_MAX = 6;

/**
 * Server-enforced ceiling on pinned notes per patient. Without it the ten case simply
 * becomes the fifty case and no layout rule survives.
 */
export const MAX_PINNED_PER_PATIENT = 12;

export interface PinnedBandPlan {
  /** How many cards are rendered right now. */
  visible: number;
  /** How many sit behind the "N more pinned notes" control. */
  hidden: number;
  /** Body clamp. Drops to 2 as soon as the band needs a second row. */
  clampLines: 2 | 3;
  /** Column count at the record's full width. The grid still stacks on narrow screens. */
  columns: 1 | 2 | 3;
}

export function planPinnedBand(count: number, opts: { expanded: boolean }): PinnedBandPlan {
  // A negative or non-finite count is treated as none: a band is never rendered on a
  // number nobody can explain.
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;

  if (n === 0) return { visible: 0, hidden: 0, clampLines: 3, columns: 1 };
  if (n === 1) return { visible: 1, hidden: 0, clampLines: 3, columns: 1 };
  if (n <= 3) return { visible: n, hidden: 0, clampLines: 3, columns: n === 2 ? 2 : 3 };
  if (n <= COLLAPSED_MAX) return { visible: n, hidden: 0, clampLines: 2, columns: 3 };

  if (opts.expanded) return { visible: n, hidden: 0, clampLines: 2, columns: 3 };
  return { visible: COLLAPSED_MAX, hidden: n - COLLAPSED_MAX, clampLines: 2, columns: 3 };
}

/**
 * Newest pin first. Rows with no pinned_at sort last (they are not pinned at all and
 * should never have reached the band), and an unparseable timestamp is treated as the
 * oldest rather than throwing.
 */
export function orderPinned<T extends { pinnedAt: string | null }>(notes: readonly T[]): T[] {
  const at = (n: T): number => {
    if (!n.pinnedAt) return Number.NEGATIVE_INFINITY;
    const t = new Date(n.pinnedAt).getTime();
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return [...notes].sort((a, b) => at(b) - at(a));
}

export interface PinnedBandSplit<T> {
  shown: T[];
  rest: T[];
  plan: PinnedBandPlan;
}

/**
 * Order, then split into what the band renders and what sits behind "N more".
 *
 * The component calls this and nothing else, so the ordering rule and the volume rule
 * cannot be applied in the wrong sequence: sorting AFTER slicing would hide a note
 * somebody pinned ten seconds ago, which is the one outcome the band must never have.
 */
export function splitPinnedBand<T extends { pinnedAt: string | null }>(
  notes: readonly T[],
  opts: { expanded: boolean },
): PinnedBandSplit<T> {
  const ordered = orderPinned(notes);
  const plan = planPinnedBand(ordered.length, opts);
  return { shown: ordered.slice(0, plan.visible), rest: ordered.slice(plan.visible), plan };
}

/** "3 more pinned notes" / "1 more pinned note". */
export function moreLabel(hidden: number): string {
  return `${hidden} more pinned ${hidden === 1 ? "note" : "notes"}`;
}
