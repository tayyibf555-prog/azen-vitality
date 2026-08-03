import { useRef, useState } from "react";
import { archMaxWidth, archMinWidth, END_W, GAP, MAX_TOOTH } from "@/lib/charting/arch-metrics";
import { displayNumber } from "@/lib/charting/fdi";
import type { ArchRow } from "@/lib/charting/tooth-geometry";
import { CANNOT_READ_COPY } from "@/lib/patient/tabs";
import { cn } from "@/lib/utils";
import { ToothCrown, ToothGrid, TOOTH_PART_ORDER, type ToothPart } from "./tooth";
import { ToothTooltip } from "./tooth-tooltip";
import type {
  ChartItem,
  ChartPreferences,
  ChartReadHealth,
  DraftEntry,
  PlanRow,
  SurfaceId,
  ToothMark,
} from "@/lib/charting/types";

/**
 * THE FULL FDI ARCH: every row the current dentition draws, numbered outward from the
 * midline, with R and L at BOTH ends of every row.
 *
 * IT FILLS THE WIDTH, and that is the single change that makes this screen usable.
 * The owner's verdict on the first pass was "look at Dentally's chart, how it's easy
 * to read across the entire site — you make everything small, it should be bigger",
 * and DENTALLY.md's measurements agree by a factor of three: their tooth column is
 * ~88px against our 26px, their surface grid ~75x72px against our ~22px, and their
 * chart occupies ALL the width right of the treatment list rather than floating in a
 * centred box with air either side. A clinician reads this from a metre away across a
 * surgery. Small here is a legibility failure, not a style choice.
 *
 * THE CARD FILLS THE WIDTH; THE DRAWING STOPS AT DENTALLY'S MEASURE. That is the
 * owner's second verdict, verbatim: "it should fill the screen like this but still the
 * actual chart still needs to be smaller like dentallys" — two statements that only
 * contradict each other while the container and the drawing are the same thing. They
 * were: the columns were bare `1fr`, an instruction to absorb everything available,
 * with a floor and no ceiling. Once the record went full-bleed on every tab the
 * container measured ~1864px at a 1920 viewport, which is 114.63px a tooth against the
 * reference's ~88px — and since the crown is drawn at a fixed 75/85 aspect, the block
 * was too TALL for precisely the same reason. So the columns are now bounded tracks
 * (arch-metrics' MAX_TOOTH), and each strip is capped at archMaxWidth and centred with
 * `mx-auto` inside a card that still crosses the whole screen. Between the floor and
 * the ceiling nothing has changed: the teeth still grow with the screen, and are still
 * sized by aspect against whatever column width that yields.
 *
 * THE BAND IS NOT THE ARCH, and keeping the cap off it is the second half of that same
 * change. The cap first went on ONE wrapper around every strip, which left the row band
 * inside it and so made the backdrop exactly as wide as the teeth: a stripe stopping at
 * the last molar on a card half again its width, where the reference runs it across the
 * whole panel. The cap therefore lives on the STRIPS and on nothing the band is inside,
 * so a backdrop and a drawing no longer share one width. See the band below for why it
 * still WRAPS its grid rather than being painted as a sibling.
 *
 * IT ALSO READS AS ONE ARCH, which is the second half of the same complaint and was
 * only visible once the owner put the two screens side by side at full resolution.
 * The structure matched; the density did not. Dentally's adjacent surface grids ABUT
 * — the grid row crosses the screen as a single band the eye traverses in one
 * movement — where ours sat ~14% apart and read as sixteen separate widgets. So the
 * gap between columns is now a hairline (arch-metrics' GAP), and because the columns
 * are `1fr` the reclaimed space goes straight back into the teeth rather than into
 * margin: the arch keeps every pixel of its width AND the teeth get wider, moving
 * towards the reference's measured 88px instead of away from it. Closing the gaps and
 * refusing to shrink the arch are the same edit, not competing ones — Dentally's own
 * screen wastes ~70% of its width and that part is not worth copying.
 *
 * IT IS FOUR STRIPS PER ROW, NOT SIXTEEN TOOTH COLUMNS, which is DENTALLY.md's
 * measured vertical order: side labels, numbers, crowns, grids on the upper arch, then
 * grids, crowns, numbers, side labels on the lower, so the occlusal surfaces face each
 * other across the midline exactly as the arches meet. Laying it out as strips is also
 * what lets the faint grey band run the FULL WIDTH behind each grid row: sixteen
 * separately-painted rectangles would have to be kept in line by hand.
 *
 * THE ROW ORDER AND THE R/L MARKERS ARE DATA, NOT JSX. They arrive as `rows`, built
 * by lib/charting/tooth-geometry's archMarkers(), and this file renders them
 * verbatim. It never reverses, sorts or mirrors a row. The arch is drawn as the
 * CLINICIAN faces the patient, so quadrant 1 (the patient's upper right) sits on the
 * VIEWER'S LEFT: mirroring that is a wrong-site error, not a cosmetic one, and it is
 * asserted in tooth-geometry.test.ts precisely because a stray `flex-row-reverse`
 * here would otherwise mirror the whole mouth with a green suite.
 *
 * ONE COLUMN COUNT FOR THE WHOLE ARCH, taken from the widest row. In combined mode the
 * deciduous rows carry ten teeth against the permanent sixteen, so they are CENTRED in
 * the same sixteen columns and nest inside the permanent arch, which is where those
 * teeth actually are. Giving each row its own column count would draw a child's
 * deciduous teeth wider than their permanent ones.
 *
 * IT TAKES `health`. When health.items is "failed" every tooth renders as chrome with
 * no findings and makes no claim, and the always-visible status bar above says why.
 * An arch that structurally cannot report a failed read draws 32 clean teeth and
 * tells a clinician there are no findings, which is the loudest false claim available
 * on this screen.
 *
 * COMBINED renders BOTH dentitions, because `rows` simply carries four rows in that
 * mode. A mixed-dentition child's chart being half missing was the failure; nothing
 * here needs to know which mode it is in.
 *
 * ONE TAB STOP FOR THE WHOLE ARCH. 32 teeth x (5 surfaces + the crown) is 192
 * controls; individually tabbable they would put every control after the chart 192
 * presses away, which is not an auditable screen. So this is a roving tabindex: one
 * element carries tabIndex 0 and the arrows move the cursor. See moveCursor for the
 * exact mapping, which is deliberately simple and uniform rather than spatial,
 * because a nav model a clinician has to learn is a nav model nobody uses.
 *
 * SCROLLS, NEVER SHRINKS. Below MIN_STRIP the arch scrolls horizontally inside its
 * OWN container and never scrolls the page body. A tooth too small to hit accurately
 * is a mis-click, and a mis-click here charts the wrong tooth. Above it the columns
 * grow — as far as MAX_TOOTH, and then the extra width becomes air either side of a
 * centred arch rather than a bigger drawing.
 *
 * NO "use client": rendered only from chart-workspace.tsx, which owns the boundary.
 */

