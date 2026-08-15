// THE LANDING SEAM: the bespoke landing pages and the Smile Assessment funnel
// paint from one colour catalogue, and this suite is what makes that safe.
//
// Why it is worth a file of its own. This stylesheet ships RAW to the browser
// inside a `<style dangerouslySetInnerHTML>` on four public, ad-funded pages
// (invisalign, bonding, hygiene, and the shared treatment template that backs
// the other four templates). There is no build step between the string this
// module exports and the CSS a patient's browser parses. So two properties
// matter and neither is checked by anything else:
//
//   1. THE VALUES. The block used to be hand-written here. It is now emitted
//      from lib/assess/palette.ts, and "no visual change" is only true while
//      every emitted colour equals the one the design was ported with. The
//      checked-in expected literal below is the pre-seam bytes.
//   2. THE FORMAT. A CSS string is not a data structure; it is the artefact.
//      Re-wrapping it, alphabetising it, or putting a space after a colon would
//      not change a pixel but WOULD make the next diff of a public page
//      unreviewable. The format is therefore asserted, not merely relied upon.
//
// The test imports the module rather than reading the file (reveal-on-scroll.
// test.ts:5 already does), so it asserts the string that actually ships,
// interpolation and all — not a source file that happens to look right.

import { describe, it, expect } from "vitest";
import { paletteCssBlock, paletteFor, type PaletteToken } from "@/lib/assess/palette";
import { VITALITY_INVISALIGN_CSS } from "./vitality-invisalign-landing.styles";

/**
 * THE CONTRACT, CHECKED IN. Byte-for-byte what `.vd-landing`'s token block held
 * before the catalogue owned it — hand-wrapped, grouped by meaning, two-space
 * indent, no space after the colon, `"; "` between declarations on a line.
 *
 * Written as lines rather than one template literal on purpose: the LINE
 * GROUPING is half the contract, and a reordered emitter template must be
 * visibly red here rather than a wall-of-text diff.
 */
const EXPECTED_BLOCK = [
  "  --navy:#0b2049; --chrome-from:#082249; --chrome-mid:#0f3670; --chrome-to:#16559a;",
  "  --blue:#16559a; --blue-deep:#1a648f; --blue-light:#5bc4f7; --blue-royal:#16559a;",
  "  --frame:#c3d7ef; --blue-soft:#eef4fb; --blue-chip:#dce9fb;",
  "  --light:#f2f7fd; --panel:#ffffff; --panel-2:#f7fafe;",
  "  --tx:#16233f; --tx-soft:#53607c; --tx-faint:#8b96ad;",
  "  --line:#e2e9f4;",
  "  --tx-on:#eaf1fb; --tx-on-soft:#a9c1e2; --line-d:rgba(255,255,255,.11);",
].join("\n");

/**
 * The landing design's name for a colour -> the catalogue's name for it. Held
 * here independently of the emitter's own table, so this is a comparison of two
 * sources rather than a module agreeing with itself.
 */
const CATALOGUE_BACKED: Readonly<Record<string, PaletteToken>> = {
  navy: "navy",
  blue: "blue-dark", // the landing design fills every button with one blue
  "blue-deep": "blue-deep",
  "blue-light": "blue-light",
  "blue-royal": "blue-royal",
  "blue-soft": "tint-royal",
  "blue-chip": "tint-royal-line",
  light: "cream",
  panel: "card",
  "panel-2": "card-muted",
  tx: "ink",
  "tx-soft": "muted",
  "tx-faint": "faint",
  line: "line",
  "tx-on-soft": "on-navy-muted",
};

/**
 * The declarations in the block that NO scheme themes: the landing design's own,
 * with no catalogue counterpart. They ride inside the emitted block, so they are
 * exactly as capable of drifting as the themed ones and are pinned the same way.
 */
const PASSENGERS: Readonly<Record<string, string>> = {
  "chrome-from": "#082249",
  "chrome-mid": "#0f3670",
  "chrome-to": "#16559a",
  frame: "#c3d7ef",
  "tx-on": "#eaf1fb",
  "line-d": "rgba(255,255,255,.11)",
};

const BLOCK_OPEN = ".vd-landing{\n";
const BLOCK_CLOSE = "\n  --r:16px;";

/** The token block as it actually ships, sliced out of the emitted stylesheet. */
function shippedBlock(): string {
  const start = VITALITY_INVISALIGN_CSS.indexOf(BLOCK_OPEN);
  expect(start, "the stylesheet no longer opens with a .vd-landing{ block").toBeGreaterThan(-1);
  const end = VITALITY_INVISALIGN_CSS.indexOf(BLOCK_CLOSE, start);
  expect(end, "--r:16px no longer follows the token block").toBeGreaterThan(start);
  return VITALITY_INVISALIGN_CSS.slice(start + BLOCK_OPEN.length, end);
}

/**
 * Every `--name:value;` in a block.
 *
 * NOT the `^`-anchored pattern palette.test.ts:163 uses on globals.css. That one
 * is written for a stylesheet with one declaration per line; this block puts
 * three and four on a line, and anchored it would silently read only the first
 * of each — a drift guard that checks a third of the colours and passes.
 */
