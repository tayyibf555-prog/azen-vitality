// CUSTOM THEMES: an owner's own colour scheme for a Smile Assessment funnel, and
// the rules that decide whether one may be stored at all.
//
// ============================================================================
// WHAT MAKES THIS DIFFERENT FROM THE CATALOGUE, AND WHY IT NEEDS A VALIDATOR.
//
// palette.ts holds seven schemes a developer authored, a reviewer read and a test
// suite gates at build time. Nothing an owner does can add an eighth. This module
// is what happens when they can: eighteen colours, typed into a browser, stored in
// a row, and then SPREAD INTO A STYLE ATTRIBUTE ON A PUBLIC PAGE that paid ad
// traffic lands on.
//
// That last clause is the whole design. Two things follow from it and neither is
// optional:
//
//   1. THE GRAMMAR IS THE INJECTION GUARD. A custom property's value is emitted
//      into CSS verbatim. `--navy: red; } body { display:none } .x{` is a value
//      that "looks like a colour field" and is in fact a stylesheet. So a value is
//      not sanitised, escaped or trimmed into shape — it either matches a hex or
//      rgb()/rgba() literal exactly, or it is refused. There is no third outcome
//      and no "best effort". `isColourLiteral` (contrast.ts) is that grammar, and
//      it is the same function the contrast reader uses, so a value that is
//      allowed through is by construction a value the AA gate could measure.
//
//   2. THE AA GATE IS SERVER-SIDE AND IS THE PRESET BAR. The five tuned presets
//      clear CUSTOM_THEME_PAIRS with headroom; an owner's theme clears the same
//      table or it is refused with the failing pair named. A colour picker in a
//      browser is a suggestion; this is the decision. (The two byte-locked legacy
//      presets sit below that bar on two pairs for historical reasons contrast.ts
//      documents — grandfathered, never offered to a new theme.)
//
// PURE. No React, no server imports, no I/O — the same boundary palette.ts and
// contrast.ts keep, because this is imported by an API route, a server component,
// a client picker and a test alike.
//
// COLOUR ONLY, like the catalogue. Nothing here changes a word a patient reads, so
// none of it goes near flow-copy.ts's write-time scan or the funding-language ban.
// The one exception is the theme's NAME, which is INTERNAL: it appears in the
// owner's picker and nowhere on a public page. See normaliseThemeName.
// ============================================================================

import {
  PALETTE_TOKENS,
  swatchFromVars,
  type Palette,
  type PaletteToken,
} from "./palette";
import {
  CONTRAST_TOKENS,
  CUSTOM_THEME_PAIRS,
  contrastFailures,
  describeContrastFailure,
  hasAlphaChannel,
  isColourLiteral,
  type ContrastFailure,
} from "./contrast";

/* ---------------------------------------------------------------------------
 * 1. The stored reference.
 * ------------------------------------------------------------------------- */

/**
 * How a campaign's `theme` column names a custom theme: `custom:<uuid>`.
 *
 * WHY A PREFIX AND NOT A BARE ID. The column already holds preset KEYS, and the
 * renderer's contract is that an unrecognised value falls back to the shipped look
 * rather than failing (paletteFor). Without a marker, every value that is not a
 * preset key would have to be treated as a possible custom id — which means a
 * database round trip on the public, force-dynamic ad-destination page for a
 * retired key, a typo, or a hand-edited row, i.e. for exactly the values that are
 * NOT a theme. With the prefix the page knows from the string alone whether a
 * lookup is even worth doing, and a preset campaign costs nothing.
 *
 * It also keeps the two namespaces provably disjoint: no palette key contains a
 * colon, so a custom theme can never shadow a preset and a preset can never be
 * mistaken for a deleted custom theme.
 */
export const CUSTOM_THEME_PREFIX = "custom:";

/** A v4-shaped uuid, which is what the table's `id` column generates. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value stored in `smile_assessment_campaign.theme` for a custom theme. */
export function customThemeRef(id: string): string {
  return `${CUSTOM_THEME_PREFIX}${id}`;
}

/**
 * The theme id inside a stored reference, or null if this is not one.
 *
 * STRICT ABOUT THE SHAPE, because the id it returns goes into a database query. A
 * `custom:` followed by anything at all would hand the repository a caller-chosen
 * string; requiring a uuid means the only thing that can reach the query is a
 * value the table itself could have produced.
 */
export function parseCustomThemeRef(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(CUSTOM_THEME_PREFIX)) return null;
  const id = value.slice(CUSTOM_THEME_PREFIX.length);
  return UUID.test(id) ? id : null;
}

