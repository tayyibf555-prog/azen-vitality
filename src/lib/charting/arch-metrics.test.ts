import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  archAvailableAtViewport,
  archAvailableWidth,
  archChrome,
  archMaxWidth,
  archMinWidth,
  archPreferredWidth,
  archRenderedWidth,
  archScrolls,
  archScrollsAtViewport,
  archSideAir,
  CARD_CHROME,
  chartWidthFor,
  CROWN_ASPECT,
  DENTALLY,
  END_W,
  GAP,
  gapFraction,
  GRID_ASPECT,
  HAIRLINE_MAX_FRACTION,
  HARD_MIN_TOOTH,
  MAX_TOOTH,
  MIN_TOOTH,
  MIN_VIEWPORT,
  PAGE_CHROME,
  PANEL_FRACTION,
  PANEL_MAX,
  PANEL_MIN,
  PANEL_RAIL,
  panelWidth,
  toothColumnWidth,
  WORKSPACE_GAP,
} from "./arch-metrics";

/**
 * The owner's complaint, as arithmetic.
 *
 * "look at dentallys chart how its easy to read across the entire site you make
 * everything small it should be bigger" — and the first build had 26px columns
 * against Dentally's measured 88px. These assertions exist so that verdict cannot
 * quietly be re-earned: a contributor who trims a size to fit something else fails
 * here rather than in a surgery.
 */

/** The permanent arch. Sixteen columns is the number every other row is laid out
 *  in, including the ten-tooth deciduous rows, which nest inside it. */
const COLUMNS = 16;

/** Between the floor and the ceiling — the band in which the columns still divide
 *  whatever they are given. Anything in here is the fluid case. */
const FLUID = [1100, 1200, 1306, 1400, 1457, 1490];

describe("the arch fills the width it is given, up to the cap", () => {
  it("divides its available width between the columns, leaving nothing over", () => {
    for (const available of FLUID) {
      const tooth = toothColumnWidth(available, COLUMNS);
      // Everything laid out end to end is exactly the width it was given. Air
      // appearing HERE would be the small chart floating in whitespace that the
      // owner rejected first; air only appears once the cap has bitten.
      expect(archChrome(COLUMNS) + COLUMNS * tooth).toBeCloseTo(available, 6);
      expect(archSideAir(available, COLUMNS)).toBe(0);
    }
  });

  it("grows with the screen instead of sitting at one fixed size", () => {
    const narrow = toothColumnWidth(1100, COLUMNS);
    const wide = toothColumnWidth(1400, COLUMNS);
    expect(wide).toBeGreaterThan(narrow);
    // ...and neither end of that band is pinned to a bound, or "grows" would be
    // true of a layout that is really just two fixed sizes.
    expect(narrow).toBeGreaterThan(MIN_TOOTH);
    expect(wide).toBeLessThan(MAX_TOOTH);
  });
});

/**
 * THE DRAWING STOPS GROWING. The owner's second verdict, after putting our screen
 * beside the reference again: "it should fill the screen like this but still the
 * actual chart still needs to be smaller like dentallys".
 *
 * Those read as contradictory and are not. The CARD fills the screen; the ARCH stops
 * at the reference measure and centres in what is left. Only the first was true: the
 * columns were `minmax(0, 1fr)`, which has a floor and no ceiling, so they absorbed
 * every pixel the full-bleed record handed them — and because the crown is drawn at a
 * fixed 75/85 aspect, an uncapped width was an uncapped HEIGHT too.
 *
 * These assertions are written against MAX_TOOTH rather than against 88 on purpose:
 * 88 is one measurement off one screenshot at one zoom, so the cap is a knob the owner
 * may still want moved, and moving it must not mean rewriting a test suite.
 */