/**
 * THE SIZES LIVE IN lib/charting/arch-metrics.ts, NOT HERE, and that is the whole
 * reason this screen can be held to the owner's complaint.
 *
 * vitest collects only src/ ** / *.test.ts in a node environment, so a number written
 * into this .tsx is asserted by nothing and drifts back down one convenience at a
 * time — which is exactly how a 26px tooth column happened. arch-metrics.test.ts holds
 * the build to DENTALLY.md's measurements: that the columns divide ALL the remaining
 * width, that they reach the measured 88px at the viewport that measurement was taken
 * at, and that the floor never approaches the size that was rejected.
 *
 * MIN_TOOTH, GAP and END_W are all defined there. This file only lays them out.
 */

export interface ChartArchProps {
  /** Exactly what archMarkers(dentition).rows emits. Rendered verbatim. */
  rows: readonly ArchRow[];
  /** Items keyed by FDI number. A tooth absent from the map has no items, which is a
   *  fact; a failed read is `health.items`, which is not. */
  itemsByTooth: Record<number, ChartItem[]>;
  /** Whole-tooth (surfaceless) marks, keyed by FDI number. */
  marksByTooth: Record<number, ToothMark[]>;
  plans: PlanRow[];
  draft: Record<string, DraftEntry>;
  activeTooth: number | null;
  preferences: ChartPreferences;
  health: ChartReadHealth;
  onSurfaceIntent: (fdi: number, surface: SurfaceId, kind: "first" | "add") => void;
  onToothHover?: (fdi: number | null) => void;
  onToothFocus?: (fdi: number) => void;
  onOpenSocket: (fdi: number) => void;
}