/** Is this stored value a reference to a custom theme (whether or not it exists)? */
export function isCustomThemeRef(value: unknown): boolean {
  return parseCustomThemeRef(value) !== null;
}

/* ---------------------------------------------------------------------------
 * 2. The record.
 * ------------------------------------------------------------------------- */

/** One owner-defined scheme, as stored (migration 0081) and as rendered. */
export interface CustomTheme {
  id: string;
  clientId: string;
  /** Internal label for the picker. Never rendered on a public page. */
  name: string;
  /** A complete, validated token map — the same closed set every preset supplies. */
  vars: Record<PaletteToken, string>;
  createdAt: string;
  updatedAt: string;
}

/** The theme as the pickers and the renderer want it: a Palette, like any preset. */
export function customThemePalette(theme: Pick<CustomTheme, "id" | "name" | "vars">): Palette {
  return {
    key: customThemeRef(theme.id),
    label: theme.name,
    description: "One of this practice's own colour schemes.",
    // DERIVED, exactly as definePalette derives a preset's chips — the same
    // function, so the "Your themes" group in the picker cannot show a different
    // three colours from the row of presets above it.
    swatch: swatchFromVars(theme.vars),
    vars: theme.vars,
  };
}

/**
 * The custom theme a stored value names, as a Palette — or null if it names a
 * preset, names nothing, or names a theme this practice no longer has.
 *
 * The client-side counterpart of the server's resolve step: the pickers hold the
 * practice's themes in state and need the same answer without a round trip.
 */
export function customPaletteFor(
  key: string | null | undefined,
  themes: readonly CustomTheme[],
): Palette | null {
  const id = parseCustomThemeRef(key);
  if (!id) return null;
  const theme = themes.find((t) => t.id === id);
  return theme ? customThemePalette(theme) : null;
}

/* ---------------------------------------------------------------------------
 * 3. The name.
 * ------------------------------------------------------------------------- */

export const MAX_THEME_NAME = 40;

/**
 * The stored name, or null if there is not one.
 *
 * INTERNAL COPY, and that is why the rule is short. This string is shown to the
 * owner in their own picker and is never sent to a patient, never rendered on
 * /assess, and never reaches the campaign's public payload — so it is not
 * compliance-scanned copy, it is a label. What it does need is to be a label: not
 * blank, not a paragraph, and not carrying control characters that would make one
 * theme in a list indistinguishable from another.
 */
export function normaliseThemeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters out first (a newline in a list turns one row into two,
  // and a bare \r hides whatever follows it), then runs of whitespace collapsed,
  // then trimmed and capped. The escapes are written \\u so this file stays plain
  // ASCII: a literal control byte in a source file is invisible to a reviewer.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned.slice(0, MAX_THEME_NAME).trim();
}

/* ---------------------------------------------------------------------------
 * 4. The validator.
 * ------------------------------------------------------------------------- */

/**
 * The longest a single colour value may be. Not a security control — the anchored
 * grammar below is — but a cheap ceiling so a megabyte of "colour" never reaches a
 * regex or a row.
 */
export const MAX_COLOUR_LENGTH = 32;

export type ThemeFailure =
  /** A token in the closed set was not supplied. */
  | { kind: "missing"; token: PaletteToken }
  /** A key that is not in the closed set was supplied. */
  | { kind: "unknown"; token: string }
  /** Supplied, but not a hex / rgb() / rgba() literal. */
  | { kind: "grammar"; token: PaletteToken; value: string }
  /** A colour, but translucent, on a token whose contrast is measured. */
  | { kind: "alpha"; token: PaletteToken; value: string }
  /** A measured pair below its threshold. */
  | { kind: "contrast"; failure: ContrastFailure };

export type ThemeVarsResult =
  | { ok: true; vars: Record<PaletteToken, string> }
  | { ok: false; failures: ThemeFailure[] };

/**
 * Judge a submitted token map. ALL FAILURES AT ONCE, in the flow-validate house
 * style: an owner adjusting eighteen colours must not be told about them one save
 * at a time.
 *
 * THE ORDER MATTERS AND IS NOT COSMETIC. Completeness and grammar are settled
 * first, and the contrast pass runs only when every MEASURED token is a readable,
 * opaque colour. Running it earlier would bury the one useful sentence ("--muted
 * is not a colour") under six contrast failures that are all the same fact
 * restated, and `contrast()` scores junk 0, so every pair touching a bad token
 * would fail. What is reported is therefore always the FIRST honest problem with
 * the map, in full.
 *
 * ALPHA IS REFUSED WHERE IT IS MEASURED, and this is the subtle one. A value like
 * `rgba(0,0,0,0.02)` is a valid colour, renders as very nearly nothing, and scores
 * a perfect 21:1 on its channels — contrast maths alone cannot see through it, so
 * it is the single colour-shaped way to defeat an AA gate. Tokens nobody reads
 * text off (the glow, the tints, the hairlines) may be translucent freely.
 */