describe("the drawing stops at the cap, however wide the screen gets", () => {
  it("never exceeds the cap at 1920, at 2560, or at something absurd", () => {
    // Full-bleed chart widths: the record now carries data-wide on every tab, so
    // these are close to the whole viewport rather than to a panelled-off column.
    // 1864 is the measured container at a 1920 viewport.
    for (const available of [1864, 2504, 3784, 10_000, Number.MAX_SAFE_INTEGER]) {
      expect(toothColumnWidth(available, COLUMNS)).toBe(MAX_TOOTH);
    }
  });

  it("is the fix for the 30%-over column the owner was looking at", () => {
    // What the unbounded `1fr` produced at a 1920 viewport: the same arithmetic
    // without the ceiling. Measured in the live DOM at 114.63px; this module's own
    // division of the same container gives ~111px. Either way it is far past the
    // reference, which is the complaint.
    const fullBleedAt1920 = 1864;
    const unbounded = (fullBleedAt1920 - archChrome(COLUMNS)) / COLUMNS;
    expect(unbounded).toBeGreaterThan(MAX_TOOTH * 1.25);
    expect(toothColumnWidth(fullBleedAt1920, COLUMNS)).toBe(MAX_TOOTH);
  });

  it("turns the surplus into equal air either side, not into a bigger chart", () => {
    const available = 1864;
    expect(archRenderedWidth(available, COLUMNS)).toBe(archMaxWidth(COLUMNS));
    expect(archRenderedWidth(available, COLUMNS)).toBeLessThan(available);
    // Centred, not left-aligned with a ragged right edge: the air is halved, and
    // both halves plus the drawing account for the whole container.
    const air = archSideAir(available, COLUMNS);
    expect(air).toBeGreaterThan(0);
    expect(air * 2 + archRenderedWidth(available, COLUMNS)).toBeCloseTo(available, 6);
  });

  it("still leaves nothing over inside the arch, at every width in either regime", () => {
    // The columns divide their AVAILABLE width exactly — where "available" is the
    // container in the fluid band and the cap above it. A leftover here would be a
    // column that had quietly stopped filling its own track.
    for (const available of [600, 1078, 1200, 1494, 1864, 3840]) {
      const tooth = toothColumnWidth(available, COLUMNS);
      expect(archChrome(COLUMNS) + COLUMNS * tooth).toBe(archRenderedWidth(available, COLUMNS));
      expect(archRenderedWidth(available, COLUMNS)).toBeLessThanOrEqual(archMaxWidth(COLUMNS));
    }
  });

  it("keeps the cap clear of the floor, so the arch is never one fixed size", () => {
    // A cap that met the floor would be the rejected build with extra arithmetic:
    // every screen drawing the same small chart.
    expect(MAX_TOOTH).toBeGreaterThan(MIN_TOOTH);
    expect(archMaxWidth(COLUMNS)).toBeGreaterThan(archMinWidth(COLUMNS));
  });

  it("caps at the measured reference rather than at a number picked by feel", () => {
    expect(MAX_TOOTH).toBe(DENTALLY.tooth);
    // The two ways of naming the same width agree: the cap IS the width at which a
    // column reaches the reference measure.
    expect(archMaxWidth(COLUMNS)).toBe(chartWidthFor(DENTALLY.tooth, COLUMNS));
  });
});

describe("against DENTALLY.md's measurements", () => {
  // 88px is a measurement AT A VIEWPORT, not a constant. Dentally's screenshot sat
  // beside a ~530px treatment list, so their 16 columns needed roughly this much
  // chart and therefore a ~2560px monitor.
  it("reaches the measured 88px column at the width that measurement implies", () => {
    const needed = chartWidthFor(DENTALLY.tooth, COLUMNS);
    expect(needed).toBe(END_W * 2 + 17 * GAP + 16 * 88);
    expect(toothColumnWidth(needed, COLUMNS)).toBeCloseTo(DENTALLY.tooth, 6);
  });

  /**
   * SUPERSEDED, AND REPLACED BY ITS OPPOSITE — recorded rather than deleted, because
   * the reversal is the whole of the owner's second verdict.
   *
   * This used to assert that our columns come out WIDER than Dentally's on the
   * monitor the reference was measured on, and called that "the target met rather
   * than approached". Side by side, overshooting the reference is not the target met:
   * "the actual chart still needs to be smaller like dentallys". So the arch now
   * MEETS the measure and stops there, on that monitor and on every larger one.
   */
  it("MEETS the reference on that monitor, and does not run past it", () => {
    const chartAt2560 = 1946;
    expect(toothColumnWidth(chartAt2560, COLUMNS)).toBe(DENTALLY.tooth);
    expect(toothColumnWidth(chartAt2560, COLUMNS)).not.toBeGreaterThan(DENTALLY.tooth);
  });

  it("is still far bigger than the build the owner rejected, on a narrow screen", () => {
    // A 1920 viewport with the treatment panel open, which is the narrow common
    // case — and the one the FIRST complaint was about. The cap must never be an
    // excuse to re-earn that verdict, so this is asserted below the cap, not at it.
    const chartAt1920 = 1306;
    const tooth = toothColumnWidth(chartAt1920, COLUMNS);
    expect(tooth).toBeLessThan(MAX_TOOTH);
    expect(tooth).toBeGreaterThan(60);
    // The rejected build. Anything approaching it is a regression, not a tweak.
    expect(tooth).toBeGreaterThan(26 * 2);
  });

  it("draws the crown TALLER than the grid, as measured", () => {
    // 75 x 85 against 75 x 72. A single shared box cannot express that, which is
    // why the crown and the grid are rendered in separate viewBoxes.
    expect(DENTALLY.crown.h).toBeGreaterThan(DENTALLY.grid.h);
    expect(CROWN_ASPECT).toBe("75/85");
    expect(GRID_ASPECT).toBe("75/72");
  });
});

/**
 * THE ARCH READS AS ONE ARCH.
 *
 * The second verdict, after the size one, came from putting our chart beside a
 * full-resolution Dentally screenshot: their adjacent surface grids ABUT and the
 * grid row crosses the screen as a single band, while ours sat ~14% apart and read
 * as sixteen separate widgets. That is a scanning cost paid mid-appointment, which
 * is when this screen is read at all.
 *
 * Density is the easiest thing on this screen to give away, because every future
 * change that needs "a bit of breathing room" pays for it out of this gap. So the
 * bound is asserted as a FRACTION of the cell, at every width the layout can reach.
 */
