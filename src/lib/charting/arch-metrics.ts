// ===========================================================================
// HOW BIG A TOOTH IS. The arch's geometry, as arithmetic rather than as a claim.
//
// PURE.
//
// WHY THIS IS A MODULE AND NOT FOUR CONSTANTS IN THE JSX. The owner's verdict on
// the first pass of this screen was, verbatim: "look at dentallys chart how its
// easy to read across the entire site you make everything small it should be
// bigger". He was right by a factor of three — DENTALLY.md's MEASURED GEOMETRY
// puts their tooth column at ~88px against our 26px — and a fix to that complaint
// is worth nothing if nobody can check it afterwards. Sizes buried in a .tsx are
// unreachable: vitest collects only src/ ** / *.test.ts in a node environment, so
// a component's own numbers are never asserted and drift back down one convenience
// at a time. The numbers live here so the test beside this file can hold the build
// to the measurements.
//
// LEGIBILITY IS A SAFETY PROPERTY ON THIS SCREEN, not a matter of taste. A
// clinician reads this chart from a metre away across a surgery, and a surface too
// small to hit accurately is a mis-click that charts the wrong tooth.
//
// THE PAGE FILLS THE WIDTH; THE DRAWING DOES NOT. Those are two different things,
// and running them together is what produced the owner's second verdict: "it should
// fill the screen like this but still the actual chart still needs to be smaller
// like dentallys". The CONTAINER is full-bleed — the card, its border, the row band
// all cross the screen, which is what DENTALLY.md calls "the single change that
// makes this screen readable". The TOOTH stops growing at MAX_TOOTH and the arch
// centres in whatever is left. Both halves of the complaint are satisfied at once
// only because they were separated.
//
// 88px IS A MEASUREMENT AT A VIEWPORT — but a fluid layout with no ceiling does not
// approach a measurement, it walks straight past it. Columns were pure `1fr`, so
// they absorbed every available pixel: measured 114.63px per tooth on a 1920 screen
// once the record went full-bleed, against the reference's ~88px. And because the
// crown is drawn at a fixed 75/85 aspect, height follows width, so the arch was too
// TALL for the same reason it was too wide. A floor without a ceiling is half a
// rule. MIN_TOOTH and MAX_TOOTH are the two halves; chartWidthFor() is still the
// honest way to ask "how wide must the screen be", and archMaxWidth() is the answer
// to "how wide will the drawing ever get", which is the question that was missing.
// ===========================================================================

/**
 * THE PREFERRED minimum column. Not a floor any more — a target the layout gives up
 * only when the alternative is a chart you have to scroll sideways.
 *
 * Two and a half times the 26px the owner rejected, and wide enough that every one of
 * a permanent molar's eight regions stays larger than a fingertip. On any screen with
 * the room for it the arch still lands at or above this.
 *
 * WHY IT STOPPED BEING THE FLOOR. It was enforced AHEAD of "fit the width", which is
 * the wrong order and is what turned a slightly-too-small arch into a scrolling one:
 * at a 1500px viewport with the treatment list open the arch had 947px of room and
 * this floor demanded 1078px, so the columns refused the last 8px each and the
 * container scrolled instead. The owner reported exactly that — "when our platform the
 * side bar comes out it makes it so you have to scroll for the teeth it shouldnt be
 * like that it should fit into one thing". A truncated name is a nuisance; a chart you
 * must drag sideways mid-appointment is a chart nobody reads in one piece. FIT WINS,
 * and the real floor below is where scrolling finally begins.
 */
export const MIN_TOOTH = 62;

