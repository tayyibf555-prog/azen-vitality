// WCAG CONTRAST, computed — and the pair tables that say which pairs on a Smile
// Assessment palette have to clear which ratio.
//
// WHY THIS IS A MODULE AND NOT A TEST HELPER ANY MORE.
//
// These four functions were written inside palette.test.ts, where they gated the
// SEVEN authored palettes: a build-time bar on colours a developer had chosen and
// a reviewer had read. Custom themes move the same decision to run time — an owner
// picks eighteen colours in a browser and the server has to answer "is this
// readable" before it stores them, on the same evidence.
//
// Two copies of a contrast function is the worst possible arrangement of that: the
// presets would be held to one bar and the owner's own theme to another, and the
// day they drifted is the day a practice ships a funnel that is measurably less
// legible than every scheme the product offers — while the suite that exists to
// prevent exactly that stays green. So the maths and the thresholds live here, and
// palette.test.ts imports them. One bar, two callers.
//
// PURE. No React, no server imports, no I/O — the same boundary palette.ts keeps,
// because this is imported by a test, an API route and a server component alike.

import { PALETTE_TOKENS, type PaletteToken } from "./palette";

/* ---------------------------------------------------------------------------
 * 1. Reading a colour.
 * ------------------------------------------------------------------------- */

/** #rgb, #rrggbb, #rrggbbaa. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** rgb(r,g,b) / rgba(r,g,b,a) with plain integer channels and a 0-1 alpha. */
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;

/**
 * The three sRGB channels of a colour, 0..1 — or null if the string is not one of
 * the two literal forms this product allows.
 *
 * ALPHA IS DROPPED, NOT COMPOSITED, and that is a deliberate limitation rather
 * than an oversight. A translucent foreground's real contrast depends on what is
 * behind it, which a token map does not know; guessing a backdrop would produce a
 * confident number that is wrong. So the tokens that are actually MEASURED are
 * required to be opaque (see CONTRAST_TOKENS below and the theme validator that
 * enforces it), and everything else — a glow, a tint — may carry alpha freely
 * because nothing reads text off it.
 */