describe("the grid row reads as one band", () => {
  it("leaves only a hairline between adjacent surface grids", () => {
    // Small enough that two neighbouring grids share an edge to the eye. Not zero:
    // each grid strokes its own outline, and flush outlines read as one doubled
    // line louder than the divisions inside the cell.
    expect(GAP).toBeGreaterThan(0);
    expect(GAP).toBeLessThanOrEqual(2);
  });

  it("stays a hairline RELATIVE to the tooth, at every width the arch draws", () => {
    // Below the floor, and above the monitor the reference was measured on.
    for (const available of [600, 1078, 1306, 1457, 1946, 2400]) {
      expect(gapFraction(available, COLUMNS)).toBeLessThanOrEqual(HAIRLINE_MAX_FRACTION);
    }
  });

  it("would catch the spread-out gap the side-by-side comparison failed on", () => {
    // 13px against an ~88px column: the number this build used to carry, and the
    // reason the arch read as sixteen cards. Asserting that the guard REJECTS it is
    // worth more than asserting today's number passes, because it is the specific
    // regression a future contributor would reintroduce.
    expect(DENTALLY.supersededGap / DENTALLY.tooth).toBeGreaterThan(HAIRLINE_MAX_FRACTION);
  });

  it("gives the reclaimed space to the teeth rather than to margin", () => {
    // Closing the gaps and keeping the arch full-width are the same edit: inside the
    // fluid band every pixel taken out of a gap comes back as tooth. This is a
    // mid-band width — the difference between the ~74px the owner was looking at and
    // something near the reference's measured 88px.
    const chartAt1920 = 1457;
    expect(toothColumnWidth(chartAt1920, COLUMNS)).toBeGreaterThan(80);
    // ...and the arch still consumes all of it. Narrower teeth in a narrower arch
    // would be the small chart the owner rejected wearing a tighter gap.
    const tooth = toothColumnWidth(chartAt1920, COLUMNS);
    expect(archChrome(COLUMNS) + COLUMNS * tooth).toBeCloseTo(chartAt1920, 6);
  });
});

describe("the floor, and what happens below it", () => {
  it("scrolls rather than shrinking past a hittable surface", () => {
    const floor = archMinWidth(COLUMNS);
    expect(floor).toBe(END_W * 2 + 17 * GAP + 16 * HARD_MIN_TOOTH);
    expect(archScrolls(floor - 1, COLUMNS)).toBe(true);
    expect(archScrolls(floor, COLUMNS)).toBe(false);
    // Below the floor the column stops shrinking. A tooth too small to hit
    // accurately is a mis-click, and a mis-click here charts the wrong tooth.
    expect(toothColumnWidth(600, COLUMNS)).toBe(HARD_MIN_TOOTH);
  });

  /**
   * THE ORDER OF THE TWO MINIMUMS, which is the bug.
   *
   * MIN_TOOTH is what the arch WOULD like; HARD_MIN_TOOTH is where it finally gives up
   * and scrolls. With the preferred one in the floor's slot, an arch that had 947px and
   * wanted 1078px scrolled rather than drawing at 59px a column — it chose its preferred
   * size over fitting on the screen, which is the owner's complaint exactly.
   */
  it("shrinks below the PREFERRED minimum rather than scrolling", () => {
    expect(HARD_MIN_TOOTH).toBeLessThan(MIN_TOOTH);
    // The width the owner's own 1500px screen actually had. It is between the two
    // minimums, so the arch must draw smaller than it likes and still whole.
    const owner = 947;
    expect(owner).toBeLessThan(archPreferredWidth(COLUMNS));
    expect(owner).toBeGreaterThan(archMinWidth(COLUMNS));
    expect(archScrolls(owner, COLUMNS)).toBe(false);
    const tooth = toothColumnWidth(owner, COLUMNS);
    expect(tooth).toBeLessThan(MIN_TOOTH);
    expect(tooth).toBeGreaterThan(HARD_MIN_TOOTH);
    // ...and it fills that width exactly, rather than overflowing it by 131px.
    expect(archRenderedWidth(owner, COLUMNS)).toBeCloseTo(owner, 6);
  });

  it("keeps the hard floor well clear of the preferred one", () => {
    // A hard floor a few pixels under the preferred one is the same bug with a smaller
    // number: it would still scroll at 1280. The gap has to be a real band.
    expect(MIN_TOOTH - HARD_MIN_TOOTH).toBeGreaterThanOrEqual(12);
    expect(archPreferredWidth(COLUMNS)).toBeGreaterThan(archMinWidth(COLUMNS));
  });

  it("holds the preferred minimum well above the size that was rejected", () => {
    expect(MIN_TOOTH).toBeGreaterThan(26 * 2);
  });

  it("counts columns + 1 gaps, not columns - 1", () => {
    // The grid is END_W | 1fr x columns | END_W: columns + 2 tracks, columns + 1
    // gaps. Off by one here and the strip is a tooth wider than its container and
    // scrolls when it should not.
    expect(archChrome(COLUMNS)).toBe(END_W * 2 + 17 * GAP);
    expect(archChrome(10)).toBe(END_W * 2 + 11 * GAP);
  });
});

/**
 * The measurements and the RENDER, tied together.
 *
 * The cell aspects land in Tailwind `aspect-[..]` classes, and Tailwind v4 scans raw
 * source rather than evaluating it: a class built by interpolating a constant emits
 * no rule at all and the cell renders with no aspect. So tooth.tsx writes them out in
 * full, and this reads the file back to prove the written-out values are still the
 * measured ones. The alternative — a comment asking the next reader to keep two
 * numbers in step — is how the first pass ended up three times too small.
 */