export function validateThemeVars(input: unknown): ThemeVarsResult {
  const failures: ThemeFailure[] = [];
  const source =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  if (!source) {
    // Not a map at all: report it as the whole closed set missing, so the message
    // an owner reads is "these tokens are required" rather than a type name.
    return { ok: false, failures: PALETTE_TOKENS.map((token) => ({ kind: "missing", token })) };
  }

  const known = new Set<string>(PALETTE_TOKENS);
  for (const key of Object.keys(source)) {
    // A key outside the closed set would be a custom property no utility class
    // reads: dead colour that looks like theming. Refused rather than dropped, so
    // an owner who mistypes a token name finds out.
    if (!known.has(key)) failures.push({ kind: "unknown", token: key.slice(0, 60) });
  }

  const vars: Partial<Record<PaletteToken, string>> = {};
  for (const token of PALETTE_TOKENS) {
    const raw = source[token];
    if (typeof raw !== "string") {
      failures.push({ kind: "missing", token });
      continue;
    }
    // Trimmed, then matched exactly. Trimming is safe (whitespace cannot carry a
    // declaration) and is the one accommodation made to a pasted value; everything
    // else about the string has to already be a colour.
    const value = raw.trim();
    if (value === "") {
      failures.push({ kind: "missing", token });
      continue;
    }
    if (value.length > MAX_COLOUR_LENGTH || !isColourLiteral(value)) {
      failures.push({ kind: "grammar", token, value: value.slice(0, MAX_COLOUR_LENGTH) });
      continue;
    }
    if (CONTRAST_TOKENS.includes(token) && hasAlphaChannel(value)) {
      failures.push({ kind: "alpha", token, value });
      continue;
    }
    vars[token] = value;
  }

  if (failures.length > 0) return { ok: false, failures };

  for (const failure of contrastFailures(vars, CUSTOM_THEME_PAIRS)) {
    failures.push({ kind: "contrast", failure });
  }
  if (failures.length > 0) return { ok: false, failures };

  return { ok: true, vars: vars as Record<PaletteToken, string> };
}

/** One failure as a sentence an owner reads in an API error. */
export function describeThemeFailure(failure: ThemeFailure): string {
  switch (failure.kind) {
    case "missing":
      return `--${failure.token} is missing; every colour in the set is required`;
    case "unknown":
      return `"${failure.token}" is not one of this theme's colours`;
    case "grammar":
      return `--${failure.token} is "${failure.value}", which is not a colour. Use #rrggbb, #rgb, rgb(r,g,b) or rgba(r,g,b,a)`;
    case "alpha":
      return `--${failure.token} is see-through ("${failure.value}"). Text is read against this colour, so it has to be solid`;
    case "contrast":
      return describeContrastFailure(failure.failure);
  }
}

/** Every failure, one per line — the shape flow-validate's describe* helpers use. */
export function describeThemeFailures(failures: readonly ThemeFailure[]): string {
  return failures.map((f) => `- ${describeThemeFailure(f)}`).join("\n");
}

/**
 * Re-check a map read back OUT of the database, as defence in depth on the public
 * page.
 *
 * The write path already validated it. This exists because the write path is not
 * the only way a row changes: a hand-edited row, a restored backup, a future
 * migration, or a bug in a later feature. The public /assess page is a paid ad
 * destination and the one place a bad value would become CSS, so it re-reads the
 * grammar there rather than trusting that nothing has happened to the row since.
 *
 * Grammar and completeness only, NOT contrast: a theme that has slipped below AA
 * is a thing to fix in the builder, and blanking a running campaign's colours over
 * it would be a worse outcome than a slightly low ratio. A value that is not a
 * colour is different in kind — it is the one that can put something other than a
 * colour into a public page's stylesheet.
 */
export function readbackVars(input: unknown): Record<PaletteToken, string> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const out: Partial<Record<PaletteToken, string>> = {};
  for (const token of PALETTE_TOKENS) {
    const raw = source[token];
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    if (value.length > MAX_COLOUR_LENGTH || !isColourLiteral(value)) return null;
    out[token] = value;
  }
  return out as Record<PaletteToken, string>;
}
