// The colour-scheme catalogue, held at the four seams that make it safe to point
// a paid ad at a themed page.
//
// 1. THE KEYS ARE A CONTRACT. They are stored in a database column; renaming one
//    silently un-themes every campaign that chose it.
// 2. EVERY VALUE IS A COLOUR. These strings are spread straight into a `style`
//    attribute on a public page. A typo'd hex does not throw — it drops the
//    declaration, and the token falls back through inheritance to a value from a
//    different scheme, which is how you get a teal page with one blue button.
// 3. DEFAULT MEANS UNCHANGED. Entry one is a hand-kept copy of globals.css, so
//    this suite re-reads globals.css and diffs it. Without this test, a brand
//    tweak there would silently make "default" a fifth scheme nobody picked.
// 4. NOBODY SHIPS A LESS LEGIBLE PALETTE. AA where AA applies; and where the
//    shipped design already sits below AA (faint meta text), the shipped design
//    is the floor.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASSESS_GLOW_FALLBACK,
  DEFAULT_PALETTE_KEY,
  PALETTES,
  PALETTE_KEYS,
  PALETTE_TOKENS,
  isPaletteKey,
  paletteByKey,
  paletteFor,
  paletteVars,
  type PaletteToken,
} from "./palette";

const GLOBALS_PATH = "src/app/globals.css";
const CLASSIC_QUIZ_PATH = "src/components/assess/assessment-quiz.tsx";
const DETERMINISTIC_QUIZ_PATH = "src/components/assess/deterministic-assessment-quiz.tsx";
/**
 * The builder's phone-screen strip paints the SAME glow as the funnel it is a
 * picture of (flow-phone-mini.tsx). It is on this list because a preview that
 * drifted from the runtime would be lying about the very thing it exists to show.
 */
const PHONE_MINI_PATH = "src/components/client/smile-assessment/flow-phone-mini.tsx";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/* ---------------------------------------------------------------------------
 * 1. The key set.
 * ------------------------------------------------------------------------- */