describe("the rendered cells carry the measured aspects", () => {
  const TOOTH_TSX = fileURLToPath(
    new URL("../../components/client/patients/record/chart/tooth.tsx", import.meta.url),
  );

  it("draws the crown and the grid at DENTALLY.md's proportions", () => {
    const source = readFileSync(TOOTH_TSX, "utf8");
    expect(source).toContain(`aspect-[${DENTALLY.crown.w}/${DENTALLY.crown.h}]`);
    expect(source).toContain(`aspect-[${DENTALLY.grid.w}/${DENTALLY.grid.h}]`);
  });

  it("sizes the cells by aspect against the column, never at a fixed pixel width", () => {
    const source = readFileSync(TOOTH_TSX, "utf8");
    // `w-full` against a 1fr column is what makes the tooth grow with the screen.
    // A fixed w-[NNpx] on either cell is the rejected build returning.
    expect(source).toMatch(/aspect-\[75\/85\] w-full/);
    expect(source).toMatch(/aspect-\[75\/72\] w-full/);
  });
});

/**
 * THE ROW BAND SAYS NOTHING, which is its whole job.
 *
 * The band behind each row of surface grids was painted bg-card-muted — one of the
 * app's cool blue-grey surfaces — and beside Dentally that tint read as a state
 * rather than as a backdrop, on a chart where cyan means base dentition and steel
 * means completed. The reference's band is a faint neutral grey. Asserted by
 * reading the source for the same reason the aspects above are: vitest collects no
 * .tsx, so nothing else on this screen can hold a component's colours.
 */
describe("the grid row band is neutral, not blue", () => {
  const ARCH_TSX = fileURLToPath(
    new URL("../../components/client/patients/record/chart/chart-arch.tsx", import.meta.url),
  );

  const GLOBALS_CSS = fileURLToPath(new URL("../../app/globals.css", import.meta.url));

  it("paints the band from the chart palette's neutral", () => {
    const source = readFileSync(ARCH_TSX, "utf8");
    expect(source).toMatch(/backgroundColor:\s*"var\(--chart-[\w-]+/);
  });

  /**
   * THE TOKEN THE BAND NAMES MUST ACTUALLY EXIST — this is the test that was missing,
   * and its absence cost exactly one silent regression. The band read var(--chart-band)
   * while globals.css declared --chart-row-band. CSS resolves an undeclared variable to
   * the fallback without warning, so the band kept painting --card-muted, the very
   * blue-grey the change removed, while a literal-matching test stayed green. Assert the
   * link, not the spelling: read the name out of the component and require globals.css
   * to declare it. Renaming either side alone now fails here.
   */
  it("names a token globals.css actually declares", () => {
    const source = readFileSync(ARCH_TSX, "utf8");
    const named = /backgroundColor:\s*"var\((--chart-[\w-]+)/.exec(source);
    expect(named).not.toBeNull();
    const css = readFileSync(GLOBALS_CSS, "utf8");
    expect(css).toMatch(new RegExp(`^\\s*${named![1]}:\\s*[^;]+;`, "m"));
  });

  /**
   * And the declared value must be neutral, since "not blue" is the entire point. A grey
   * has its three channels within a few points of each other; the old --card-muted band
   * (#eef4fb) spread 13 across them.
   */
  it("declares that token as a neutral grey, not a tinted one", () => {
    const source = readFileSync(ARCH_TSX, "utf8");
    const named = /backgroundColor:\s*"var\((--chart-[\w-]+)/.exec(source)!;
    const css = readFileSync(GLOBALS_CSS, "utf8");
    const hex = new RegExp(`^\\s*${named[1]}:\\s*#([0-9a-f]{6});`, "mi").exec(css);
    expect(hex).not.toBeNull();
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex![1].slice(i, i + 2), 16));
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(4);
  });

  it("does not reach for one of the app's blue-grey card surfaces", () => {
    const source = readFileSync(ARCH_TSX, "utf8");
    // The fallback inside the var() is allowed — it only keeps a band painted if the
    // token is renamed. A bare utility class painting the band is not.
    expect(source).not.toMatch(/className="[^"]*\bbg-(card-muted|band|blue-soft|tint-\w+)\b/);
  });
});

/**
 * THE RENDER ACTUALLY CARRIES THE CAP.
 *
 * Everything above is arithmetic, and arithmetic nobody calls is decoration. The cap
 * only exists on screen if chart-arch.tsx lays the columns out with it, and vitest
 * collects no .tsx in a node environment, so the only way to hold the component to
 * this is to read the file — the same technique the crown/grid aspects and the row
 * band's token already use here, for the same reason.
 *
 * ASSERT THE LINK, NOT THE LITERAL. This suite has already paid once for a test that
 * matched a literal: the band named var(--chart-band) while globals.css declared
 * --chart-row-band, CSS silently took the fallback, and the assertion stayed green
 * over unchanged pixels. So these read the NAME out of the component and require the
 * other side to define it. A bare `expect(source).toContain("88px")` would pass over
 * a component that had gone back to `1fr` and merely mentioned the number in a
 * comment.
 */