export function colourChannels(value: string): [number, number, number] | null {
  const s = value.trim();
  if (HEX.test(s)) {
    const body = s.slice(1);
    const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  if (RGB.test(s)) {
    const parts = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")).split(",");
    const channels = parts.slice(0, 3).map((p) => Number(p.trim()));
    // rgb(300,0,0) is not a colour this product will store: the grammar allows up
    // to three digits, so the range check belongs here rather than in the regex.
    if (channels.some((c) => !Number.isFinite(c) || c < 0 || c > 255)) return null;
    return channels.map((c) => c / 255) as [number, number, number];
  }
  return null;
}

/** Does this colour carry an alpha channel? (#rrggbbaa or rgba(...,a)) */
export function hasAlphaChannel(value: string): boolean {
  const s = value.trim();
  if (HEX.test(s)) return s.length === 9;
  if (RGB.test(s)) return s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")).split(",").length === 4;
  return false;
}

/** Is this string one of the two literal colour forms? */
export function isColourLiteral(value: unknown): value is string {
  return typeof value === "string" && colourChannels(value) !== null;
}

/* ---------------------------------------------------------------------------
 * 2. The maths.
 * ------------------------------------------------------------------------- */

/** WCAG 2.x relative luminance. NaN for a string that is not a colour. */
export function relativeLuminance(value: string): number {
  const channels = colourChannels(value);
  if (!channels) return Number.NaN;
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The WCAG contrast ratio between two colours, 1..21.
 *
 * FAIL-CLOSED ON JUNK: a string that is not a colour scores 0, which is below
 * every threshold in this file. The one caller that can be handed junk is the
 * custom-theme validator, and there the honest answer to "how readable is
 * `url(evil)` on white" is "not enough to store", never "21".
 */
export function contrast(a: string, b: string): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  if (!Number.isFinite(la) || !Number.isFinite(lb)) return 0;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------------------------------------------------------------------
 * 3. The bar.
 * ------------------------------------------------------------------------- */

/** foreground token, background token, the ratio that pair must clear. */
export type ContrastPair = readonly [PaletteToken, PaletteToken, number];

/**
 * Small-text pairs EVERY scheme — shipped or bold — must clear WCAG AA (4.5:1).
 * These are the pairs the shipped default already clears, so no scheme is exempt.
 */
export const AA_SMALL_TEXT_PAIRS: readonly ContrastPair[] = [
  ["ink", "card", 4.5], // body copy on the question card
  ["muted", "card", 4.5], // helper lines under a question
  ["navy", "card", 4.5], // the question itself
  ["navy", "cream", 4.5], // headings that sit on the page, not the card
  ["blue-deep", "card", 4.5], // the small blue eyebrow
  ["blue-royal", "card", 4.5], // the lead brand colour as small text
  ["card", "blue-dark", 4.5], // the label ON the filled primary button
  ["on-navy-muted", "navy", 4.5], // Guided's secondary copy, on its dark gradient
];

/**
 * THE LOAD-BEARING GUARD — the WCAG floor that keeps "bold" from becoming
 * "unreadable" on a patient-facing funnel. A bold scheme's --card is a TINTED
 * surface (not white) and its --card-muted is a deeper tint, which pressures
 * exactly the two pairs the shipped design already dips below AA on. So the bold
 * schemes — the ones the catalogue authors and can tune — must clear these on
 * their own tinted surfaces:
 *
 *   --ink on --card             >= 4.5   body copy
 *   --muted on --card           >= 4.5   secondary copy
 *   --muted on --card-muted     >= 4.5   secondary copy on the inset surface
 *   --faint on --card           >= 3.0   meta text (footnotes, helper lines)
 *   --blue-deep on --card       >= 4.5   the small-text blue
 *   --navy on --card            >= 4.5   headings on the card
 *
 * A tinted --card-muted is the pressure point; the thresholds are not relaxed to
 * fit a swatch, the palette is tuned until it passes with headroom.
 */
export const BOLD_TINT_PAIRS: readonly ContrastPair[] = [
  ["ink", "card", 4.5],
  ["muted", "card", 4.5],
  ["muted", "card-muted", 4.5],
  ["faint", "card", 3.0],
  ["blue-deep", "card", 4.5],
  ["navy", "card", 4.5],
];

/**
 * THE BAR A CUSTOM THEME IS HELD TO: both tables, deduplicated, keeping the
 * STRICTER threshold wherever a pair appears in each.
 *
 * Not one table or the other, because each on its own leaves a real hole. The AA
 * table alone never looks at `--card-muted`, so an owner could put 3:1 grey on the
 * inset surface every input and progress track uses. The bold table alone never
 * looks at `--blue-dark`, so an owner could pick a pale action colour and make the
 * label on the primary button — the one control the whole funnel turns on —
 * invisible. Together they are exactly what the five bold presets already clear,
 * which is the promise this feature makes: your own theme is held to the same bar
 * as the ones we ship, not a softer one written to let it through.
 */
export const CUSTOM_THEME_PAIRS: readonly ContrastPair[] = mergePairs(
  AA_SMALL_TEXT_PAIRS,
  BOLD_TINT_PAIRS,
);

/**
 * Merge threshold tables, keeping the STRICTER bar wherever a pair is in both.
 *
 * EXPORTED ONLY SO THE RULE CAN BE PROVED. Every pair the two tables currently
 * share happens to carry the same 4.5, so the "stricter wins" line is unobservable
 * from the merged output as it stands today — a mutation flipping it to "weaker
 * wins" changes nothing, and a suite that could not tell would be guarding a rule
 * that quietly stops being true the first time somebody adds a pair at 3.0 to one
 * table and 4.5 to the other. contrast.test.ts calls this directly with a
 * conflicting pair, which is the only way to hold it.
 */
export function mergePairs(...tables: (readonly ContrastPair[])[]): readonly ContrastPair[] {
  const byPair = new Map<string, ContrastPair>();
  for (const table of tables) {
    for (const pair of table) {
      const key = `${pair[0]}|${pair[1]}`;
      const seen = byPair.get(key);
      // The stricter bar wins: a pair listed at 4.5 in one table and 3.0 in the
      // other is a 4.5 pair, or the merge would quietly relax a threshold.
      if (!seen || pair[2] > seen[2]) byPair.set(key, pair);
    }
  }
  return [...byPair.values()];
}

/**
 * The tokens whose contrast is actually MEASURED, derived from the table above
 * rather than listed by hand.
 *
 * Its one job: these are the tokens a custom theme may not make translucent. An
 * `--ink` of `rgba(0,0,0,0.05)` parses, passes the grammar, and scores a perfect
 * ratio on the channels alone while rendering as nothing at all — the single way
 * a colour-shaped value can defeat a contrast gate.
 */
export const CONTRAST_TOKENS: readonly PaletteToken[] = PALETTE_TOKENS.filter((token) =>
  CUSTOM_THEME_PAIRS.some(([fg, bg]) => fg === token || bg === token),
);

/* ---------------------------------------------------------------------------
 * 4. Judging a whole token map.
 * ------------------------------------------------------------------------- */

export interface ContrastFailure {
  fg: PaletteToken;
  bg: PaletteToken;
  /** What the pair actually scores, to two decimals when described. */
  ratio: number;
  /** What it had to score. */
  min: number;
}

/**
 * Every pair in `pairs` that this token map fails. ALL of them, not the first:
 * an owner adjusting a palette needs the whole list, the way flow-validate hands
 * back every broken rule at once rather than one per save.
 */
export function contrastFailures(
  vars: Partial<Record<PaletteToken, string>>,
  pairs: readonly ContrastPair[] = CUSTOM_THEME_PAIRS,
): ContrastFailure[] {
  const out: ContrastFailure[] = [];
  for (const [fg, bg, min] of pairs) {
    const a = vars[fg];
    const b = vars[bg];
    // A missing token is a DIFFERENT failure, reported by the validator that owns
    // completeness. Scoring it 0 here would bury "you left out --ink" under six
    // contrast failures that are all the same fact.
    if (typeof a !== "string" || typeof b !== "string") continue;
    const ratio = contrast(a, b);
    if (ratio < min) out.push({ fg, bg, ratio, min });
  }
  return out;
}

/** One failure as a sentence naming the pair, for an API error an owner reads. */
export function describeContrastFailure(failure: ContrastFailure): string {
  return `--${failure.fg} on --${failure.bg} is ${failure.ratio.toFixed(2)}:1, below the ${failure.min}:1 minimum`;
}