/**
 * THE HARD FLOOR: the width at which the arch genuinely stops shrinking and its own
 * container scrolls instead. Between this and MIN_TOOTH the arch shrinks to fit.
 *
 * DELIBERATELY WELL BELOW the preferred minimum. A floor sitting just under the
 * preferred one is not a floor, it is the same bug with a smaller number, and it would
 * still scroll on the narrowest supported screen.
 *
 * IT IS ARITHMETIC, not a feeling. The narrowest viewport this screen supports is
 * 1280. There the page leaves ~1161px of content, the treatment list takes its floor of
 * PANEL_MIN, the arch card's own border and padding take CARD_CHROME, and what is left
 * divides into ~46.3px a column. Anything above that scrolls at 1280 — which is why
 * the brief's suggested ~48 was not usable and this is 44: it clears the worst case
 * with room to spare rather than by a pixel. archScrollsAtViewport() below is how the
 * test sweeps it.
 *
 * A column this narrow is a bad chart and it is meant to be. It is reached only at the
 * bottom of the supported range, and the answer there is the collapse control on the
 * treatment list, which hands the whole panel width back to the teeth.
 */
export const HARD_MIN_TOOTH = 44;

/**
 * A HAIRLINE, so the row of surface grids reads as ONE BAND rather than sixteen
 * widgets. This is the whole of the "density" change and it is worth stating why
 * it overrules a number that was measured.
 *
 * DENTALLY.md's MEASURED GEOMETRY recorded "gap between teeth ~13px", and that is
 * what this constant was. Putting our chart beside a full-resolution Dentally
 * screenshot did not survive it: in the reference the adjacent surface grids ABUT
 * — the grid row is a continuous strip a clinician's eye crosses in one movement —
 * whereas 13px against an ~88px column is a 15% spread that made ours read as
 * sixteen separate cards. The 13px reading was almost certainly the column pitch
 * minus the drawn grid (88 - 75), which is a fact about their DIAGRAM's inset, not
 * about the space they leave between cells. A direct comparison of the two screens
 * beats a measurement off one of them, so the direct comparison wins.
 *
 * THE RECLAIMED SPACE GOES INTO THE TEETH, not into margin. The columns are `1fr`,
 * so eleven pixels per gap come straight back as column width: roughly 74px to
 * ~85px at 1920, which also moves TOWARDS the reference's measured 88px rather
 * than away from it. Closing the gaps and keeping the width are the same edit.
 *
 * NOT ZERO. Each grid strokes its own outline, so at 0 the two outlines of
 * neighbouring cells would sit flush and read as one doubled line — thicker than
 * every internal division and louder than some findings. Two pixels is the
 * smallest value that keeps a cell boundary legible while the row still reads as
 * continuous. Anything above a hairline fails the test beside this file.
 */
export const GAP = 2;

/** The R / L marker gutter at each end of every row. */
export const END_W = 26;

/**
 * The reference measurements, kept here so the test can name them and so a future
 * reader sees what the build is being held to rather than a bare number.
 * DENTALLY.md, MEASURED GEOMETRY, from a full-resolution screenshot (2026-08-02).
 */
export const DENTALLY = {
  /** Tooth column width. */
  tooth: 88,
  /** Surface grid, w x h. */
  grid: { w: 75, h: 72 },
  /** Crown diagram, w x h. TALLER than the grid, which is why the two are drawn
   *  in separate boxes rather than one. */
  crown: { w: 75, h: 85 },
  /**
   * SUPERSEDED, and kept because a number that was wrong is worth naming.
   *
   * "gap between teeth ~13px" is what came off the screenshot, and it is what GAP
   * used to be. The side-by-side comparison showed the reference's grids abutting,
   * so this is now read as the diagram's inset inside an 88px column (88 - 75), not
   * as space between cells. It stays here so the test can prove the guard would
   * catch a return to it rather than merely asserting today's number.
   */
  supersededGap: 13,
} as const;