interface Cursor {
  tooth: number;
  part: ToothPart;
}

export function ChartArch({
  rows,
  itemsByTooth,
  marksByTooth,
  plans,
  draft,
  activeTooth,
  preferences,
  health,
  onSurfaceIntent,
  onToothHover,
  onToothFocus,
  onOpenSocket,
}: ChartArchProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);

  const itemsFailed = health.items === "failed";
  // The tab stop must exist before anything is focused, and it must survive a
  // dentition switch that removes the tooth it was sitting on.
  const first = rows[0]?.teeth[0] ?? null;
  const live: Cursor | null =
    cursor && rows.some((r) => r.teeth.includes(cursor.tooth))
      ? cursor
      : first === null
        ? null
        : { tooth: first, part: "crown" };

  /** The detail panel follows focus first, then hover: a keyboard reader's position
   *  must not be overwritten by a mouse resting elsewhere on the screen. */
  const detailTooth = preferences.hover ? (focused ?? hovered) : focused;

  // The widest row sets the grid for every row, so a deciduous row nests inside the
  // permanent one rather than being stretched to the same 16 columns.
  const columns = rows.reduce((max, row) => Math.max(max, row.teeth.length), 1);
  const minStrip = archMinWidth(columns);
  const maxStrip = archMaxWidth(columns);
  // THE COLUMN HAS A CEILING. `minmax(0, MAX_TOOTH px)` still divides everything the
  // strip gives it — a track under its growth limit takes its share exactly as `1fr`
  // did — but it stops at the reference measure instead of absorbing a 1920 screen
  // into 114px teeth. The bare `minmax(0, 1fr)` this replaces is the mutation the
  // test beside arch-metrics.ts is written to catch.
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: `${END_W}px repeat(${columns}, minmax(0, ${MAX_TOOTH}px)) ${END_W}px`,
    columnGap: `${GAP}px`,
    alignItems: "end",
  };
  // THE CAP LIVES ON THE STRIP, NOT ON A WRAPPER ROUND EVERYTHING — because the
  // BAND is a backdrop and the ARCH is content, and the moment they share a width
  // constraint the backdrop is only ever as wide as the drawing.
  //
  // It did share one. Capping a single ancestor div was the right fix for "the
  // chart is bigger than Dentally's" and it silently took the row band with it: the
  // band lived inside that div, so at 2560 it stopped dead at the last molar with a
  // third of the card blank either side. The reference does the opposite — DENTALLY.md
  // records "a faint grey horizontal band sits behind each grid row, running the full
  // width", and in the screenshot the stripe crosses the whole panel with the teeth
  // sitting ON it. That was accidentally true while the arch WAS the container; now
  // that the arch is capped it has to be made true on purpose.
  //
  // So the cap and the centring move DOWN, onto the four strips a row draws. Every
  // strip is `mx-auto w-full` against this max, which is the same arithmetic the one
  // wrapper did and therefore lands them on identical pixel bounds — they share the
  // grid template, the width and the auto margins, so the numbers, the crowns and the
  // grids stay in column-perfect register. The band is left OUT of it, spanning the
  // full card, and it still WRAPS the grid strip rather than being painted beside it,
  // which is what keeps it vertically aligned with the row it backs. A full-width band
  // at the wrong height is worse than a short one at the right height.
  const stripStyle: React.CSSProperties = {
    ...gridStyle,
    maxWidth: `${maxStrip}px`,
  };

  function focusPart(next: Cursor) {
    setCursor(next);
    // tabIndex -1 elements are still programmatically focusable, so this can run in
    // the same handler as the key press: no effect, no dropped focus.
    containerRef.current
      ?.querySelector<SVGElement>(`[data-tooth="${next.tooth}"][data-part="${next.part}"]`)
      ?.focus();
  }

  function handleNavigate(fdi: number, part: ToothPart, key: string) {
    const next = moveCursor(rows, { tooth: fdi, part }, key);
    if (next) focusPart(next);
  }

  function handleHover(fdi: number | null) {
    setHovered(fdi);
    onToothHover?.(fdi);
  }

  function handleFocusPart(fdi: number, part: ToothPart) {
    setCursor({ tooth: fdi, part });
    setFocused(fdi);
    onToothFocus?.(fdi);
  }

  return (
    <div className="space-y-2">
      {/* The arch's own horizontal scroller. The page body never scrolls sideways. */}
      <div
        ref={containerRef}
        className="w-full overflow-x-auto rounded-lg border border-line bg-card px-2 py-3"
        role="group"
        aria-label="Tooth chart"
        // A right click IS the add-a-surface gesture here, so the browser's own
        // menu must never appear anywhere over the arch. Each surface polygon
        // already calls preventDefault, but the R/L markers, the number strips and
        // the gaps between teeth are not polygons, and a click landing in one of
        // those mid-charting opened the menu across the chart.
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* THE FULL-WIDTH LANE. This div carries NO cap: it is as wide as the card,
            and it is what the row band is allowed to span. Its only bound is the
            floor — below archMinWidth it stops shrinking, the parent's
            overflow-x-auto scrolls, and the page body still never scrolls sideways.
            The cap and the centring sit one level down, on each strip (stripStyle),
            so the drawing stops at Dentally's measure while the backdrop behind it
            does not. Under the floor there is no free space, the strips' auto margins
            collapse to zero, and the scroll case is exactly as it was. */}
        <div className="w-full space-y-3" style={{ minWidth: `${minStrip}px` }}>
          {rows.map((row, rowIndex) => {
            const upper = row.arch === "upper";
            // Where this row's teeth start inside the shared column count. A ten-tooth
            // deciduous row sits centred inside the sixteen permanent columns.
            const offset = Math.floor((columns - row.teeth.length) / 2);

            const labels = (
              <div className="mx-auto w-full" style={stripStyle} aria-hidden key="labels">
                <span className="text-center text-[13px] font-bold text-muted">
                  {row.leadingLabel}
                </span>
                <span style={{ gridColumn: `2 / span ${columns}` }} />
                <span className="text-center text-[13px] font-bold text-muted">
                  {row.trailingLabel}
                </span>
              </div>
            );

            const numbers = (
              <div className="mx-auto w-full" style={stripStyle} aria-hidden key="numbers">
                {row.teeth.map((fdi, i) => (
                  <span
                    key={fdi}
                    style={{ gridColumn: offset + i + 2 }}
                    className={cn(
                      "text-center text-[14px] font-semibold tabular-nums leading-tight text-ink",
                      // The midline: the one place a reader counts from.
                      i === row.teeth.length / 2 && "border-l border-line-strong",
                    )}
                  >
                    {displayNumber(fdi)}
                  </span>
                ))}
              </div>
            );

            const crowns = (
              <div className="mx-auto w-full" style={stripStyle} key="crowns">
                {row.teeth.map((fdi, i) => (
                  <div key={fdi} style={{ gridColumn: offset + i + 2 }} className="min-w-0">
                    <ToothCrown
                      fdi={fdi}
                      items={itemsByTooth[fdi] ?? []}
                      marks={marksByTooth[fdi] ?? []}
                      active={activeTooth === fdi}
                      focusedPart={live && live.tooth === fdi ? live.part : null}
                      itemsFailed={itemsFailed}
                      onHover={handleHover}
                      onFocusPart={handleFocusPart}
                      onNavigate={handleNavigate}
                      onOpenSocket={onOpenSocket}
                    />
                  </div>
                ))}
              </div>
            );

            // THE BAND. A faint stripe behind the surface grids only, running the FULL
            // WIDTH OF THE CARD — not the width of the arch. It is what makes one row
            // of surfaces read as one row from across the surgery.
            //
            // FULL WIDTH IS THE POINT, and it takes no width bound of its own for that
            // reason: no maxWidth, no mx-auto, nothing that could couple it back to the
            // drawing. DENTALLY.md: "a faint grey horizontal band sits behind each grid
            // row, running the full width", and the reference screenshot shows the
            // stripe crossing the whole panel well beyond the last molar, with the teeth
            // sitting on it. Capping the arch made that quietly false — the band was
            // inside the capped strip and so ended exactly where the teeth did.
            //
            // IT STILL WRAPS THE GRID. The cap moved onto the strip INSIDE this div
            // rather than the band moving out from under it, because wrapping is what
            // keeps the band's height and vertical position derived from the row it
            // backs. Painting a full-width rectangle as a sibling and positioning it by
            // hand would put a stripe of the right width at the wrong height, which is
            // a worse defect than the one being fixed.
            //
            // NEUTRAL, NOT BLUE. It was bg-card-muted, which is one of the app's cool
            // blue-grey surfaces, and side by side with Dentally that tint was doing
            // work it has no right to do: a blue wash under a chart whose findings are
            // colour-coded reads as a state, and cyan (the base chart) and steel
            // (completed) both sit on it. Dentally's own band is a faint neutral grey
            // that says nothing at all, which is the correct amount for a backdrop to
            // say. --chart-row-band is the chart palette's neutral, declared beside
            // the other --chart-* tokens; the fallback keeps a row band painted rather
            // than vanishing to transparent if that token is ever renamed.
            //
            // THE NAME IS LOAD-BEARING AND WAS ONCE WRONG. This read var(--chart-band)
            // while globals.css declared --chart-row-band, so the var() silently took
            // its fallback and the band went on painting the exact blue-grey this
            // change existed to remove — green tests, unchanged pixels. A token
            // reference that misses is invisible in CSS by design; the test below now
            // reads the declaration out of globals.css rather than trusting a literal.
            //
            // A var() in a style prop, not a Tailwind class, for the reason recorded at
            // the --chart-* block in globals.css: Tailwind v4 scans raw source, so a
            // class built around a token would emit no rule and paint nothing.
            const grids = (
              <div
                key="grids"
                className="rounded-[4px] py-1.5"
                style={{ backgroundColor: "var(--chart-row-band, var(--card-muted))" }}
              >
                <div className="mx-auto w-full" style={stripStyle}>
                  {row.teeth.map((fdi, i) => (
                    <div key={fdi} style={{ gridColumn: offset + i + 2 }} className="min-w-0">
                      <ToothGrid
                        fdi={fdi}
                        items={itemsByTooth[fdi] ?? []}
                        plans={plans}
                        draft={draft}
                        active={activeTooth === fdi}
                        focusedPart={live && live.tooth === fdi ? live.part : null}
                        itemsFailed={itemsFailed}
                        onSurfaceIntent={onSurfaceIntent}
                        onHover={handleHover}
                        onFocusPart={handleFocusPart}
                        onNavigate={handleNavigate}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );

            // DENTALLY.md's vertical order, and the reason the lower arch is the
            // mirror of the upper: the crowns sit OUTBOARD (roots pointing away from
            // the midline) and the grids INBOARD, so the two rows of occlusal
            // surfaces face each other in the middle of the chart.
            return (
              <div key={`${row.teeth[0]}-${rowIndex}`} className="space-y-[3px]">
                {upper ? [labels, numbers, crowns, grids] : [grids, crowns, numbers, labels]}
              </div>
            );
          })}
        </div>
      </div>

      {/* PERMANENT, beneath the arch, in quiet grey. treatment_plan_items carries
          treatment items and NOT dentition, so a confidently drawn 32-tooth arch for
          a patient with six extractions is a false clinical picture. This is the
          largest residual risk on the screen and it is stated in place rather than
          in a comment. */}
      <p className="text-[11px] leading-[1.45] text-faint">{CANNOT_READ_COPY.toothStatus}</p>

      {/* ALWAYS RENDERED, even with nothing hovered. A panel that appears and
          disappears reflows the arch under the cursor, and a mis-click here charts
          the wrong tooth. The hover preference suppresses hover as a SOURCE; focus
          always feeds it, or the keyboard route would reach a tooth and learn
          nothing. */}
      <ToothTooltip
        fdi={detailTooth}
        items={detailTooth === null ? [] : (itemsByTooth[detailTooth] ?? [])}
        plans={plans}
        itemsFailed={itemsFailed}
      />
    </div>
  );
}

/**
 * THE ROVING CURSOR, and the reason it is uniform rather than spatial.
 *
 * Left and Right walk the six parts of a tooth in TOOTH_PART_ORDER and then carry on
 * into the next tooth. Up and Down move to the same column in the row above or below,
 * which is the arch switch. Home and End jump to the ends of the row.
 *
 * A spatially-mapped model (Up from the centre goes to the top trapezoid, and so on)
 * reads better on paper and is worse in practice: mesial and distal swap sides across
 * the midline and buccal flips between arches, so the same key would move in opposite
 * directions on two teeth a clinician thinks of as the same. Uniform beats clever
 * here, exactly as PRODUCT.md says of notation.
 *
 * Kept small and pure so that if it grows it can move to a .ts module and be tested;
 * vitest collects only src/ ** / *.test.ts, so nothing in a .tsx is covered.
 */
function moveCursor(rows: readonly ArchRow[], cursor: Cursor, key: string): Cursor | null {
  const rowIndex = rows.findIndex((r) => r.teeth.includes(cursor.tooth));
  if (rowIndex < 0) return null;
  const row = rows[rowIndex];
  const col = row.teeth.indexOf(cursor.tooth);
  const partIndex = TOOTH_PART_ORDER.indexOf(cursor.part);

  if (key === "Home") return { tooth: row.teeth[0], part: "crown" };
  if (key === "End") return { tooth: row.teeth[row.teeth.length - 1], part: "crown" };

  if (key === "ArrowUp" || key === "ArrowDown") {
    const nextRow = rows[rowIndex + (key === "ArrowUp" ? -1 : 1)];
    if (!nextRow) return null;
    const nextCol = Math.min(col, nextRow.teeth.length - 1);
    return { tooth: nextRow.teeth[nextCol], part: cursor.part };
  }

  const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return null;
  const nextPart = partIndex + step;
  if (nextPart >= 0 && nextPart < TOOTH_PART_ORDER.length) {
    return { tooth: cursor.tooth, part: TOOTH_PART_ORDER[nextPart] };
  }
  const nextCol = col + step;
  if (nextCol < 0 || nextCol >= row.teeth.length) return null;
  return {
    tooth: row.teeth[nextCol],
    part: step > 0 ? TOOTH_PART_ORDER[0] : TOOTH_PART_ORDER[TOOTH_PART_ORDER.length - 1],
  };
}