function declarations(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+):([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 1. The emitted bytes.
 * ------------------------------------------------------------------------- */

describe("the .vd-landing token block is emitted, not authored", () => {
  // MUTATION: change one hex in the catalogue and this is the assertion that
  // goes red. Everything downstream (the stylesheet, the shipped-block slice)
  // is generated from the same source and would agree with the mistake; only a
  // literal checked in beside it can disagree.
  it("reproduces the design's hand-wrapped block byte-for-byte", () => {
    expect(paletteCssBlock("landing-blue")).toBe(EXPECTED_BLOCK);
  });

  // MUTATION: interpolate it in the wrong place, or leave the old literal behind
  // as well, and the block stops being where `--r` and the reset expect it.
  it("ships that exact block, in place, between the selector and --r", () => {
    expect(shippedBlock()).toBe(EXPECTED_BLOCK);
  });

  it("holds the format the design was ported in", () => {
    for (const line of paletteCssBlock("landing-blue").split("\n")) {
      expect(line, "two-space indent").toMatch(/^ {2}--/);
      expect(line, "no trailing whitespace").toBe(line.trimEnd());
      expect(line, "line ends on a semicolon").toMatch(/;$/);
      expect(line, "no space after the colon").not.toMatch(/:\s/);
      expect(line, "lowercase throughout").toBe(line.toLowerCase());
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. The drift guard.
 * ------------------------------------------------------------------------- */

describe("the shipped block and the catalogue are one fact", () => {
  const shipped = shippedBlock();
  const parsed = declarations(shipped);
  const palette = paletteFor("landing-blue");

  // If the regex silently matched nothing, every loop below would pass on an
  // empty set - a green suite guarding nothing at all.
  it("parsed the block at all", () => {
    expect(Object.keys(parsed).length).toBe(21);
    expect(parsed.navy).toBe("#0b2049");
    expect(parsed["line-d"]).toBe("rgba(255,255,255,.11)");
    // Proof the pattern reads past the first declaration on a line: --chrome-to
    // is fourth on line one, and --tx-faint is third on line five.
    expect(parsed["chrome-to"]).toBe("#16559a");
    expect(parsed["tx-faint"]).toBe("#8b96ad");
  });

  // MUTATION: re-hand-edit a colour into the stylesheet, or nudge one in the
  // catalogue. Either way the ad's landing page and the quiz it links to stop
  // being the same blue, on live traffic, with nothing to notice it.
  it("gives every themed declaration the catalogue's value", () => {
    for (const [cssName, token] of Object.entries(CATALOGUE_BACKED)) {
      expect(parsed[cssName], `--${cssName} is missing from the block`).toBeDefined();
      expect(parsed[cssName].toLowerCase(), `--${cssName} has drifted from --${token}`).toBe(
        palette.vars[token].toLowerCase(),
      );
    }
  });

  it("leaves the design's own untokened colours exactly as authored", () => {
    for (const [cssName, value] of Object.entries(PASSENGERS)) {
      expect(parsed[cssName], `--${cssName} lost its literal`).toBe(value);
    }
  });

  it("emits those two sets and nothing else", () => {
    expect(Object.keys(parsed).sort()).toEqual(
      [...Object.keys(CATALOGUE_BACKED), ...Object.keys(PASSENGERS)].sort(),
    );
  });

  // MUTATION: the emitter is generic over the key. Hard-code the strings inside
  // it and every assertion above still passes — this is the one that does not.
  it("actually reads the scheme it is handed", () => {
    const teal = paletteCssBlock("clinical-teal");
    expect(teal).toContain(`--light:${paletteFor("clinical-teal").vars.cream}`);
    expect(teal).not.toContain("--light:#f2f7fd");
    // ...while the passengers, which no scheme themes, do not move. This is the
    // documented half-theme, pinned so nobody mistakes it for a second skin.
    expect(teal).toContain("--chrome-from:#082249");
  });
});

/* ---------------------------------------------------------------------------
 * 3. What the seam must NOT reach.
 * ------------------------------------------------------------------------- */

describe("the seam stops where the catalogue stops", () => {
  // MUTATION: emit the catalogue's whole token map and `line-strong` lands in a
  // public stylesheet. It is a DERIVED value that exists only for the quiz's
  // input borders; no rule under .vd-landing reads it, so it would be a colour
  // in the payload that nothing paints, and a false claim that the design has a
  // second hairline.
  it("never writes the catalogue-only hairline into the CSS", () => {
    expect(paletteCssBlock("landing-blue")).not.toContain("line-strong");
    expect(VITALITY_INVISALIGN_CSS).not.toContain("--line-strong");
  });

  // The other two catalogue tokens with no counterpart here.
  it("writes neither the status ink nor the glow", () => {
    const block = paletteCssBlock("landing-blue");
    expect(block).not.toContain("status-royal");
    expect(block).not.toContain("assess-glow");
  });

  // MUTATION: "fold the hero glow into the seam too." It is not a custom
  // property — it is a literal inside a gradient, written with a leading-dot
  // alpha the catalogue does not use, and a later rule replaces the whole
  // gradient at a different strength. Both literals stay hand-authored here.
  it("leaves both hero-glow literals untouched, at their two strengths", () => {
    expect(VITALITY_INVISALIGN_CSS).toContain("radial-gradient(circle,rgba(91,196,247,.20)");
    expect(VITALITY_INVISALIGN_CSS).toContain("rgba(91,196,247,.26)");
    // The catalogue's own glow string is a different byte sequence, and must not
    // have been "helpfully" substituted into the stylesheet.
    expect(VITALITY_INVISALIGN_CSS).not.toContain("rgba(91,196,247,0.20)");
  });

  // MUTATION: extend the emitted block past `--r` and it swallows the second
  // hand-authored `.vd-landing{` block's tokens (the premium pass's shadows,
  // faces and border), none of which the catalogue knows about.
  it("leaves the second .vd-landing token block hand-authored", () => {
    expect(VITALITY_INVISALIGN_CSS.split(".vd-landing{").length - 1).toBe(2);
    expect(VITALITY_INVISALIGN_CSS).toContain("  --vd-border:#e7ecf5;");
    expect(paletteCssBlock("landing-blue")).not.toContain("vd-border");
  });
});