/**
 * THE CEILING. The widest a tooth column is ever drawn, however much screen there is.
 *
 * WHY A CEILING EXISTS AT ALL. The columns were pure `minmax(0, 1fr)`, which is a
 * floor-less, ceiling-less instruction to absorb everything available. That was right
 * while the chart was too small and wrong the moment the record went full-bleed on
 * every tab: at a 1920 viewport the container measures ~1864px, which divides into
 * 114.63px per tooth — 30% over the reference. The owner put the two screens side by
 * side and said the page should fill the screen but "the actual chart still needs to
 * be smaller like dentallys". A cap is the only thing that can be true of both.
 *
 * IT IS ALSO THE HEIGHT FIX. The crown is drawn at a fixed 75/85 aspect against the
 * column, so an uncapped width made an uncapped height; the arch block was too tall
 * for exactly the same reason it was too wide, and capping the column fixes both.
 *
 * WHY 88 AND NOT A ROUNDER, SAFER, BIGGER NUMBER. It is DENTALLY.tooth itself, bound
 * to it rather than copied, so the cap cannot drift away from the thing it is meant
 * to match. The number came off one screenshot at one zoom on one monitor, so treat
 * it as the target rather than as physics — but nothing else on this screen is a
 * better estimate of it, and picking 96 or 104 "for safety" would be re-deciding by
 * feel the question the measurement already answers. If it reads small on the owner's
 * own monitor this constant is the single knob, and the tests beside this file are
 * written against MAX_TOOTH rather than against 88 so that moving it is a one-line
 * change and not a re-litigation.
 *
 * THE CAP CANNOT REACH THE FLOOR. MAX_TOOTH > MIN_TOOTH is what keeps the two rules
 * from meeting and pinning the arch to one fixed size, which is the build the owner
 * rejected first. It is asserted, not assumed.
 */
export const MAX_TOOTH = DENTALLY.tooth;

/** The aspect ratios the cells are drawn at, straight off the measurements. Strings
 *  because they land in a Tailwind `aspect-[..]` class, and written out in full
 *  there because Tailwind v4 scans raw source and cannot follow a variable. */
export const CROWN_ASPECT = `${DENTALLY.crown.w}/${DENTALLY.crown.h}`;
export const GRID_ASPECT = `${DENTALLY.grid.w}/${DENTALLY.grid.h}`;

// ===========================================================================
// THE TREATMENT LIST, AND WHY ITS WIDTH IS THE ARCH'S PROBLEM
//
// These four numbers are the layout the chart shares the screen with, kept here
// rather than only in chart-workspace.tsx because the arch's fit is a FUNCTION of
// them and a number nothing can assert is a number that drifts. vitest collects no
// .tsx, so a width living only in a class string is unreachable — which is precisely
// how a 400px panel shipped without anyone noticing it no longer left the arch room.
// ===========================================================================

/**
 * The treatment list's share of the content width. Dentally's own proportion:
 * ~435px of a ~1905px content area.
 */
export const PANEL_FRACTION = 0.228;

/**
 * THE FLOOR. Never narrower than the 300px the list had before it was widened, so
 * this change cannot make a small laptop worse than it already was.
 */
export const PANEL_MIN = 300;

/**
 * THE CEILING, and the number that caused this. 400px was measured right — 22.6% of
 * our ~1770px content at 1920, against the reference's 22.8% — and then applied as a
 * FIXED width at every viewport. At 1500 that same 400px is 29% of the content and it
 * takes the arch below its floor. The measurement was never wrong; treating a
 * proportion as a constant was.
 */
export const PANEL_MAX = 400;

/** The collapsed rail. One circular control, matching TreatmentPanel's own w-[56px]. */
export const PANEL_RAIL = 56;

/** `gap-4` between the treatment-list track and the chart track. */
export const WORKSPACE_GAP = 16;

/**
 * The arch card's own inset: a 1px border and 8px of padding, both sides. Measured in
 * the live DOM (`px-2`, `border`), and it matters because it is the difference between
 * an arch that fits and one that scrolls by 18px.
 */
export const CARD_CHROME = 18;

/**
 * How much content width the page chrome leaves, measured in the live DOM at 2026-08-02
 * across 1280–2560: the permanent nav rail and the record's own padding, and constant
 * across that range. Only the tests use it — the browser does its own subtraction — but
 * the acceptance criterion is stated in VIEWPORTS and this is the only honest way to
 * turn a viewport into the width the arch actually gets.
 */
export const PAGE_CHROME = 119;

/** The narrowest viewport this screen is held to. Below it, all bets are off. */
export const MIN_VIEWPORT = 1280;

