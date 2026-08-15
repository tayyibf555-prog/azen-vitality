// COLOUR SCHEMES for the public Smile Assessment funnel — the catalogue, and the
// one function that turns a chosen scheme into something a wrapper element can
// wear.
//
// WHY THIS IS A DATA FILE AND NOT A STYLESHEET, AND WHY NO COMPONENT CHANGES.
//
// globals.css declares the brand as RAW custom properties on :root (--navy,
// --card, --blue-royal ...) and then maps them into Tailwind with `@theme inline`
// (globals.css:89). `inline` is the whole trick: it compiles `text-navy` to
// `color: var(--navy)` — the raw token, not a frozen copy of its value. So
// re-declaring those same raw tokens on ANY wrapper element re-themes every
// utility class beneath it, without a single className changing anywhere.
//
// That is why this module is a map of token -> colour and nothing else: the quiz
// components (assessment-quiz, deterministic-assessment-quiz, guided-assessment-
// quiz) are not touched by theming at all, and cannot be broken by it. The two
// exceptions are documented at ASSESS_GLOW below.
//
// PURE. No React, no server imports, no I/O — the flow-layout.ts boundary. It is
// imported by a server page, a client panel and an API route, so it must be
// importable by all three.
//
// COLOUR ONLY. Nothing here changes a single word a patient reads, so none of
// this goes near flow-copy.ts's write-time scan or the NHS/private ban.

/**
 * The tokens a scheme is allowed to set. This list is CLOSED on purpose: every
 * palette must supply every token, so there is no such thing as a half-themed
 * screen where a re-tinted card still carries the old blue button.
 *
 * These are exactly the globals.css raw token names (minus the leading `--`),
 * because that is what makes the re-declaration work. The set is the tokens the
 * public /assess surface actually renders — audited from the utilities used
 * across the three quiz components — plus `assess-glow`.
 *
 * DELIBERATELY ABSENT: --success, --warning, --danger. Those are semantic, not
 * brand. Green means "saved", red means "that did not work", and a palette that
 * re-tints them to fit its hue has not restyled a message, it has changed what
 * the message says.
 */
export const PALETTE_TOKENS = [
  // Surfaces, back to front.
  "cream", // the page behind everything
  "card", // the card the questions sit on
  "card-muted", // inset surfaces: inputs, the progress track
  // Ink.
  "navy", // headings, and the darkest stop of the Guided gradient
  "ink", // body copy
  "muted", // secondary copy
  "faint", // meta: footnotes, helper lines
  "on-navy-muted", // secondary copy that sits ON the dark Guided background
  // Hairlines.
  "line",
  "line-strong",
  // Brand.
  "blue-light", // the light accent; also the glow's own hue
  "blue-dark", // the action colour: filled buttons, selected borders, the bar
  "blue-deep", // the AA-contrast small-text blue on a light card
  "blue-royal", // the lead brand colour, and the Guided gradient's bright stop
  "status-royal", // the royal-toned status ink (globals maps it to --blue-royal)
  "tint-royal", // the soft chip fill
  "tint-royal-line", // that chip's hairline
  // The promoted one. See ASSESS_GLOW.
  "assess-glow",
] as const;

export type PaletteToken = (typeof PALETTE_TOKENS)[number];

/** A named colour scheme: a complete token map, plus a three-chip preview of it. */
export interface Palette {
  /** Stored in smile_assessment_campaign.theme (0079). Never renamed. */
  key: string;
  /** What the owner reads in the picker. */
  label: string;
  /** One line of "when would I pick this one". */
  description: string;
  /** [lead, light, surface] — derived from `vars`, so it can never drift from it. */
  swatch: [string, string, string];
  vars: Record<PaletteToken, string>;
}

/**
 * THE GLOW.
 *
 * Both classic quizzes paint a soft radial wash behind the card with an inline
 * arbitrary Tailwind value, and it carried a hard-coded rgba() that no token could
 * reach — the one thing on the page that would have stayed Vitality blue under a
 * teal scheme. It is now `var(--assess-glow, <this literal>)` in both files.
 *
 * THE FALLBACK IS LOAD-BEARING, NOT BELT-AND-BRACES. The generic /assess/<client>
 * quiz and the internal live preview render with no themed wrapper above them; a
 * bare var(--assess-glow) would resolve to nothing there, and an invalid colour
 * inside a gradient throws the whole gradient away — the glow would silently
 * vanish from two surfaces this build never touched. With the fallback, an
 * unwrapped quiz is byte-identical to what shipped.
 *
 * Kept here, next to the palettes, so the default below and the literal in those
 * two files are one fact with one owner. palette.test.ts reads both files and
 * fails if they diverge.
 */