describe("the arch component is laid out with the cap", () => {
  const ARCH_TSX = fileURLToPath(
    new URL("../../components/client/patients/record/chart/chart-arch.tsx", import.meta.url),
  );
  const METRICS_TS = fileURLToPath(new URL("./arch-metrics.ts", import.meta.url));

  /**
   * WHAT THE FILE DOES, not what it says about itself.
   *
   * chart-arch.tsx documents the change it just made — it names `minmax(0, 1fr)` in
   * prose as the thing it replaced, and a comment saying "1fr" would otherwise fail a
   * test whose whole point is that no 1fr TRACK survives. Strip the comments and match
   * the code. The alternative, forbidding the file from naming its own history, would
   * trade the record of why this cap exists for a simpler regex.
   */
  function code(path: string): string {
    return readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "") // block and JSX comments
      .replace(/^\s*\/\/.*$/gm, ""); // line comments (this file has no trailing ones)
  }

  it("bounds the tooth track by a constant this module exports", () => {
    const source = code(ARCH_TSX);
    // repeat(columns, minmax(0, <SOMETHING>px)) — the ceiling, where the columns are
    // declared. Interpolated rather than written out, which is safe here because this
    // is an inline style: Tailwind's raw-source scan never sees it, so the rule that
    // forbids interpolating an arbitrary class value does not apply.
    const bound = /minmax\(0,\s*\$\{(\w+)\}px\)/.exec(source);
    expect(bound).not.toBeNull();
    // ...and the constant it names is really exported here, rather than being a local
    // number that has drifted from the measurement.
    const metrics = code(METRICS_TS);
    expect(metrics).toMatch(new RegExp(`^export const ${bound![1]}\\b`, "m"));
  });

  /**
   * THE MUTATION THIS TEST EXISTS FOR. `minmax(0, 1fr)` is what was there, it is what
   * a future contributor reaches for when the arch looks narrow on their laptop, and
   * it is the exact edit that produced the owner's complaint. Restoring it fails here
   * as well as at the arithmetic above.
   */
  it("has no unbounded 1fr track left anywhere in the arch", () => {
    const source = code(ARCH_TSX);
    expect(source).not.toMatch(/minmax\([^)]*\b1fr\b/);
    expect(source).not.toMatch(/gridTemplateColumns:[^;]*\b1fr\b/);
  });

  it("caps the strip at archMaxWidth and CENTRES it in the full-bleed card", () => {
    const source = code(ARCH_TSX);
    // The binding, then the style that uses it: renaming one without the other fails.
    const cap = /const (\w+) = archMaxWidth\(columns\)/.exec(source);
    expect(cap).not.toBeNull();
    expect(source).toMatch(new RegExp("maxWidth: `\\$\\{" + cap![1] + "\\}px`"));
    // Auto side margins are what turn the surplus into equal air. Without this the
    // capped arch would hug the left edge of a full-bleed card.
    expect(source).toMatch(/className="[^"]*\bmx-auto\b/);
  });

  /**
   * THE BACKDROP AND THE DRAWING DO NOT SHARE A WIDTH.
   *
   * Capping the arch is right and it took the row band down with it: the band was
   * inside the one capped wrapper, so it ended exactly where the teeth ended — a
   * stripe stopping at the last molar with a third of the card blank either side.
   * DENTALLY.md is explicit that the band runs "the full width", and the reference
   * screenshot shows it crossing the whole panel with the arch sitting ON it. That
   * was accidentally true while the arch WAS the container and has to be deliberate
   * now that it is not.
   *
   * Asserted structurally rather than by literal, for this suite's usual reason: the
   * band element must carry no width bound, and the grid it wraps must carry the one
   * the component itself defines. A cap reappearing on any ancestor of the band fails
   * here — which is the exact edit that produced the defect.
   */
  it("keeps the row band clear of the cap so it spans the full card", () => {
    const source = code(ARCH_TSX);
    // The capped, centred strip, named by what it does rather than by its spelling.
    const strip = /const (\w+): React\.CSSProperties = \{\s*\.\.\.\w+,\s*maxWidth:/.exec(source);
    expect(strip).not.toBeNull();

    // The element that paints the band, taken whole.
    const band = /<div\b[^>]*backgroundColor:\s*"var\(--chart-[\w-]+[^>]*>/.exec(source);
    expect(band).not.toBeNull();
    // It bounds nothing and centres nothing: it is as wide as the card it sits in.
    expect(band![0]).not.toMatch(/maxWidth|mx-auto|maxStrip/);

    // And the grid immediately inside it is capped and centred, which is what keeps
    // the teeth at Dentally's measure and in register with every other strip. It also
    // means the band still WRAPS the row it backs, so a full-width band cannot drift
    // to the wrong height.
    const after = band!.index + band![0].length;
    const inner = source.slice(after, after + 240);
    expect(inner).toContain(strip![1]);
    expect(inner).toMatch(/\bmx-auto\b/);
  });

  it("leaves the scroll-rather-than-shrink behaviour intact", () => {
    const source = code(ARCH_TSX);
    // The floor still comes from archMinWidth and is still rendered as min-width...
    const floor = /const (\w+) = archMinWidth\(columns\)/.exec(source);
    expect(floor).not.toBeNull();
    expect(source).toMatch(new RegExp("minWidth: `\\$\\{" + floor![1] + "\\}px`"));
    // ...and it is still the ARCH's own container that scrolls. The page body
    // scrolling sideways is the failure this guards.
    expect(source).toMatch(/className="[^"]*\boverflow-x-auto\b/);
  });
});