/**
 * How wide the treatment list draws, given the content width beside it.
 *
 * CLAMPED, NOT FIXED — this is half the fix. `clamp(PANEL_MIN, PANEL_FRACTION,
 * PANEL_MAX)` is the same arithmetic the CSS `clamp()` in chart-workspace.tsx performs,
 * reproduced here so it can be asserted. On a wide monitor it sits at PANEL_MAX and the
 * verified Dentally parity is unchanged; on a narrow one it gives the difference back to
 * the teeth, which is exactly what the reference does and why the reference never
 * scrolls.
 */
export function panelWidth(contentWidth: number): number {
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, contentWidth * PANEL_FRACTION));
}

/**
 * The width the ARCH ITSELF is left with inside a content area of the given width:
 * the content, less the treatment list (or the collapsed rail), less the gap between
 * the two tracks, less the card's own border and padding.
 *
 * This is the number the owner's bug was about. It was never computed anywhere — the
 * panel width was chosen on one screen and the arch was left to cope — so nothing
 * could notice that at 1500 it had fallen 131px short.
 */
export function archAvailableWidth(contentWidth: number, panelOpen = true): number {
  const aside = panelOpen ? panelWidth(contentWidth) : PANEL_RAIL;
  return contentWidth - aside - WORKSPACE_GAP - CARD_CHROME;
}

/** Viewport in, arch width out. The acceptance criterion is written in viewports. */
export function archAvailableAtViewport(viewport: number, panelOpen = true): number {
  return archAvailableWidth(viewport - PAGE_CHROME, panelOpen);
}

/**
 * Everything that is not a tooth column: both R/L gutters and every gap.
 *
 * The grid is `END_W | 1fr x columns | END_W`, which is columns + 2 tracks and so
 * columns + 1 gaps. Getting that off by one is how a chart ends up one tooth-width
 * wider than its container and scrolls when it should not.
 */
export function archChrome(columns: number): number {
  return END_W * 2 + (columns + 1) * GAP;
}

/**
 * The width below which the arch scrolls rather than shrinking. Rendered as the
 * strip's `min-width`.
 *
 * IT IS THE HARD FLOOR THAT GOES HERE, not the preferred one, and that ordering is the
 * other half of the fix. With MIN_TOOTH in this slot the strip demanded 1078px of a
 * container that had 947, so the columns stopped shrinking 131px early and the card
 * scrolled — the arch was choosing its preferred size over fitting on the screen.
 */
export function archMinWidth(columns: number): number {
  return archChrome(columns) + columns * HARD_MIN_TOOTH;
}

/**
 * The width at which the arch reaches its PREFERRED column, MIN_TOOTH. Not a bound the
 * layout enforces — it is the line between "as big as it should be" and "shrunk to fit",
 * and it exists so the test can say which viewports fall on which side rather than
 * leaving the whole band below 62px undescribed.
 */
export function archPreferredWidth(columns: number): number {
  return archChrome(columns) + columns * MIN_TOOTH;
}

/**
 * The width the DRAWING will never exceed: the arch at its full size, gutters and
 * hairlines included. Rendered as the strip's `max-width`, with the strip centred in
 * the full-bleed container — which is how the page fills the screen while the chart
 * stops at Dentally's measure.
 */
export function archMaxWidth(columns: number): number {
  return archChrome(columns) + columns * MAX_TOOTH;
}

/**
 * What one tooth column actually measures, given the width the treatment panel
 * leaves the chart.
 *
 * This is the browser's own track division, reproduced so it can be asserted, and it
 * is CLAMPED AT BOTH ENDS because a fluid layout needs both. Between the two bounds
 * the columns divide everything they are given and no width is left over. Above
 * MAX_TOOTH they stop growing and the surplus becomes the air the arch centres in.
 * Below HARD_MIN_TOOTH they stop shrinking and the container scrolls instead, because
 * a surface too small to hit accurately is a mis-click and a mis-click here charts the
 * wrong tooth.
 *
 * THE LOWER CLAMP IS THE HARD FLOOR, NOT THE PREFERRED ONE. Clamping at MIN_TOOTH here
 * is what produced the owner's scrolling chart: it made "I would like 62px" outrank "I
 * must fit in 947px", so a column that could have drawn at 59px refused and overflowed
 * instead. Between HARD_MIN_TOOTH and MIN_TOOTH the arch is smaller than it wants and
 * still whole, which is the trade this screen wants in that band.
 */