export const ASSESS_GLOW_FALLBACK = "rgba(91,196,247,0.20)";

/** The key stored for "leave it exactly as it shipped". */
export const DEFAULT_PALETTE_KEY = "default";

/** Which three tokens the picker's chips show, in order. */
const SWATCH_TOKENS: readonly [PaletteToken, PaletteToken, PaletteToken] = [
  "blue-royal",
  "blue-light",
  "cream",
];

function definePalette(
  key: string,
  label: string,
  description: string,
  vars: Record<PaletteToken, string>,
): Palette {
  return {
    key,
    label,
    description,
    // Computed, never authored: the chips are the palette, not a hand-kept
    // impression of it.
    swatch: [vars[SWATCH_TOKENS[0]], vars[SWATCH_TOKENS[1]], vars[SWATCH_TOKENS[2]]],
    vars,
  };
}

/**
 * The catalogue. Order is the order the picker shows.
 *
 * ENTRY ONE IS NOT A SCHEME, IT IS THE ABSENCE OF ONE. Every value in `default`
 * is lifted verbatim from globals.css:9-86, so a campaign with theme = "default"
 * — and a campaign created before 0079 existed, whose theme is null — render the
 * same pixels. That property is the reason this feature can ship on top of live
 * campaigns without looking at them: palette.test.ts re-reads globals.css and
 * fails if a brand tweak there is not mirrored here.
 *
 * EVERY OTHER ENTRY IS COLOUR ONLY. Same layout, same copy, same type scale.
 */
export const PALETTES: Palette[] = [
  definePalette(
    DEFAULT_PALETTE_KEY,
    "Vitality blue",
    "The practice's own colours, exactly as the app uses them.",
    {
      cream: "#eef2f8",
      card: "#f9fbfe",
      "card-muted": "#e6edf7",
      navy: "#0b2049",
      ink: "#33405c",
      muted: "#64748b",
      faint: "#94a3b8",
      "on-navy-muted": "#a9c4ea",
      line: "#dde5f0",
      "line-strong": "#c8d4e6",
      "blue-light": "#5bc4f7",
      "blue-dark": "#2379ab",
      "blue-deep": "#1a648f",
      "blue-royal": "#16559a",
      // globals.css declares this one as `var(--blue-royal)`; resolved here,
      // because a palette that pointed a token at another token would re-theme
      // to whatever the OTHER palette set, which is not a scheme, it is a bug.
      "status-royal": "#16559a",
      "tint-royal": "#e9eefb",
      "tint-royal-line": "#cdd9f2",
      "assess-glow": ASSESS_GLOW_FALLBACK,
    },
  ),

  definePalette(
    "landing-blue",
    "Landing page blue",
    "Matches the practice's bespoke landing pages, for an ad that runs to both.",
    {
      // Lifted from the ONE hard-coded block every bespoke landing page wears:
      // vitality-invisalign-landing.styles.ts:20-32 (.vd-landing). Its names map
      // across as: --light -> cream, --panel -> card, --panel-2 -> card-muted,
      // --tx/--tx-soft/--tx-faint -> ink/muted/faint, --tx-on-soft ->
      // on-navy-muted, --blue-soft/--blue-chip -> tint-royal/tint-royal-line.
      cream: "#f2f7fd",
      card: "#ffffff",
      "card-muted": "#f7fafe",
      navy: "#0b2049",
      ink: "#16233f",
      muted: "#53607c",
      faint: "#8b96ad",
      "on-navy-muted": "#a9c1e2",
      line: "#e2e9f4",
      // DERIVED, and the only value here that is not in .vd-landing: that design
      // has a single hairline token, and this surface needs a heavier one for
      // input borders. A shade down from --line, nothing invented about the hue.
      "line-strong": "#cfdcee",
      "blue-light": "#5bc4f7",
      // .vd-landing has one action blue (--blue), not the app's dark/royal pair,
      // so both point at it. That is the design, not a shortcut: the landing page
      // fills every button with the same blue.
      "blue-dark": "#16559a",
      "blue-deep": "#1a648f",
      "blue-royal": "#16559a",
      "status-royal": "#16559a",
      "tint-royal": "#eef4fb",
      "tint-royal-line": "#dce9fb",
      // The landing hero's own glow, to the digit (styles.ts:59).
      "assess-glow": "rgba(91,196,247,0.20)",
    },
  ),

  definePalette(
    "clinical-teal",
    "Clinical teal",
    "Cool and clinical. Reads as hygiene, check-ups and general dentistry.",
    {
      cream: "#eaf3f2",
      card: "#f8fcfb",
      "card-muted": "#dceceb",
      navy: "#06333a",
      ink: "#24424a",
      muted: "#556a71",
      faint: "#8aa0a6",
      "on-navy-muted": "#a5cfcd",
      line: "#d3e5e3",
      "line-strong": "#b8d3d0",
      "blue-light": "#4fc7c0",
      "blue-dark": "#10807c",
      "blue-deep": "#0b6b68",
      "blue-royal": "#0d6f74",
      "status-royal": "#0d6f74",
      "tint-royal": "#e4f2f1",
      "tint-royal-line": "#c3e0dd",
      "assess-glow": "rgba(79,199,192,0.20)",
    },
  ),

  definePalette(
    "warm-sand",
    "Warm sand",
    "Warm and unclinical. Suits whitening, bonding and nervous-patient funnels.",
    {
      cream: "#f5f0e8",
      card: "#fdfbf7",
      "card-muted": "#ece4d8",
      navy: "#33261a",
      ink: "#453729",
      muted: "#6b5d4c",
      faint: "#9b8d7b",
      "on-navy-muted": "#d8c3a5",
      line: "#e6dccd",
      "line-strong": "#d3c5b0",
      "blue-light": "#d9a441",
      "blue-dark": "#9a6a12",
      "blue-deep": "#855a0d",
      "blue-royal": "#8a5a2b",
      "status-royal": "#8a5a2b",
      "tint-royal": "#f6ecdc",
      "tint-royal-line": "#e6d3b4",
      "assess-glow": "rgba(217,164,65,0.18)",
    },
  ),

  definePalette(
    "deep-plum",
    "Deep plum",
    "Quiet and expensive. Suits veneers, smile makeovers and implant funnels.",
    {
      cream: "#f3eef6",
      card: "#fdfbfe",
      "card-muted": "#e9e0ef",
      navy: "#2b1338",
      ink: "#3d2b47",
      muted: "#665473",
      faint: "#9c8ea6",
      "on-navy-muted": "#c9aad9",
      line: "#e4d9ea",
      "line-strong": "#cfbfd9",
      "blue-light": "#c084d8",
      "blue-dark": "#7c3fa0",
      "blue-deep": "#6b2f8e",
      "blue-royal": "#6d2f96",
      "status-royal": "#6d2f96",
      "tint-royal": "#f1e7f7",
      "tint-royal-line": "#dcc8e8",
      "assess-glow": "rgba(192,132,216,0.20)",
    },
  ),
];

