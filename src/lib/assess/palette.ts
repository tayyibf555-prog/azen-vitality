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

/**
 * The three chips that stand for a token map.
 *
 * EXPORTED BECAUSE THE CATALOGUE IS NO LONGER THE ONLY THING WEARING CHIPS. An
 * owner's custom theme (0081) is a token map with no catalogue entry, and its
 * chips have to be the SAME three tokens in the same order as every preset's, or
 * the "Your themes" group in the picker would be showing a different fact from the
 * row above it. Deriving both from this one function is what makes that true by
 * construction rather than by two developers agreeing.
 */
export function swatchFromVars(vars: Record<PaletteToken, string>): [string, string, string] {
  return [vars[SWATCH_TOKENS[0]], vars[SWATCH_TOKENS[1]], vars[SWATCH_TOKENS[2]]];
}

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
    swatch: swatchFromVars(vars),
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
      // THE SOURCE OF TRUTH for the `.vd-landing` token block every bespoke
      // landing page wears. These values started life hard-coded in
      // vitality-invisalign-landing.styles.ts; that stylesheet now emits them
      // from here via paletteCssBlock() below, so the ad and the quiz it links
      // to cannot drift apart. The landing design's own names map across as:
      // --light -> cream, --panel -> card, --panel-2 -> card-muted,
      // --tx/--tx-soft/--tx-faint -> ink/muted/faint, --tx-on-soft ->
      // on-navy-muted, --blue-soft/--blue-chip -> tint-royal/tint-royal-line,
      // --blue -> blue-dark. LANDING_TOKEN_BLOCK holds that mapping.
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
      // NOT the landing page's glow, and deliberately not wired to it. Three
      // things are true of the hero glow and none of them make it a shared fact:
      // it is not a custom property at all (it is a literal inside a gradient,
      // styles.ts:57); it is written there as `rgba(91,196,247,.20)`, which is a
      // different byte string from this one; and a later rule (styles.ts:283)
      // overrides that gradient outright, so the alpha the hero actually paints
      // is .26. This value is the assessment quiz's own glow — the same hue at
      // the same strength, chosen so a landing-blue quiz reads as a continuation
      // of the ad — and paletteCssBlock() below does not emit it.
      "assess-glow": "rgba(91,196,247,0.20)",
    },
  ),

  // ---------------------------------------------------------------------------
  // THE BOLD SCHEMES. Everything below default and landing-blue is a FULL re-skin,
  // not an accent nudge: the card the questions sit on is a confident tint of the
  // scheme's own hue (never white), the page and the inset surfaces are deeper
  // tints of it, and the action colour, the eyebrow blue, the chip and the
  // hairlines all move with it — so the whole screen reads as the scheme at a
  // glance, not just the icon tiles.
  //
  // Every one is tuned to clear WCAG AA with headroom on its TINTED surfaces, not
  // on white: a tinted --card-muted pushes muted secondary text toward the floor,
  // so the ink set here is deliberately darker than a white-card scheme would need.
  // palette.test.ts asserts the exact pairs and prints the ratios; the thresholds
  // are the guard that keeps "bold" from turning into "unreadable".
  // ---------------------------------------------------------------------------

  definePalette(
    "clinical-teal",
    "Clinical teal",
    "Cool and clinical. Reads as hygiene, check-ups and general dentistry.",
    {
      cream: "#d5ece9",
      card: "#e6f5f2",
      "card-muted": "#cfe8e4",
      navy: "#04302f",
      ink: "#123f3d",
      muted: "#3c605d",
      faint: "#5f847f",
      "on-navy-muted": "#8fd6cf",
      line: "#bfe0db",
      "line-strong": "#a5d2cc",
      "blue-light": "#3fd0c6",
      "blue-dark": "#07716b",
      "blue-deep": "#0a655e",
      "blue-royal": "#0b6862",
      "status-royal": "#0b6862",
      "tint-royal": "#c9ece7",
      "tint-royal-line": "#a1d8d1",
      "assess-glow": "rgba(63,208,198,0.22)",
    },
  ),

  definePalette(
    "warm-sand",
    "Warm sand",
    "Warm and unclinical. Suits whitening, bonding and nervous-patient funnels.",
    {
      cream: "#f0e4d2",
      card: "#f8efe0",
      "card-muted": "#ecdcc4",
      navy: "#3a2410",
      ink: "#4a3316",
      muted: "#6f5327",
      faint: "#93764a",
      "on-navy-muted": "#e6c28a",
      line: "#e3d2b6",
      "line-strong": "#d3bd97",
      "blue-light": "#e8a53a",
      "blue-dark": "#935611",
      "blue-deep": "#824b0d",
      "blue-royal": "#8c5216",
      "status-royal": "#8c5216",
      "tint-royal": "#f2e2c6",
      "tint-royal-line": "#e2c893",
      "assess-glow": "rgba(232,165,58,0.20)",
    },
  ),

  definePalette(
    "deep-plum",
    "Deep plum",
    "Bold and premium. Suits veneers, smile makeovers and implant funnels.",
    {
      cream: "#ece0f0",
      card: "#f4e9f6",
      "card-muted": "#e3d3ea",
      navy: "#2b0f3a",
      ink: "#3d1e4d",
      muted: "#5f4270",
      faint: "#8a68a0",
      "on-navy-muted": "#cf9fe0",
      line: "#ddc9e6",
      "line-strong": "#ccb2d9",
      "blue-light": "#c46fe0",
      "blue-dark": "#7c26a3",
      "blue-deep": "#701f96",
      "blue-royal": "#77299d",
      "status-royal": "#77299d",
      "tint-royal": "#eddaf3",
      "tint-royal-line": "#d9b8e8",
      "assess-glow": "rgba(196,111,224,0.22)",
    },
  ),

  definePalette(
    "coral-rose",
    "Coral rose",
    "Warm and inviting. Suits cosmetic, family and new-patient funnels.",
    {
      cream: "#f6dfe0",
      card: "#fceaea",
      "card-muted": "#f3d3d4",
      navy: "#420f1c",
      ink: "#551c28",
      muted: "#7a3d47",
      faint: "#a56e77",
      "on-navy-muted": "#f0a9b0",
      line: "#eecccd",
      "line-strong": "#e0b0b3",
      "blue-light": "#f0607a",
      "blue-dark": "#ac233d",
      "blue-deep": "#9c1e38",
      "blue-royal": "#b02843",
      "status-royal": "#b02843",
      "tint-royal": "#f7d7db",
      "tint-royal-line": "#eeb0b8",
      "assess-glow": "rgba(240,96,122,0.20)",
    },
  ),

  definePalette(
    "fresh-emerald",
    "Fresh emerald",
    "Fresh and reassuring. Suits hygiene, kids and preventive-care funnels.",
    {
      cream: "#d5ecdc",
      card: "#e6f5ea",
      "card-muted": "#cfe8d7",
      navy: "#043022",
      ink: "#123f2e",
      muted: "#356048",
      faint: "#5d8874",
      "on-navy-muted": "#8ed6ac",
      line: "#bfe0cb",
      "line-strong": "#a5d2b6",
      "blue-light": "#34c778",
      "blue-dark": "#08713f",
      "blue-deep": "#0a6539",
      "blue-royal": "#0b6b41",
      "status-royal": "#0b6b41",
      "tint-royal": "#c9ecd6",
      "tint-royal-line": "#a1d8b8",
      "assess-glow": "rgba(52,199,120,0.20)",
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
  return paletteVarsFrom(paletteFor(key).vars);
}

/**
 * The same map, built from a token map that has no catalogue key.
 *
 * THE ONE PLACE `--token: value` IS ASSEMBLED, and that is the point of splitting
 * it out. An owner's custom theme (0081) is exactly a `vars` map with a name on
 * it; if the public page built its wrapper for a custom theme by a second route,
 * that route would be free to emit a token the catalogue does not, or to skip one
 * the catalogue does — and a half-themed public page is the failure this whole
 * module is written to make impossible. Presets and custom themes now leave by the
 * same door.
 *
 * CLOSED LIST, ALWAYS. It iterates PALETTE_TOKENS rather than the object's own
 * keys, so a stored map that somehow carried an extra key cannot put an
 * unrecognised custom property into a public page's style attribute — whatever the
 * validator did or did not catch on the way in.
 */
export function paletteVarsFrom(vars: Record<PaletteToken, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of PALETTE_TOKENS) out[`--${token}`] = vars[token];
  return out;
}