/**
 * ============================================================================
 * THE ACCEPTANCE CRITERION, AS A PROPERTY.
 *
 * "AT EVERY VIEWPORT FROM 1280 UPWARDS, WITH THE TREATMENT LIST OPEN, THE ARCH DOES
 * NOT SCROLL SIDEWAYS."
 *
 * WHY A SWEEP AND NOT THREE CASES. This regression lived in the GAP BETWEEN the widths
 * anyone thought to check. The panel was widened to a fixed 400px and verified at 1920,
 * where it is right; the arch's floor was verified at 1280, where the old 300px panel
 * left just enough; and 1500 — the owner's own window — was checked by nobody, so the
 * one band where a fixed 400 overruns the floor shipped. Any test written at two
 * viewports would have passed over it. So the assertion is the property at EVERY width
 * across the range, which is the only shape of test that could have caught it.
 *
 * The numbers here are measurements, not estimates: PAGE_CHROME (119px), WORKSPACE_GAP
 * (16px) and CARD_CHROME (18px) were all read out of the live DOM on this page at
 * 2026-08-02, and the reproduction below shows they reproduce the owner's reported
 * shortfall to the pixel.
 * ============================================================================
 */
describe("the arch fits at every viewport from 1280 up, with the list open", () => {
  /** Every width in the range, not a handful of them. */
  function sweep(step: number, to: number): number[] {
    const widths: number[] = [];
    for (let v = MIN_VIEWPORT; v <= to; v += step) widths.push(v);
    return widths;
  }

  it("never scrolls sideways, at any width from 1280 to 2560", () => {
    const scrolling = sweep(1, 2560).filter((v) => archScrollsAtViewport(v, COLUMNS));
    expect(scrolling).toEqual([]);
  });

  it("still never scrolls above 2560, where the cap has long since bitten", () => {
    for (const v of [2561, 2880, 3440, 3840, 5120]) {
      expect(archScrollsAtViewport(v, COLUMNS)).toBe(false);
    }
  });

  it("never scrolls with the list COLLAPSED either, which only gives it more room", () => {
    for (const v of sweep(1, 2560)) {
      expect(archAvailableAtViewport(v, false)).toBeGreaterThan(archAvailableAtViewport(v, true));
      expect(archScrollsAtViewport(v, COLUMNS, false)).toBe(false);
    }
  });

  /**
   * FITTING IS NOT ENOUGH ON ITS OWN — an arch that fits by drawing every tooth at the
   * hard floor would satisfy the criterion and be unreadable. So the sweep also holds
   * the size: the columns keep GROWING with the screen, and past the point where there
   * is room for it they sit at or above the PREFERRED minimum.
   */
  it("grows monotonically with the viewport, and reaches the preferred column", () => {
    let previous = 0;
    for (const v of sweep(1, 2560)) {
      const tooth = toothColumnWidth(archAvailableAtViewport(v), COLUMNS);
      expect(tooth).toBeGreaterThanOrEqual(previous);
      expect(tooth).toBeLessThanOrEqual(MAX_TOOTH);
      previous = tooth;
    }
    // The preferred minimum is met from a mid-range laptop upwards; only the narrowest
    // band trades it away, and it trades it for a whole chart rather than a scrollbar.
    expect(toothColumnWidth(archAvailableAtViewport(1600), COLUMNS)).toBeGreaterThanOrEqual(MIN_TOOTH);
    expect(toothColumnWidth(archAvailableAtViewport(1920), COLUMNS)).toBeGreaterThan(MIN_TOOTH);
  });

  /**
   * THE ARITHMETIC MATCHES THE BROWSER, which is the only thing that makes any of the
   * above evidence rather than opinion. These are readings taken off the live page at
   * localhost:3002 on 2026-08-02, and the module reproduces them exactly: at 1500 the
   * content area measured 1381px, the treatment list drew at 314.87px, and the arch's
   * scroller reported clientWidth === scrollWidth === 1048px, of which 1032.13px is
   * content box once the card's 16px of padding comes off.
   */
  it("reproduces the live DOM's own numbers", () => {
    expect(archAvailableAtViewport(1500)).toBe(archAvailableWidth(1500 - PAGE_CHROME));
    expect(1500 - PAGE_CHROME).toBe(1381);
    expect(panelWidth(1381)).toBeCloseTo(314.868, 3);
    expect(archAvailableWidth(1381)).toBeCloseTo(1032.13, 2);
    // The measured tooth column at that viewport, to two decimal places.
    expect(toothColumnWidth(archAvailableAtViewport(1500), COLUMNS)).toBeCloseTo(59.13, 2);
    // ...and at 1280 and 1920, the other two the browser was read at.
    expect(archAvailableWidth(1280 - PAGE_CHROME)).toBe(827);
    expect(toothColumnWidth(archAvailableAtViewport(1280), COLUMNS)).toBeCloseTo(46.31, 2);
    expect(toothColumnWidth(archAvailableAtViewport(1920), COLUMNS)).toBeCloseTo(80.06, 2);
    // At 2560 the cap has bitten and the browser reported exactly MAX_TOOTH.
    expect(toothColumnWidth(archAvailableAtViewport(2560), COLUMNS)).toBe(MAX_TOOTH);
  });

  it("leaves real slack at the worst case rather than clearing it by a pixel", () => {
    // 1280 is where everything is tightest: the panel is at its floor and the arch is
    // near its own. A fit that cleared by 2px would be re-broken by the next 1px border
    // anyone adds to this screen.
    const available = archAvailableAtViewport(MIN_VIEWPORT);
    expect(available - archMinWidth(COLUMNS)).toBeGreaterThanOrEqual(24);
  });

  it("keeps the panel between its two bounds, proportional in between", () => {
    for (const v of sweep(1, 2560)) {
      const panel = panelWidth(v - PAGE_CHROME);
      expect(panel).toBeGreaterThanOrEqual(PANEL_MIN);
      expect(panel).toBeLessThanOrEqual(PANEL_MAX);
    }
    // The two ends are really reached — a clamp that never leaves one bound is a fixed
    // width wearing a clamp, which is the build being replaced.
    expect(panelWidth(1280 - PAGE_CHROME)).toBe(PANEL_MIN);
    expect(panelWidth(1920 - PAGE_CHROME)).toBe(PANEL_MAX);
    // ...and the Dentally proportion holds where it fits between them.
    const mid = 1500 - PAGE_CHROME;
    expect(panelWidth(mid)).toBeCloseTo(mid * PANEL_FRACTION, 6);
    expect(panelWidth(mid)).toBeGreaterThan(PANEL_MIN);
    expect(panelWidth(mid)).toBeLessThan(PANEL_MAX);
  });
});