describe("the catalogue's keys are a stored contract", () => {
  // MUTATION: rename a key and every campaign holding the old one silently
  // re-renders as the default, on a live ad destination, with no error anywhere.
  it("is exactly these five, in this order", () => {
    expect(PALETTE_KEYS).toEqual([
      "default",
      "landing-blue",
      "clinical-teal",
      "warm-sand",
      "deep-plum",
    ]);
  });

  it("puts the unchanged look first, because that is what null means", () => {
    expect(PALETTES[0].key).toBe(DEFAULT_PALETTE_KEY);
    expect(DEFAULT_PALETTE_KEY).toBe("default");
  });

  it("has no duplicate keys and gives every one a label and a description", () => {
    expect(new Set(PALETTE_KEYS).size).toBe(PALETTES.length);
    for (const p of PALETTES) {
      expect(p.label.trim().length, `${p.key} has no label`).toBeGreaterThan(0);
      expect(p.description.trim().length, `${p.key} has no description`).toBeGreaterThan(0);
    }
  });

  // MUTATION: let a palette omit a token and the page half-themes — the missing
  // token inherits from :root, so a teal card keeps the Vitality blue button.
  it("makes every palette supply every token", () => {
    for (const p of PALETTES) {
      for (const token of PALETTE_TOKENS) {
        expect(p.vars[token], `${p.key} is missing --${token}`).toBeTruthy();
      }
      // ...and nothing beyond the closed list, which would be a var no utility
      // reads: dead colour that looks like theming.
      expect(Object.keys(p.vars).sort()).toEqual([...PALETTE_TOKENS].sort());
    }
  });

  it("derives the picker's chips from the palette itself", () => {
    for (const p of PALETTES) {
      expect(p.swatch).toEqual([p.vars["blue-royal"], p.vars["blue-light"], p.vars.cream]);
    }
  });

  it("recognises its own keys and nothing else", () => {
    for (const key of PALETTE_KEYS) expect(isPaletteKey(key)).toBe(true);
    for (const bad of ["", "Default", "landing_blue", "rgb(0,0,0)", null, undefined, 7, {}]) {
      expect(isPaletteKey(bad), `accepted ${String(bad)}`).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. Every value is a colour.
 * ------------------------------------------------------------------------- */

/**
 * Deliberately strict, and deliberately not a full CSS colour grammar: these
 * values go into a public page's style attribute, so the test's job is to say
 * "this is a literal colour", not "a browser would probably cope".
 */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/;
const RGBA = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;

function isCssColour(value: string): boolean {
  return HEX.test(value) || RGBA.test(value);
}

describe("every value is a literal colour", () => {
  // MUTATION: a typo'd hex does not throw. The browser drops the declaration and
  // the token inherits, so one chip of the page stays the colour of another
  // scheme - the least reportable bug this feature can have.
  it("parses as a hex or rgb()/rgba() literal", () => {
    for (const p of PALETTES) {
      for (const token of PALETTE_TOKENS) {
        const value = p.vars[token];
        expect(isCssColour(value), `${p.key} --${token} = "${value}" is not a colour`).toBe(true);
      }
    }
  });

  // MUTATION: point a token at var(--something) and the palette stops being a
  // scheme - it renders as whatever the surrounding page happens to have set.
  it("never points a token at another token", () => {
    for (const p of PALETTES) {
      for (const token of PALETTE_TOKENS) {
        expect(p.vars[token], `${p.key} --${token} indirects`).not.toContain("var(");
      }
    }
  });

  it("is proved to catch what it is for", () => {
    // The guard rejecting bad input is the half of the assertion that can rot.
    for (const bad of ["#0b204", "#gggggg", "navy", "var(--navy)", "rgb(1,2)", ""]) {
      expect(isCssColour(bad), `accepted ${bad}`).toBe(false);
    }
    for (const good of ["#fff", "#0b2049", "#0b204980", "rgba(91,196,247,0.20)", "rgb(1, 2, 3)"]) {
      expect(isCssColour(good), `rejected ${good}`).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 3. Default means unchanged. The drift guard.
 * ------------------------------------------------------------------------- */

/**
 * The custom properties declared in globals.css's `:root` block, one level of
 * `var(--x)` indirection resolved (globals declares --status-royal as
 * var(--blue-royal), and a palette must store the resolved colour).
 */
function globalsRootTokens(): Record<string, string> {
  const css = read(GLOBALS_PATH);
  const start = css.indexOf(":root {");
  expect(start, "globals.css no longer has a :root block").toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gim)) {
    out[name] = value.trim();
  }
  // Resolve `var(--x)` once — enough for globals, which never chains further.
  for (const [name, value] of Object.entries(out)) {
    const ref = /^var\(--([a-z0-9-]+)\)$/i.exec(value);
    if (ref && out[ref[1]]) out[name] = out[ref[1]];
  }
  return out;
}

describe("the default palette is globals.css, not a fifth scheme", () => {
  const globals = globalsRootTokens();
  const fallback = PALETTES[0];

  it("read globals.css at all", () => {
    // If the parse silently returned {} the diff below would pass on nothing.
    expect(Object.keys(globals).length).toBeGreaterThan(20);
    expect(globals.navy).toBe("#0b2049");
  });

  // MUTATION: nudge a brand colour in globals.css and leave this file alone.
  // Without this test the app re-skins and the assessment pages do not - and
  // "default" quietly becomes a scheme of its own that nobody authored.
  it("matches globals.css value for value", () => {
    for (const token of PALETTE_TOKENS) {
      if (token === "assess-glow") continue; // not a globals token; guarded below
      expect(globals[token], `globals.css lost --${token}`).toBeDefined();
      expect(fallback.vars[token as PaletteToken].toLowerCase(), `--${token} has drifted`).toBe(
        globals[token].toLowerCase(),
      );
    }
  });

  // MUTATION: the glow literal is the one themed colour that lives inside a
  // component. Change it there and not here (or vice versa) and an unthemed quiz
  // and a default-themed quiz stop matching.
  it("keeps the promoted glow in step with both quiz components and the preview", () => {
    expect(fallback.vars["assess-glow"]).toBe(ASSESS_GLOW_FALLBACK);
    for (const path of [CLASSIC_QUIZ_PATH, DETERMINISTIC_QUIZ_PATH, PHONE_MINI_PATH]) {
      const source = read(path);
      expect(source, `${path} lost the glow token`).toContain(
        `var(--assess-glow,${ASSESS_GLOW_FALLBACK})`,
      );
      // The bare literal is GONE from the gradient: leaving it would mean an
      // unthemed page and a themed page were painting from two different facts.
      expect(source).not.toContain(`at_50%_0%,${ASSESS_GLOW_FALLBACK}`);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 4. Resolution: null, unknown, and the var map.
 * ------------------------------------------------------------------------- */

describe("resolving a stored value", () => {
  // MUTATION: this is the property the whole feature rests on. If null and
  // "default" ever diverge, applying 0079 changes how live campaigns look.
  it("treats null, undefined and \"default\" as the same scheme", () => {
    expect(paletteVars(null)).toEqual(paletteVars(DEFAULT_PALETTE_KEY));
    expect(paletteVars(undefined)).toEqual(paletteVars(DEFAULT_PALETTE_KEY));
    expect(paletteFor(null).key).toBe(DEFAULT_PALETTE_KEY);
    expect(paletteFor("")).toBe(PALETTES[0]);
  });

  // MUTATION: throw or return undefined here and a retired palette key - or a
  // hand-edited row - 500s a public, paid ad destination.
  it("falls back rather than failing on a key it does not know", () => {
    expect(paletteFor("retired-in-2027").key).toBe(DEFAULT_PALETTE_KEY);
    expect(paletteVars("retired-in-2027")).toEqual(paletteVars(DEFAULT_PALETTE_KEY));
    // ...while the lookup that is allowed to say "no" still says no.
    expect(paletteByKey("retired-in-2027")).toBeUndefined();
  });

  it("emits every token, prefixed, and nothing else", () => {
    for (const p of PALETTES) {
      const vars = paletteVars(p.key);
      expect(Object.keys(vars).sort()).toEqual(PALETTE_TOKENS.map((t) => `--${t}`).sort());
      for (const token of PALETTE_TOKENS) expect(vars[`--${token}`]).toBe(p.vars[token]);
    }
  });

  it("gives each named scheme a different map from the default", () => {
    const base = paletteVars(DEFAULT_PALETTE_KEY);
    for (const p of PALETTES.slice(1)) {
      expect(paletteVars(p.key), `${p.key} is a copy of the default`).not.toEqual(base);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 5. Legibility.
 * ------------------------------------------------------------------------- */

function channels(hex: string): [number, number, number] {
  const s = hex.replace("#", "");
  const full = s.length === 3 ? [...s].map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pairs that carry small text and must clear WCAG AA in every scheme. */
const AA_PAIRS: [PaletteToken, PaletteToken][] = [
  ["ink", "card"], // body copy on the question card
  ["muted", "card"], // helper lines under a question
  ["navy", "card"], // the question itself
  ["navy", "cream"], // headings that sit on the page, not the card
  ["blue-deep", "card"], // the small blue eyebrow
  ["blue-royal", "card"],
  ["card", "blue-dark"], // the label ON the filled primary button
  ["on-navy-muted", "navy"], // Guided's secondary copy, on its dark gradient
];

/**
 * Pairs the SHIPPED design already runs below AA on — quiet meta text, and
 * secondary copy on an inset surface. The bar for a new scheme is therefore the
 * shipped scheme, not a standard the product does not meet: no palette may be
 * less legible here than the one already in front of patients.
 */
const NO_WORSE_THAN_DEFAULT_PAIRS: [PaletteToken, PaletteToken][] = [
  ["faint", "card"],
  ["muted", "card-muted"],
];

describe("no scheme is less legible than the one that shipped", () => {
  it("computes contrast the way WCAG does", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#fff", "#000")).toBeCloseTo(21, 1);
  });

  // MUTATION: a hand-picked palette that looks lovely in a swatch row and puts
  // 3:1 grey on a tinted card is how a funnel loses answers it never sees.
  it("clears AA on every pair that carries small text", () => {
    for (const p of PALETTES) {
      for (const [fg, bg] of AA_PAIRS) {
        const ratio = contrast(p.vars[fg], p.vars[bg]);
        expect(ratio, `${p.key}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("is never worse than the default on the pairs the default already fails", () => {
    const base = PALETTES[0];
    for (const [fg, bg] of NO_WORSE_THAN_DEFAULT_PAIRS) {
      const floor = contrast(base.vars[fg], base.vars[bg]);
      for (const p of PALETTES.slice(1)) {
        const ratio = contrast(p.vars[fg], p.vars[bg]);
        expect(
          ratio,
          `${p.key}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1, below the shipped ${floor.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  });
});
