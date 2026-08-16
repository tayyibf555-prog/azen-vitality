// THE VALIDATOR THAT STANDS BETWEEN AN OWNER'S COLOUR PICKER AND A PUBLIC PAGE'S
// STYLESHEET.
//
// Everything in palette.ts is a colour a developer wrote and a reviewer read.
// Everything here is a colour somebody typed into a browser, and it ends up inside
// `style="--navy: <that string>"` on /assess/<client>/<slug> — a force-dynamic,
// paid ad destination. So this suite is written the way a security test is, not the
// way a formatting test is:
//
//   1. THE GRAMMAR IS THE INJECTION GUARD, so it is proved against hostile input
//      (a closing declaration, a url(), a </style>) and not only against typos.
//   2. THE AA GATE IS THE PRODUCT'S PROMISE, so a sub-AA map must be refused AND
//      the refusal must NAME the pair — an error that says "invalid" leaves an
//      owner guessing which of eighteen colours to move.
//   3. ALL FAILURES AT ONCE, because eighteen colours fixed one save at a time is
//      not a builder, it is a punishment.
//
// PURE, so every function here is called for real. Nothing is read as source text.

import { describe, it, expect } from "vitest";
import {
  CUSTOM_THEME_PREFIX,
  MAX_COLOUR_LENGTH,
  MAX_THEME_NAME,
  customPaletteFor,
  customThemePalette,
  customThemeRef,
  describeThemeFailures,
  isCustomThemeRef,
  normaliseThemeName,
  parseCustomThemeRef,
  readbackVars,
  validateThemeVars,
  type CustomTheme,
  type ThemeFailure,
} from "./custom-theme";
import { PALETTES, PALETTE_KEYS, PALETTE_TOKENS, swatchFromVars, type PaletteToken } from "./palette";
import { CONTRAST_TOKENS } from "./contrast";

/** A theme map that passes: one of the tuned presets, which the bar was written from. */
const GOOD = PALETTES.find((p) => p.key === "clinical-teal")!.vars;

function vars(over: Partial<Record<PaletteToken, unknown>>): Record<string, unknown> {
  return { ...GOOD, ...over };
}

function kinds(failures: readonly ThemeFailure[]): string[] {
  return failures.map((f) => f.kind);
}

const ID = "7f1d2c3b-4a5e-4f60-8b71-9c0d1e2f3a4b";

/* ---------------------------------------------------------------------------
 * 1. The stored reference.
 * ------------------------------------------------------------------------- */

describe("a custom theme is named in the column by a prefixed uuid", () => {
  it("round-trips", () => {
    expect(customThemeRef(ID)).toBe(`custom:${ID}`);
    expect(parseCustomThemeRef(customThemeRef(ID))).toBe(ID);
    expect(isCustomThemeRef(customThemeRef(ID))).toBe(true);
  });

  // MUTATION: accept `custom:` + anything and the id the page pulls out of a
  // campaign row — a value an owner could type — goes straight into a query.
  it("refuses a reference whose id is not a uuid", () => {
    for (const bad of [
      "custom:",
      "custom:../../etc",
      "custom:%27%20or%201=1",
      "custom:7f1d2c3b",
      `custom:${ID} `,
      `custom:${ID}extra`,
      "custom:00000000-0000-0000-0000-00000000000g",
    ]) {
      expect(parseCustomThemeRef(bad), `accepted ${bad}`).toBeNull();
      expect(isCustomThemeRef(bad)).toBe(false);
    }
  });

  // MUTATION: the two namespaces have to stay disjoint, or a preset key could
  // shadow a theme (or a deleted theme could resolve as a preset).
  it("never mistakes a preset key for a custom reference, or the reverse", () => {
    for (const key of PALETTE_KEYS) {
      expect(parseCustomThemeRef(key), `${key} read as a custom ref`).toBeNull();
      expect(key.includes(":"), `${key} could collide with the custom namespace`).toBe(false);
    }
    for (const other of [null, undefined, 7, {}, "", "default", ID]) {
      expect(parseCustomThemeRef(other)).toBeNull();
    }
    expect(CUSTOM_THEME_PREFIX).toBe("custom:");
  });
});