/**
 * THE BUG ITSELF, REPRODUCED — and then the two mutations that bring it back.
 *
 * A guard is only worth what it rejects. These state the exact edits a future
 * contributor would make and prove each one fails the criterion above, so "the test
 * passes" means something other than "the test exists".
 */
describe("the mutations this suite exists to reject", () => {
  const OWNER_VIEWPORT = 1500;
  const CONTENT_AT_1500 = OWNER_VIEWPORT - PAGE_CHROME; // 1381px, measured in the DOM

  it("reproduces the reported shortfall to the pixel, with the old fixed panel", () => {
    // MUTATION 1: the panel goes back to a flat 400px at every viewport.
    const fixedPanel = 400;
    const available = CONTENT_AT_1500 - fixedPanel - WORKSPACE_GAP - CARD_CHROME;
    // What the owner's browser reported: a 963px scroller (947px of content box plus
    // the card's 16px of padding) against a 1094px scrollWidth (the 1078px strip plus
    // the same padding). 131px short.
    expect(available).toBe(947);
    expect(available + 16).toBe(963);
    const oldFloor = archChrome(COLUMNS) + COLUMNS * MIN_TOOTH; // the preferred minimum as a floor
    expect(oldFloor).toBe(1078);
    expect(oldFloor + 16).toBe(1094);
    expect(oldFloor - available).toBe(131);

    // The mutation fails the criterion twice over. Against the PREFERRED floor — which
    // is what the shipped build enforced, and therefore what actually scrolled on the
    // owner's screen — a fixed 400 is short across most of the supported range...
    const shortOfPreferred = [];
    const shortOfHardFloor = [];
    for (let v = MIN_VIEWPORT; v <= 2560; v += 1) {
      const available = v - PAGE_CHROME - fixedPanel - WORKSPACE_GAP - CARD_CHROME;
      if (available < oldFloor) shortOfPreferred.push(v);
      if (available < archMinWidth(COLUMNS)) shortOfHardFloor.push(v);
    }
    expect(shortOfPreferred).toContain(OWNER_VIEWPORT);
    expect(shortOfPreferred.length).toBeGreaterThan(200);
    // ...and even against the new HARD floor it still breaks the bottom of the range, so
    // fixing the floor alone would not have been enough: the panel had to become
    // proportional as well. Both halves of the fix are load-bearing.
    expect(shortOfHardFloor[0]).toBe(MIN_VIEWPORT);
    expect(shortOfHardFloor.at(-1)).toBe(1342);

    // The panel as it now stands clears both at that viewport.
    expect(archScrollsAtViewport(OWNER_VIEWPORT, COLUMNS)).toBe(false);
    expect(archAvailableAtViewport(OWNER_VIEWPORT)).toBeGreaterThan(archMinWidth(COLUMNS));
  });

  it("fails if the PREFERRED minimum is put back in the floor's slot", () => {
    // MUTATION 2: archMinWidth (and toothColumnWidth's lower clamp) go back to
    // MIN_TOOTH — the "fit is negotiable, 62px is not" ordering that caused this.
    const preferredAsFloor = (columns: number) => archChrome(columns) + columns * MIN_TOOTH;
    expect(preferredAsFloor(COLUMNS)).toBe(archPreferredWidth(COLUMNS));

    const scrolling = [];
    for (let v = MIN_VIEWPORT; v <= 2560; v += 1) {
      if (archAvailableAtViewport(v) < preferredAsFloor(COLUMNS)) scrolling.push(v);
    }
    // A wide band of the supported range would scroll — including the owner's 1500.
    expect(scrolling.length).toBeGreaterThan(100);
    expect(scrolling).toContain(OWNER_VIEWPORT);
    expect(scrolling[0]).toBe(MIN_VIEWPORT);
    // Whereas the real floor rejects none of them.
    expect(scrolling.every((v) => !archScrollsAtViewport(v, COLUMNS))).toBe(true);
  });

  it("fails if the panel's floor is raised back towards the ceiling", () => {
    // MUTATION 3: the clamp survives but PANEL_MIN creeps up to "stop the names
    // truncating on a laptop". At 1280 there is no room for it.
    const worstContent = MIN_VIEWPORT - PAGE_CHROME;
    const roomForPanel = worstContent - WORKSPACE_GAP - CARD_CHROME - archMinWidth(COLUMNS);
    expect(PANEL_MIN).toBeLessThanOrEqual(roomForPanel);
    // And the headroom is finite: a floor at the ceiling breaks 1280 outright.
    expect(PANEL_MAX).toBeGreaterThan(roomForPanel);
  });
});