/* ---------------------------------------------------------------------------
 * The landing seam: the same catalogue, serialised as raw CSS.
 * ------------------------------------------------------------------------- */

/**
 * One declaration in the `.vd-landing` token block. Either a catalogue token
 * wearing the landing design's own name for it, or a literal the catalogue has
 * no counterpart for.
 */
type LandingDecl =
  | { readonly name: string; readonly token: PaletteToken }
  | { readonly name: string; readonly literal: string };

/**
 * THE BLOCK, AS THE DESIGN AUTHORED IT — grouped by meaning, not alphabetised,
 * and wrapped by hand: chrome, then blues, then the frame/chip pair, then
 * surfaces, then ink, then the hairline, then the on-dark set.
 *
 * The outer array is LINES and the inner array is the declarations on that line.
 * That shape is the whole point. The stylesheet this feeds ships raw to the
 * browser inside a `<style dangerouslySetInnerHTML>` on four public pages, and
 * the block it replaces was hand-wrapped; an `Object.entries().join("; ")` would
 * have produced one long line and a diff nobody could read against the design it
 * was ported from. So the grouping is data here, and the emitter is dumb.
 *
 * PASSENGERS. Six of these are literals, because the catalogue has no token for
 * them: the three `--chrome-*` stops of the hero gradient, `--frame`, `--tx-on`,
 * and `--line-d`. They are the landing design's own, they are not themed by any
 * scheme, and they ride along here so that the block stays one contiguous thing
 * rather than a generated fragment with hand-written strays either side of it.
 *
 * DELIBERATELY ABSENT, and each for its own reason:
 *   - `line-strong` — a catalogue-only token. It is DERIVED (see landing-blue
 *     above), the landing design has a single hairline, and writing it into the
 *     CSS would add a custom property no rule in that stylesheet reads.
 *   - `status-royal` — same colour as `blue-royal` in this scheme; the landing
 *     design has no status ink, so there is nothing to name.
 *   - `assess-glow` — not a custom property in that stylesheet at all. See the
 *     note on the landing-blue entry above.
 */