/* ---------------------------------------------------------------------------
 * 2. The grammar — the injection guard.
 * ------------------------------------------------------------------------- */

describe("a value that is not a colour literal never reaches the stylesheet", () => {
  // MUTATION: THE headline of this file. Every one of these is a string that would
  // be emitted verbatim into `style="--navy: ..."` on a public page. A validator
  // that "cleans" them, or that only checks for a leading #, ships a stylesheet an
  // ad visitor wrote.
  it("refuses hostile values, one failure each, naming the token", () => {
    const hostile: Record<string, string> = {
      closesDeclaration: "#fff; background: url(https://evil.test/x)",
      closesBlock: "red } body { display: none } .x {",
      styleTag: "</style><script>fetch('https://evil.test')</script>",
      url: "url(https://evil.test/pixel.gif)",
      expression: "expression(alert(1))",
      indirection: "var(--navy)",
      named: "rebeccapurple",
      importantHack: "#fff !important",
      comment: "#fff/*",
      newline: "#fff\n--x: url(evil)",
      unicodeEscape: "\\75 rl(evil)",
      calc: "calc(1px)",
      gradient: "linear-gradient(#fff,#000)",
      empty: "",
      spaceOnly: "   ",
      long: `#${"f".repeat(MAX_COLOUR_LENGTH + 8)}`,
    };
    for (const [label, value] of Object.entries(hostile)) {
      const result = validateThemeVars(vars({ navy: value }));
      expect(result.ok, `${label} (${value}) was accepted`).toBe(false);
      if (result.ok) continue;
      // Exactly one problem, on the token that has it — not a cascade.
      expect(result.failures, label).toHaveLength(1);
      const [failure] = result.failures;
      expect(["grammar", "missing"], label).toContain(failure.kind);
      if (failure.kind === "grammar" || failure.kind === "missing") {
        expect(failure.token, label).toBe("navy");
      }
      // ...and the message never echoes the payload unbounded.
      expect(describeThemeFailures(result.failures).length, label).toBeLessThan(200);
    }
  });

  it("accepts the forms a browser and this product both understand", () => {
    for (const value of ["#0b2049", "#FFF", "#0b204980", "rgb(1, 2, 3)", "rgba(91,196,247,0.20)"]) {
      // `assess-glow` is one of the tokens alpha is allowed on, so every form here
      // is legal there.
      const result = validateThemeVars(vars({ "assess-glow": value }));
      expect(result.ok, `rejected ${value}`).toBe(true);
    }
  });

  it("trims a pasted value rather than refusing it, and stores the trimmed form", () => {
    const result = validateThemeVars(vars({ "assess-glow": "  #0b2049  " }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.vars["assess-glow"]).toBe("#0b2049");
  });

  // MUTATION: iterate the SUBMITTED keys instead of the closed list and a theme
  // can carry a custom property no utility reads (dead colour that looks like
  // theming), or omit one and half-theme the page.
  it("requires exactly the closed token set, no more and no less", () => {
    const short = { ...GOOD } as Record<string, unknown>;
    delete short.ink;
    const missing = validateThemeVars(short);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(kinds(missing.failures)).toEqual(["missing"]);
      expect(describeThemeFailures(missing.failures)).toContain("--ink");
    }

    const extra = validateThemeVars({ ...GOOD, "brand-pink": "#ff00ff" });
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(kinds(extra.failures)).toEqual(["unknown"]);
      expect(describeThemeFailures(extra.failures)).toContain("brand-pink");
    }
  });

  it("treats a non-object as every token missing, rather than throwing", () => {
    for (const notAMap of [null, undefined, "clinical-teal", 7, [], ["#fff"]]) {
      const result = validateThemeVars(notAMap);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failures).toHaveLength(PALETTE_TOKENS.length);
    }
  });

  // MUTATION: report the first failure and an owner fixing a hand-built theme is
  // told about eighteen colours one save at a time.
  it("reports every bad value at once", () => {
    const result = validateThemeVars(vars({ navy: "navy", ink: "url(x)", muted: 7 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures).toHaveLength(3);
    const text = describeThemeFailures(result.failures);
    for (const token of ["--navy", "--ink", "--muted"]) expect(text).toContain(token);
  });
});

