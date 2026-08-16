// THE CONTRAST LIB, held on its own — because it stopped being a test helper and
// became a RUN-TIME GATE.
//
// While these functions lived inside palette.test.ts they were exercised only by
// the seven authored palettes, and that was enough: if the maths were wrong, a
// hand-tuned palette would have failed a threshold it should have passed and
// somebody would have noticed on the way in. Now the same functions decide whether
// a colour an owner typed into a browser is allowed onto a public, paid ad
// destination. That is a different job with a different failure mode — a function
// that is quietly too GENEROUS never fails anything, and nobody notices at all.
//
// So this file pins three things the catalogue cannot:
//   1. the maths, against WCAG's own worked numbers;
//   2. the reader, against colour forms no preset uses (rgb(), #rrggbbaa) and
//      against junk, where fail-CLOSED is the only safe answer;
//   3. the thresholds themselves, spelled out, so that "relax the bar until the
//      theme passes" is a diff a reviewer sees rather than a number that moved.

import { describe, it, expect } from "vitest";
import {
  AA_SMALL_TEXT_PAIRS,
  BOLD_TINT_PAIRS,
  CONTRAST_TOKENS,
  CUSTOM_THEME_PAIRS,
  colourChannels,
  contrast,
  mergePairs,
  contrastFailures,
  describeContrastFailure,
  hasAlphaChannel,
  isColourLiteral,
  relativeLuminance,
} from "./contrast";
import { PALETTES, PALETTE_TOKENS, type PaletteToken } from "./palette";

/* ---------------------------------------------------------------------------
 * 1. The maths.
 * ------------------------------------------------------------------------- */