/** The stored values a `theme` column is allowed to hold. */
export const PALETTE_KEYS: string[] = PALETTES.map((p) => p.key);

const PALETTE_BY_KEY = new Map(PALETTES.map((p) => [p.key, p]));

/**
 * THE VALIDATION RULE, in one place. The create route and the PATCH route both
 * ask this before anything is stored, the same way `goal` asks GOAL_KEYS
 * (campaign/route.ts:108) — so an unknown key is a 400 at the door rather than a
 * row that renders as something nobody chose.
 */
export function isPaletteKey(key: unknown): key is string {
  return typeof key === "string" && PALETTE_BY_KEY.has(key);
}

/** The named scheme, or undefined. Callers that must render use `paletteFor`. */
export function paletteByKey(key: string | null | undefined): Palette | undefined {
  return key ? PALETTE_BY_KEY.get(key) : undefined;
}

/**
 * The scheme to RENDER for a stored value — never undefined.
 *
 * Both fallbacks land on `default`, and both are real cases rather than defensive
 * padding. null is every campaign that predates 0079, and every campaign on a
 * database where 0079 has not been applied. An unknown key is a scheme that was
 * retired after a campaign chose it. A public, paid ad destination must never be
 * the place either of those is discovered, so both render what shipped.
 */
export function paletteFor(key: string | null | undefined): Palette {
  return paletteByKey(key) ?? PALETTES[0];
}

/**
 * The scheme as a style object: `{ "--navy": "#...", ... }`, ready to spread onto
 * the wrapper element that owns the themed subtree.
 *
 * Returns Record<string, string> rather than React.CSSProperties on purpose —
 * this module stays React-free, and the single call site casts (page.tsx).
 */
export function paletteVars(key: string | null | undefined): Record<string, string> {
  const palette = paletteFor(key);
  const out: Record<string, string> = {};
  for (const token of PALETTE_TOKENS) out[`--${token}`] = palette.vars[token];
  return out;
}