/* ---------------------------------------------------------------------------
 * 3. Alpha where contrast is measured.
 * ------------------------------------------------------------------------- */

describe("a token that carries text may not be see-through", () => {
  // MUTATION: allow alpha everywhere and the AA gate is defeated by a value that
  // PASSES it — rgba(0,0,0,0.02) scores 21:1 on its channels and renders as
  // nothing. This is the only colour-shaped way through the gate.
  it("refuses a translucent value on every measured token", () => {
    for (const token of CONTRAST_TOKENS) {
      const result = validateThemeVars(vars({ [token]: "rgba(0,0,0,0.02)" }));
      expect(result.ok, `${token} accepted a translucent value`).toBe(false);
      if (result.ok) continue;
      expect(kinds(result.failures), token).toEqual(["alpha"]);
      expect(describeThemeFailures(result.failures)).toContain(`--${token}`);
    }
  });

  it("catches the hex form of the same trick", () => {
    const result = validateThemeVars(vars({ ink: "#00000005" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(kinds(result.failures)).toEqual(["alpha"]);
  });

  // ...and leaves alpha alone where nothing is read off the colour. The glow is a
  // wash behind a card and is translucent in every shipped scheme.
  it("allows it on the tokens no text sits on", () => {
    const decorative = PALETTE_TOKENS.filter((t) => !CONTRAST_TOKENS.includes(t));
    expect(decorative.length).toBeGreaterThan(0);
    for (const token of decorative) {
      expect(validateThemeVars(vars({ [token]: "rgba(1,2,3,0.2)" })).ok, token).toBe(true);
    }
    expect(decorative).toContain("assess-glow");
  });
});

/* ---------------------------------------------------------------------------
 * 4. The AA gate.
 * ------------------------------------------------------------------------- */

describe("a theme less legible than the presets is refused, by name", () => {
  it("passes the five tuned presets unchanged", () => {
    for (const p of PALETTES.filter((x) => x.key !== "default" && x.key !== "landing-blue")) {
      expect(validateThemeVars(p.vars).ok, `${p.key} was refused`).toBe(true);
    }
  });

  // MUTATION: the whole point of B1. Drop the contrast pass and an owner can put
  // pale grey body copy on a pale card and never find out from the product.
  it("refuses body copy that cannot be read on the card", () => {
    const result = validateThemeVars(vars({ ink: "#c9dedb" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.failures)).toContain("contrast");
    const text = describeThemeFailures(result.failures);
    // NAMED: the pair, the ratio it scored, and the ratio it needed.
    expect(text).toContain("--ink on --card");
    expect(text).toMatch(/is \d+\.\d\d:1, below the 4\.5:1 minimum/);
  });

  // MUTATION: gate on the AA table alone and this pair is never measured — the
  // inset surface every input and the progress track uses.
  it("measures secondary copy on the inset surface, not only on the card", () => {
    const result = validateThemeVars(vars({ "card-muted": "#4a6f6b" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(describeThemeFailures(result.failures)).toContain("--muted on --card-muted");
  });

  // MUTATION: gate on the bold table alone and THIS pair is never measured — the
  // label on the one button the whole funnel turns on.
  it("measures the label on the primary button", () => {
    const result = validateThemeVars(vars({ "blue-dark": "#a8e6df" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(describeThemeFailures(result.failures)).toContain("--card on --blue-dark");
  });

  it("holds meta text to 3:1 rather than 4.5:1, and says which", () => {
    const result = validateThemeVars(vars({ faint: "#b6dcd7" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = describeThemeFailures(result.failures);
      expect(text).toContain("--faint on --card");
      expect(text).toContain("below the 3:1 minimum");
    }
  });

  // MUTATION: run contrast before grammar and "your --muted is not a colour"
  // arrives buried under six contrast failures that are all that same fact.
  it("does not report contrast at all while a measured token is unreadable", () => {
    const result = validateThemeVars(vars({ muted: "not-a-colour" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(kinds(result.failures)).toEqual(["grammar"]);
  });
});

/* ---------------------------------------------------------------------------
 * 5. The name.
 * ------------------------------------------------------------------------- */

describe("the theme's name is a label, and is treated as one", () => {
  it("collapses whitespace, strips control characters and caps the length", () => {
    expect(normaliseThemeName("  Practice   brand  ")).toBe("Practice brand");
    expect(normaliseThemeName("Two\nlines")).toBe("Two lines");
    expect(normaliseThemeName("a".repeat(200))).toHaveLength(MAX_THEME_NAME);
  });

  it("has no name for blank input, or for input that is not a string", () => {
    for (const bad of ["", "   ", "\n\t", null, undefined, 7, {}]) {
      expect(normaliseThemeName(bad), `accepted ${String(bad)}`).toBeNull();
    }
  });
});

/* ---------------------------------------------------------------------------
 * 6. Wearing it: the Palette projection.
 * ------------------------------------------------------------------------- */

describe("a stored theme becomes a Palette like any preset", () => {
  const theme: CustomTheme = {
    id: ID,
    clientId: "vitality",
    name: "Practice brand",
    vars: GOOD,
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
  };

  // MUTATION: hand-pick the chips here and the "Your themes" group shows three
  // colours the preset row above it derives differently — the second copy of the
  // palette this module exists to avoid.
  it("derives its chips with the same function definePalette uses", () => {
    const palette = customThemePalette(theme);
    expect(palette.swatch).toEqual(swatchFromVars(GOOD));
    expect(palette.swatch).toEqual([GOOD["blue-royal"], GOOD["blue-light"], GOOD.cream]);
    expect(palette.key).toBe(customThemeRef(ID));
    expect(palette.label).toBe("Practice brand");
    expect(palette.vars).toBe(GOOD);
  });

  it("resolves a stored key against the practice's own themes, and nothing else", () => {
    expect(customPaletteFor(customThemeRef(ID), [theme])?.label).toBe("Practice brand");
    // A preset key is not a custom theme...
    expect(customPaletteFor("clinical-teal", [theme])).toBeNull();
    // ...and neither is a theme this practice does not have (deleted, or another
    // practice's id). The caller falls back to the catalogue, which is what the
    // public page does.
    expect(customPaletteFor(customThemeRef("00000000-0000-4000-8000-000000000000"), [theme])).toBeNull();
    expect(customPaletteFor(null, [theme])).toBeNull();
    expect(customPaletteFor(customThemeRef(ID), [])).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 7. The read-back check.
 * ------------------------------------------------------------------------- */

describe("the grammar is checked again on the way OUT of the database", () => {
  // MUTATION: trust the row. The write path validated it, but a hand-edited row, a
  // restored backup or a later migration are all ways a value changes without
  // going through the write path — and this read is the last thing before a public
  // page's style attribute.
  it("returns the map for a good row and null for a tampered one", () => {
    expect(readbackVars(GOOD)).toEqual(GOOD);
    expect(readbackVars({ ...GOOD, navy: "#fff; background: url(evil)" })).toBeNull();
    expect(readbackVars({ ...GOOD, navy: null })).toBeNull();
    const short = { ...GOOD } as Record<string, unknown>;
    delete short.cream;
    expect(readbackVars(short)).toBeNull();
    for (const notAMap of [null, undefined, "x", 7, []]) expect(readbackVars(notAMap)).toBeNull();
  });

  // ...but NOT contrast. A theme that has slipped below AA is a thing to fix in
  // the builder; blanking a running campaign's colours over it would be worse than
  // a slightly low ratio. A value that is not a colour is different in kind.
  it("does not re-run the AA gate at read time", () => {
    const dim = { ...GOOD, faint: "#b6dcd7" };
    expect(validateThemeVars(dim).ok).toBe(false);
    expect(readbackVars(dim)).toEqual(dim);
  });
});