describe("contrast is WCAG's ratio, not an approximation of it", () => {
  it("puts black on white at 21:1 and a colour on itself at 1:1", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1); // order-independent
    expect(contrast("#16559a", "#16559a")).toBeCloseTo(1, 5);
  });

  it("expands three-digit hex the way a browser does", () => {
    expect(contrast("#fff", "#000")).toBeCloseTo(21, 1);
    expect(relativeLuminance("#fff")).toBeCloseTo(relativeLuminance("#ffffff"), 10);
  });

  // MUTATION: drop the sRGB gamma step (use the raw channel as luminance) and mid
  // greys move by a whole ratio point — enough to pass a palette that WCAG fails.
  it("applies the sRGB transfer curve", () => {
    // #767676 on white is the textbook 4.48:1 — just under AA, which is exactly
    // why it is the number worth pinning.
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 1);
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2159, 3);
  });

  it("is symmetric for every ordered pair a palette actually holds", () => {
    for (const p of PALETTES) {
      for (const [fg, bg] of CUSTOM_THEME_PAIRS) {
        expect(contrast(p.vars[fg], p.vars[bg])).toBeCloseTo(contrast(p.vars[bg], p.vars[fg]), 10);
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. Reading a colour — including the forms the catalogue never uses.
 * ------------------------------------------------------------------------- */

describe("the reader accepts exactly the two literal forms", () => {
  it("reads hex in all three lengths, and rgb()/rgba()", () => {
    expect(colourChannels("#000000")).toEqual([0, 0, 0]);
    expect(colourChannels("#fff")).toEqual([1, 1, 1]);
    expect(colourChannels("#ffffff80")).toEqual([1, 1, 1]); // alpha dropped, not composited
    expect(colourChannels("rgb(255, 255, 255)")).toEqual([1, 1, 1]);
    expect(colourChannels("rgba(0,0,0,0.5)")).toEqual([0, 0, 0]);
    expect(colourChannels("#FFF")).toEqual([1, 1, 1]); // case-insensitive
  });

  // MUTATION: the whole point of the lib. A named colour, a var() indirection or
  // a CSS function is NOT a colour this product stores, and treating one as
  // unreadable-but-fine would let it through the theme validator.
  it("refuses anything that is not one of those two", () => {
    for (const bad of [
      "navy",
      "var(--navy)",
      "url(https://evil.test/x.png)",
      "#gggggg",
      "#0b204",
      "rgb(1,2)",
      "rgb(1,2,3,4,5)",
      "hsl(200, 50%, 50%)",
      "",
      "  ",
      "#fff;background:red",
      "</style><script>",
    ]) {
      expect(colourChannels(bad), `read ${bad}`).toBeNull();
      expect(isColourLiteral(bad), `accepted ${bad}`).toBe(false);
    }
    for (const notAString of [null, undefined, 7, {}, ["#fff"]]) {
      expect(isColourLiteral(notAString)).toBe(false);
    }
  });

  // MUTATION: the grammar allows up to three digits per channel, so without this
  // range check rgb(999,0,0) parses and scores a luminance above 1.
  it("refuses an out-of-range channel that the grammar alone would allow", () => {
    expect(colourChannels("rgb(256,0,0)")).toBeNull();
    expect(colourChannels("rgb(999,999,999)")).toBeNull();
    expect(colourChannels("rgb(255,0,0)")).not.toBeNull();
  });

  // MUTATION: return 21 (or NaN, which every `< min` comparison reads as "pass")
  // for junk and the gate stops being a gate: an unparseable value would clear
  // every threshold in the file.
  it("scores junk 0, which is below every threshold there is", () => {
    expect(contrast("url(evil)", "#ffffff")).toBe(0);
    expect(contrast("#ffffff", "not-a-colour")).toBe(0);
    expect(Number.isNaN(relativeLuminance("nope"))).toBe(true);
  });

  it("knows which values carry alpha", () => {
    expect(hasAlphaChannel("#ffffff80")).toBe(true);
    expect(hasAlphaChannel("rgba(0,0,0,0.5)")).toBe(true);
    expect(hasAlphaChannel("rgba(0,0,0,1)")).toBe(true); // rgba(...,1) is still four args
    expect(hasAlphaChannel("#ffffff")).toBe(false);
    expect(hasAlphaChannel("#fff")).toBe(false);
    expect(hasAlphaChannel("rgb(0,0,0)")).toBe(false);
    expect(hasAlphaChannel("url(evil)")).toBe(false); // not a colour at all
  });
});

/* ---------------------------------------------------------------------------
 * 3. The bar. Spelled out, because a threshold that quietly moves is the one
 *    failure this whole feature cannot detect from the outside.
 * ------------------------------------------------------------------------- */

describe("the thresholds are pinned, not merely referenced", () => {
  // MUTATION: lower 4.5 to 3.0 "so the owner's brand colour fits" and every
  // suite in the repo stays green while the product ships an unreadable funnel.
  it("holds small text at AA and meta text at 3:1", () => {
    expect([...AA_SMALL_TEXT_PAIRS]).toEqual([
      ["ink", "card", 4.5],
      ["muted", "card", 4.5],
      ["navy", "card", 4.5],
      ["navy", "cream", 4.5],
      ["blue-deep", "card", 4.5],
      ["blue-royal", "card", 4.5],
      ["card", "blue-dark", 4.5],
      ["on-navy-muted", "navy", 4.5],
    ]);
    expect([...BOLD_TINT_PAIRS]).toEqual([
      ["ink", "card", 4.5],
      ["muted", "card", 4.5],
      ["muted", "card-muted", 4.5],
      ["faint", "card", 3.0],
      ["blue-deep", "card", 4.5],
      ["navy", "card", 4.5],
    ]);
  });

  // MUTATION: gate a custom theme on ONE of the tables and a real hole opens —
  // the AA table never looks at --card-muted (every input and the progress
  // track), the bold table never looks at --blue-dark (the label on the primary
  // button). The union is the promise: your theme clears what our presets clear.
  it("gates a custom theme on the union of both tables, deduplicated", () => {
    const keys = CUSTOM_THEME_PAIRS.map(([fg, bg]) => `${fg}|${bg}`);
    expect(new Set(keys).size, "the merged table repeats a pair").toBe(keys.length);
    for (const [fg, bg, min] of [...AA_SMALL_TEXT_PAIRS, ...BOLD_TINT_PAIRS]) {
      const merged = CUSTOM_THEME_PAIRS.find((p) => p[0] === fg && p[1] === bg);
      expect(merged, `${fg} on ${bg} was dropped by the merge`).toBeTruthy();
      // ...and never at a LOWER bar than either table asked for.
      expect(merged![2]).toBeGreaterThanOrEqual(min);
    }
    // Both holes named above are closed.
    expect(keys).toContain("muted|card-muted");
    expect(keys).toContain("card|blue-dark");
  });

  // MUTATION: keep the WEAKER bar when a pair appears in both tables and a pair
  // listed at 3.0 in one and 4.5 in the other silently becomes a 3.0 pair.
  //
  // Called directly, with a conflict the real tables do not currently contain:
  // every pair they share carries the same 4.5, so this line is unobservable from
  // the merged output today and would go on being unobservable right up until the
  // day it mattered. The rule is about what happens NEXT time a table is edited.
  it("keeps the stricter bar when the two tables disagree about a pair", () => {
    const merged = mergePairs(
      [["ink", "card", 3.0]],
      [["ink", "card", 4.5]],
    );
    expect(merged).toEqual([["ink", "card", 4.5]]);
    // ...and in the other argument order, so it is the threshold that decides and
    // not which table was passed first.
    expect(mergePairs([["ink", "card", 4.5]], [["ink", "card", 3.0]])).toEqual([
      ["ink", "card", 4.5],
    ]);
    // A pair only one table has survives untouched.
    expect(mergePairs([["ink", "card", 4.5]], [["faint", "card", 3.0]])).toHaveLength(2);
  });

  // MUTATION: a custom theme's bar has to be one the product itself meets, or the
  // feature is holding owners to a standard it does not hold itself to. The FIVE
  // TUNED schemes clear it outright — those are the ones this bar was written from.
  it("is a bar every tuned preset already clears", () => {
    const tuned = PALETTES.filter((p) => p.key !== "default" && p.key !== "landing-blue");
    expect(tuned).toHaveLength(5);
    for (const p of tuned) {
      expect(contrastFailures(p.vars), `${p.key} fails its own product's gate`).toEqual([]);
    }
  });

  // AND THE TWO THAT DO NOT, NAMED — because this is the most surprising fact in
  // the feature and it must not be discovered by an owner instead.
  //
  // `default` is a verbatim copy of globals.css and `landing-blue` is the byte
  // source of the `.vd-landing` block every bespoke landing page emits, so neither
  // can be re-tuned; palette.test.ts holds them to "no worse than the shipped
  // design" on exactly these two pairs instead. A brand-new custom theme has no
  // such history to protect, so it gets the real bar — which means an owner cannot
  // hand-build a theme identical to the app's own colours. That is the right way
  // round: the exception is grandfathered, not offered.
  //
  // MUTATION: drop the two legacy pairs from the merged table "so default passes"
  // and every custom theme silently loses the inset-surface and meta-text floors.
  it("is stricter than the two byte-locked legacy schemes manage", () => {
    // Exactly which pairs each one misses, so a brand tweak in globals.css that
    // made the app LESS legible would show up here as a third entry rather than
    // as nothing at all. landing-blue's --card-muted is near-white, so it clears
    // the inset-surface pair the app itself does not.
    const known: Record<string, string[]> = {
      default: ["faint|card", "muted|card-muted"],
      "landing-blue": ["faint|card"],
    };
    for (const [key, pairs] of Object.entries(known)) {
      const palette = PALETTES.find((p) => p.key === key)!;
      const failed = contrastFailures(palette.vars).map((f) => `${f.fg}|${f.bg}`);
      expect(failed.sort(), `${key} drifted off its known pairs`).toEqual(pairs);
    }
  });

  it("derives the measured tokens from the table rather than listing them", () => {
    // Every token in the table is measured...
    for (const [fg, bg] of CUSTOM_THEME_PAIRS) {
      expect(CONTRAST_TOKENS).toContain(fg);
      expect(CONTRAST_TOKENS).toContain(bg);
    }
    // ...and nothing else is. The glow is the clearest case: it is a wash behind
    // a card, nobody reads text off it, and it is the one token a scheme legitimately
    // makes translucent.
    expect(CONTRAST_TOKENS).not.toContain("assess-glow");
    expect(CONTRAST_TOKENS.every((t) => (PALETTE_TOKENS as readonly string[]).includes(t))).toBe(true);
    expect([...CONTRAST_TOKENS].sort()).toEqual(
      ["blue-dark", "blue-deep", "blue-royal", "card", "card-muted", "cream", "faint", "ink", "muted", "navy", "on-navy-muted"].sort(),
    );
  });
});

/* ---------------------------------------------------------------------------
 * 4. Judging a whole map.
 * ------------------------------------------------------------------------- */

describe("contrastFailures reports every failing pair, and names it", () => {
  /**
   * A TUNED palette with some tokens overridden — clinical-teal, not entry one.
   * The default scheme is one of the two that predate this bar and fails it on two
   * pairs by design (above), so building fixtures on it would mean every assertion
   * here had to subtract that noise first.
   */
  const BASE = PALETTES.find((p) => p.key === "clinical-teal")!;
  function vars(over: Partial<Record<PaletteToken, string>>): Record<PaletteToken, string> {
    return { ...BASE.vars, ...over };
  }

  it("is empty for a palette that passes", () => {
    expect(contrastFailures(vars({}))).toEqual([]);
  });

  // MUTATION: return on the first failure and an owner fixing a theme is told
  // about one broken pair per save — the flow-validate lesson, restated.
  it("reports ALL of them, not the first", () => {
    // A near-white ink AND a near-white muted on a near-white card.
    const failures = contrastFailures(vars({ ink: "#fafafa", muted: "#f5f5f5" }));
    const pairs = failures.map((f) => `${f.fg}|${f.bg}`);
    expect(pairs).toContain("ink|card");
    expect(pairs).toContain("muted|card");
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  it("carries the ratio and the bar, so the message can name both", () => {
    const [failure] = contrastFailures(vars({ ink: "#ffffff" }), [["ink", "card", 4.5]]);
    expect(failure.fg).toBe("ink");
    expect(failure.bg).toBe("card");
    expect(failure.min).toBe(4.5);
    expect(failure.ratio).toBeLessThan(4.5);
    expect(describeContrastFailure(failure)).toMatch(
      /^--ink on --card is \d+\.\d\d:1, below the 4\.5:1 minimum$/,
    );
  });

  // MUTATION: score a missing token 0 and "you left out --ink" arrives as six
  // contrast failures that are all the same fact, burying the one that is useful.
  it("stays quiet about a token that is absent, which is somebody else's failure", () => {
    const incomplete = { ...PALETTES[0].vars } as Partial<Record<PaletteToken, string>>;
    delete incomplete.ink;
    expect(contrastFailures(incomplete).some((f) => f.fg === "ink")).toBe(false);
  });

  // MUTATION: the alpha hole. rgba(0,0,0,0.02) renders as nothing and scores 21:1
  // on its channels alone, so contrast maths ALONE cannot refuse it. This asserts
  // the hole exists here (it is closed by the validator, which requires opacity on
  // every CONTRAST_TOKEN) so that nobody later "simplifies" that rule away.
  it("cannot see through alpha, which is why the validator forbids it where it counts", () => {
    expect(contrastFailures(vars({ ink: "rgba(0,0,0,0.02)" }))).toEqual([]);
    expect(hasAlphaChannel("rgba(0,0,0,0.02)")).toBe(true);
    expect(CONTRAST_TOKENS).toContain("ink");
  });
});