/**
 * THE RENDER CARRIES THE PANEL RULE.
 *
 * Same technique, same reason as the cap above: vitest collects no .tsx, so a width
 * that lives only in a class string is a width nothing can hold. And this file has a
 * specific hazard — Tailwind v4 scans RAW SOURCE, so a track built by interpolating a
 * constant emits no class at all and the grid silently falls back to one column. The
 * value must therefore be literal in the source AND vary at runtime, which is why it is
 * a CSS clamp() rather than a computed pixel width.
 *
 * ASSERT THE LINK, NOT THE LITERAL: the numbers are read OUT of the component and
 * checked against the constants this module exports, so changing either side alone
 * fails here.
 */
describe("the workspace lays the treatment list out as a clamped proportion", () => {
  const WORKSPACE_TSX = fileURLToPath(
    new URL("../../components/client/patients/record/chart/chart-workspace.tsx", import.meta.url),
  );
  const PANEL_TSX = fileURLToPath(
    new URL("../../components/client/patients/record/chart/treatment-panel.tsx", import.meta.url),
  );

  function code(path: string): string {
    return readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  it("declares the track as clamp(PANEL_MIN, PANEL_FRACTION, PANEL_MAX)", () => {
    const source = code(WORKSPACE_TSX);
    const track = /lg:grid-cols-\[clamp\((\d+)px,([\d.]+)%,(\d+)px\)_minmax\(0,1fr\)\]/.exec(source);
    expect(track).not.toBeNull();
    const [, min, pct, max] = track!;
    expect(Number(min)).toBe(PANEL_MIN);
    expect(Number(pct) / 100).toBeCloseTo(PANEL_FRACTION, 6);
    expect(Number(max)).toBe(PANEL_MAX);
  });

  /**
   * THE MUTATION. A flat pixel track is what shipped and is what anyone reaching for
   * "just make the list wider" will write. It cannot come back without failing here.
   */
  it("has no fixed-pixel panel track left", () => {
    const source = code(WORKSPACE_TSX);
    // Every fixed-pixel track in the file, and the ONLY one allowed is the collapsed
    // rail — which is genuinely a constant, because it holds one 32px circle.
    const fixed = [...source.matchAll(/grid-cols-\[(\d+)px_minmax\(0,1fr\)\]/g)].map((m) =>
      Number(m[1]),
    );
    expect(fixed).toEqual([PANEL_RAIL]);
    expect(source).not.toContain("grid-cols-[400px_minmax(0,1fr)]");
  });

  /** The collapsed rail is the one width that IS fixed, and it still matches. */
  it("keeps the collapsed rail at its fixed track, matching the aside", () => {
    expect(code(WORKSPACE_TSX)).toContain(`lg:grid-cols-[${PANEL_RAIL}px_minmax(0,1fr)]`);
    const panel = code(PANEL_TSX);
    const rail = /<aside\s+aria-label="Treatment list, collapsed"\s+className=\{cn\("([^"]+)"/.exec(panel);
    expect(rail).not.toBeNull();
    expect(rail![1]).toContain(`w-[${PANEL_RAIL}px]`);
  });

  /**
   * NOT INTERPOLATED. `grid-cols-[${n}px_…]` type-checks, renders no class, and drops
   * the layout to a single column — the failure mode this project has already paid for
   * more than once. Cheap to assert, so it is asserted.
   */
  it("writes the track literally, never through a template", () => {
    const source = code(WORKSPACE_TSX);
    expect(source).not.toMatch(/grid-cols-\[[^\]]*\$\{/);
  });

  /**
   * AND THE ASIDE DOES NOT RESTATE THE TRACK. Two literals that must agree is a defect
   * waiting for its first edit; with a clamp it is not even expressible. `w-full` makes
   * the aside exactly its column, whatever the column resolves to.
   */
  it("sizes the open aside to its track rather than to a pixel width", () => {
    const panel = code(PANEL_TSX);
    const open = /<aside\s+aria-label="Treatment list"\s+className=\{cn\("([^"]+)"/.exec(panel);
    expect(open).not.toBeNull();
    expect(open![1]).toMatch(/\bw-full\b/);
    expect(open![1]).not.toMatch(/\bw-\[\d+px\]/);
  });
});