const LANDING_TOKEN_BLOCK: readonly (readonly LandingDecl[])[] = [
  [
    { name: "navy", token: "navy" },
    { name: "chrome-from", literal: "#082249" },
    { name: "chrome-mid", literal: "#0f3670" },
    { name: "chrome-to", literal: "#16559a" },
  ],
  [
    // The landing design fills every button with one blue; `blue-dark` is the
    // catalogue's name for the action colour.
    { name: "blue", token: "blue-dark" },
    { name: "blue-deep", token: "blue-deep" },
    { name: "blue-light", token: "blue-light" },
    { name: "blue-royal", token: "blue-royal" },
  ],
  [
    { name: "frame", literal: "#c3d7ef" },
    { name: "blue-soft", token: "tint-royal" },
    { name: "blue-chip", token: "tint-royal-line" },
  ],
  [
    { name: "light", token: "cream" },
    { name: "panel", token: "card" },
    { name: "panel-2", token: "card-muted" },
  ],
  [
    { name: "tx", token: "ink" },
    { name: "tx-soft", token: "muted" },
    { name: "tx-faint", token: "faint" },
  ],
  [{ name: "line", token: "line" }],
  [
    { name: "tx-on", literal: "#eaf1fb" },
    { name: "tx-on-soft", token: "on-navy-muted" },
    { name: "line-d", literal: "rgba(255,255,255,.11)" },
  ],
];

/**
 * The `.vd-landing` custom-property block as a CSS string, painted from a scheme.
 *
 * Returns the declarations only — no selector, no braces, no trailing newline —
 * so the stylesheet keeps ownership of everything around it (`--r`, the reset,
 * the font stack). Two-space indent, no space after the colon, `"; "` between
 * declarations on a line, `"\n"` between lines: byte-for-byte the format the
 * design was ported in, because that string is a checked-in contract and a
 * reformat would read as a change to a public page.
 *
 * ONE CALLER, ONE KEY. `vitality-invisalign-landing.styles.ts` passes
 * "landing-blue", which is where these values came from. The parameter exists
 * because the catalogue is the parameter — but note the six passengers above are
 * NOT themed, so handing this a teal scheme would emit teal surfaces under a
 * blue hero gradient. That is a half-theme, not a feature; if a second landing
 * skin is ever wanted, the passengers become tokens first.
 */
export function paletteCssBlock(key: string | null | undefined): string {
  const palette = paletteFor(key);
  return LANDING_TOKEN_BLOCK.map((line) => {
    const declarations = line.map((decl) => {
      // Lowercased on the way out so the emitted format is the function's own
      // contract rather than a property of however the catalogue was typed.
      const value = "token" in decl ? palette.vars[decl.token] : decl.literal;
      return `--${decl.name}:${value.toLowerCase()}`;
    });
    return `  ${declarations.join("; ")};`;
  }).join("\n");
}