export function toothColumnWidth(availableWidth: number, columns: number): number {
  if (columns <= 0) return 0;
  const fluid = (availableWidth - archChrome(columns)) / columns;
  return Math.min(MAX_TOOTH, Math.max(HARD_MIN_TOOTH, fluid));
}

/**
 * How wide the arch actually draws inside a container of the given width — which is
 * the container's width in the fluid band, and less than it once the cap bites.
 *
 * Named separately from the container width because conflating the two is the bug
 * this module now exists to prevent: the CARD fills the screen, the ARCH does not.
 */
export function archRenderedWidth(availableWidth: number, columns: number): number {
  return archChrome(columns) + columns * toothColumnWidth(availableWidth, columns);
}

/**
 * The air either side of the centred arch. Zero in the fluid band and below it; it
 * only opens up once the columns have stopped growing.
 *
 * CSS does this with `margin-inline: auto`, not with this number — this exists so the
 * centring is a thing the test suite can state, and so that "the arch is centred, not
 * left-aligned with a ragged right edge" is asserted rather than eyeballed.
 */
export function archSideAir(availableWidth: number, columns: number): number {
  return Math.max(0, (availableWidth - archRenderedWidth(availableWidth, columns)) / 2);
}

/**
 * The widest a gap may be, as a fraction of the cell beside it, before the arch
 * stops reading as one arch.
 *
 * A fraction rather than a pixel count because that is the thing the eye actually
 * judges: 13px is invisible beside a 400px card and is a chasm beside a 88px tooth.
 * The rejected build ran 13/88 — nearly 15% — and the row of grids read as sixteen
 * separate widgets. Five percent is the ceiling because at the narrowest column the
 * arch will ever draw (HARD_MIN_TOOTH) a 2px hairline is 4.5% of it, so the rule holds
 * at every width the layout can reach and still leaves no room to creep back up.
 */
export const HAIRLINE_MAX_FRACTION = 0.05;

/**
 * How wide the gap is RELATIVE to the tooth beside it, at a given chart width.
 *
 * This is the number the density complaint was actually about, so it is the number
 * the test asserts. A contributor who widens GAP to space things out fails here.
 */
export function gapFraction(availableWidth: number, columns: number): number {
  const tooth = toothColumnWidth(availableWidth, columns);
  return tooth === 0 ? 0 : GAP / tooth;
}

/** True when the arch has run out of room and its own container scrolls. The page
 *  body must never be the thing that scrolls sideways. */
export function archScrolls(availableWidth: number, columns: number): boolean {
  return availableWidth < archMinWidth(columns);
}

/**
 * THE ACCEPTANCE CRITERION, as a function: at this viewport, with the treatment list
 * open, does the arch scroll sideways?
 *
 * One sentence, and the whole of what the owner asked for. It is a function rather
 * than a line in a test because the regression lived in the GAP BETWEEN the widths
 * anyone thought to check — 1920 was fine, 1280 was fine, 1500 was not — so the thing
 * that has to be checkable is the property at every width, not the answer at a few.
 */
export function archScrollsAtViewport(viewport: number, columns: number, panelOpen = true): boolean {
  return archScrolls(archAvailableAtViewport(viewport, panelOpen), columns);
}

/**
 * The chart width a given tooth column needs — the inverse, and the honest way to
 * talk about "88px". It answers "how wide does this screen have to be", which is
 * the actual question, instead of pretending a fluid layout has one fixed size.
 */
export function chartWidthFor(toothWidth: number, columns: number): number {
  return archChrome(columns) + columns * toothWidth;
}
