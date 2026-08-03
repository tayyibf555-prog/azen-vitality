import { cn } from "@/lib/utils";
import { fdiLabel, toothLongLabel } from "@/lib/charting/fdi";
import { toothShape } from "@/lib/charting/tooth-shape";
import { SURFACE_ORDER, regionsForBoxSide, surfaceLayout } from "@/lib/charting/surfaces";
import type { SurfaceRegion } from "@/lib/charting/surfaces";
import {
  regionOrigin,
  surfaceStyle,
  toothFunding,
  unreadSurfaceItems,
  unreadValuesFor,
} from "@/lib/charting/render-state";
import { intentFromKey, intentFromPointer } from "@/lib/charting/selection";
import { FUNDING_LABEL } from "@/lib/calendar/funding";
import type { ChartItem, DraftEntry, PlanRow, SurfaceId, ToothMark } from "@/lib/charting/types";

/**
 * ONE TOOTH, IN TWO CELLS: the crown diagram and the surface grid.
 *
 * IT IS TWO COMPONENTS AND NOT ONE, and that is the measured layout rather than a
 * refactor. DENTALLY.md's MEASURED GEOMETRY puts the arch in horizontal STRIPS —
 * numbers, crowns, grids, then the lower arch's grids, crowns, numbers — with a faint
 * grey band running the full width BEHIND EACH GRID ROW. A single component owning
 * both halves of a tooth cannot be banded that way without painting sixteen separate
 * rectangles and hoping they line up. So chart-arch.tsx lays out four strips and this
 * file renders one cell of each.
 *
 * BIG IS THE REQUIREMENT, NOT THE TASTE. The owner's verdict on the first pass was
 * that everything is small and should be bigger, and the measurements agree by a
 * factor of three: Dentally's tooth column is ~88px against our 26px, its surface grid
 * ~75x72px against our ~22px. A clinician reads this chart from a metre away across a
 * surgery, so legibility here is a safety property and not a style one. Every size in
 * this file is therefore expressed as an ASPECT against a column width the arch sets,
 * so the chart grows to fill a 1920 reception monitor instead of floating in a centred
 * box. The measured ratios (crown 75x85, grid 75x72) are the aspects.
 *
 * AND THE TOOTH IS A TOOTH, not a dome. The first pass drew all fifty-two positions
 * as the same rounded lozenge, and set beside the real Dentally screen that is the
 * most visible thing wrong with this chart. A clinician identifies a tooth by its
 * SILHOUETTE before ever reading the number strip — a molar is a broad crown on a
 * splayed tripod, an incisor a chisel on a single spike — and fifty-two identical
 * domes delete that channel entirely on the one screen where naming the wrong tooth
 * is the named hazard. tooth-shape.ts owns the anatomy: root count and cusp count
 * per FDI position, the crown and root outlines, and the upper/lower mirror. It is
 * a .ts for the same reason everything else here is: an upper 6 having three roots
 * and its lower counterpart two is a clinical fact, and a fact no test can reach
 * drifts. This file draws the `d` it is handed.
 *
 * THIS FILE STILL COMPUTES NO ANATOMY. Which surface sits on which edge of the grid
 * comes from surfaceLayout(), and which REGIONS cover that edge comes from
 * regionsForBoxSide() over surfaceRegions() — all tested .ts, because vitest collects
 * only src/**\/*.test.ts,
 * node environment, no .tsx, and a transposed mapping here mirrors the whole mouth
 * with a green suite. The polygons below are POSITIONS IN A NORMALISED VIEWBOX, fixed
 * constants that are identical for every tooth in the mouth: they carry no
 * left/right, no upper/lower and no mesial/distal, so there is nothing in them that
 * can be wrong for half the arch.
 *
 * MOLARS HAVE EIGHT REGIONS, and that is why the region list is asked for per tooth.
 * Dentally numbers surfaces 1-5 on incisors, canines, premolars and deciduous teeth
 * and 1-8 on molars, subdividing the centre square into four quadrants. Drawing five
 * regions on a molar silently drops three chartable surfaces. surfaceRegions() owns
 * that split; this file draws whatever it is handed.
 *
 * NO POINTER EVENTS. The handlers are onClick, onContextMenu, onAuxClick and
 * onKeyDown, and they hand the raw event fields to intentFromPointer/intentFromKey,
 * which decide. A pointerdown falls outside intentFromPointer's union entirely, and
 * widening that union makes a right click fire pointerdown(button 2) AND contextmenu,
 * which under reducer rule 5 adds a surface and then immediately removes it, so a
 * right click silently does nothing. onContextMenu calls preventDefault so the
 * browser menu never covers the chart; the key handler calls preventDefault on Space
 * so the page does not scroll under the clinician mid-chart.
 *
 * COLOURS TRAVEL AS CSS VARIABLE NAMES and land in SVG `fill`/`stroke` via `style`.
 * NEVER an interpolated Tailwind arbitrary-value class: globals.css records that the
 * charting variables are deliberately outside @theme inline, so a fill utility built
 * around one of them renders transparent and a completed filling would draw as an
 * unmarked tooth.
 *
 * AND THE EXAMPLE IS NOT WRITTEN OUT HERE, deliberately. Tailwind v4's scanner does
 * not parse comments: it extracts candidates from raw source, so an arbitrary-value
 * class spelled out in this banner was emitted into globals.css as a real rule. With
 * an ellipsis inside the variable name that rule is not valid CSS, lightningcss threw
 * on it, and `next dev` answered 500 on every route in the application, because every
 * route imports the layout that imports globals.css. `next build` recovered from the
 * same error silently, so CI stayed green while local development was dead.
 *
 * WHOLE-TOOTH MARKS ARE DRAWN. An extraction, crown, bridge, endo or implant carries
 * no surfaces at all, so a per-surface renderer alone would draw a clean, unmarked
 * tooth for a planned extraction. That was the most direct route from this screen to
 * a wrong-site event, so it is fixed in code: a ring around the crown and a count.
 *
 * AND SO IS THE THIRD CASE, which is the one that arrives from live data. Dentally
 * sends surfaces as INTEGERS (1-5, and 1-8 on molars), and surfaces.ts refuses to
 * guess an anatomical NAME for an index it cannot place, so the value lands in
 * unrecognisedSurfaces. Such an item is not whole-tooth and fills no region, so
 * without a mark of its own it draws NOTHING: a real restoration rendering as a clean
 * tooth by a second route. It gets a dotted crown outline and its values in the
 * label, and the status bar carries the count.
 *
 * A FAILED READ IS NOT A CLEAN TOOTH. When `itemsFailed` is true this renders the
 * chrome and no findings at all, and the always-visible status bar above the arch
 * says why. Thirty-two confidently clean teeth is the loudest false claim available
 * on this screen.
 *
 * NO "use client" HERE. This is an undirected universal module: it attaches DOM
 * handlers and takes function props, and it inherits the boundary from
 * chart-workspace.tsx, the one client file in the chart. A server component that
 * rendered it would build green and throw at render.
 */

/**
 * THE GRID'S NORMALISED VIEWBOX, in DENTALLY.md's measured 75 x 72 proportion. The
 * numbers are 100 x 96 rather than 75 x 72 so the region constants below are whole
 * units; the RENDERED size comes from the arch's column width via CSS aspect-ratio,
 * which is what lets one chart fill both a laptop and a reception monitor.
 */
const GRID_VIEW = { w: 100, h: 96 } as const;

/**
 * THE CONSTRUCTION, from the spec: an outer square, a smaller inner square, and a
 * diagonal from each outer corner to the matching inner corner. That is four
 * trapezoids around a centre. A 25% inset on every side puts the inner square at
 * exactly half the outer, which is the NEBDN charting diagram every UK clinician
 * already reads.
 */
const INSET = 0.25;

const OX1 = GRID_VIEW.w;
const OY1 = GRID_VIEW.h;
const IX0 = GRID_VIEW.w * INSET;
const IY0 = GRID_VIEW.h * INSET;
const IX1 = GRID_VIEW.w - IX0;
const IY1 = GRID_VIEW.h - IY0;
const CX = GRID_VIEW.w / 2;
const CY = GRID_VIEW.h / 2;

/** The four peripheral trapezoids. Positions, never anatomy: which surface sits on
 *  which edge is surfaceLayout()'s answer and it differs by quadrant. */
const EDGE_POINTS: Record<"top" | "right" | "bottom" | "left", string> = {
  top: `0,0 ${OX1},0 ${IX1},${IY0} ${IX0},${IY0}`,
  right: `${OX1},0 ${OX1},${OY1} ${IX1},${IY1} ${IX1},${IY0}`,
  bottom: `${OX1},${OY1} 0,${OY1} ${IX0},${IY1} ${IX1},${IY1}`,
  left: `0,${OY1} 0,0 ${IX0},${IY0} ${IX0},${IY1}`,
};

/** The centre square, whole, for everything that is not a permanent molar. */
const CENTRE_POINTS = `${IX0},${IY0} ${IX1},${IY0} ${IX1},${IY1} ${IX0},${IY1}`;

/** The centre square quartered, for permanent molars, which carry indices 5-8 in
 *  there. Four quadrants, not four cusp NAMES: see the aria labels below. */
const QUADRANT_POINTS: Record<"tl" | "tr" | "br" | "bl", string> = {
  tl: `${IX0},${IY0} ${CX},${IY0} ${CX},${CY} ${IX0},${CY}`,
  tr: `${CX},${IY0} ${IX1},${IY0} ${IX1},${CY} ${CX},${CY}`,
  br: `${CX},${CY} ${IX1},${CY} ${IX1},${IY1} ${CX},${IY1}`,
  bl: `${IX0},${CY} ${CX},${CY} ${CX},${IY1} ${IX0},${IY1}`,
};

function regionPoints(region: SurfaceRegion): string {
  if (region.kind === "peripheral") return EDGE_POINTS[region.edge];
  if (region.kind === "centre-quadrant") return QUADRANT_POINTS[region.corner];
  return CENTRE_POINTS;
}

/** The parts of a tooth the roving cursor can land on. The crown is one of them
 *  because it is a control in its own right: it opens the socket panel. */
export type ToothPart = SurfaceId | "crown";

/** M-O-D-B-L, then the crown first, which is the order Left/Right walks. */
export const TOOTH_PART_ORDER: readonly ToothPart[] = [
  "crown",
  "mesial",
  "occlusal",
  "distal",
  "buccal",
  "lingual",
];

/** The keys the arch resolves rather than this file. Everything else falls through. */
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * A style value from render-state may arrive as a bare variable name
 * (`--chart-planned-fill`) or already wrapped (`var(--chart-planned-fill)`). Accept
 * both rather than render transparent if the two builds disagree by one wrapper.
 */
function cssVar(name: string | null): string | undefined {
  if (!name) return undefined;
  return name.startsWith("var(") ? name : `var(${name})`;
}

/** "upper right 6, tooth 16" - the full spoken name plus the two-digit FDI number,
 *  because reconciling against Dentally is this screen's whole purpose. */
function spokenTooth(fdi: number): string {
  return `${toothLongLabel(fdi)}, tooth ${fdiLabel(fdi)}`;
}

/** The diary's own funding tokens, reused verbatim. Not a Tailwind class: these
 *  variables are outside @theme inline for the reason globals.css records. */
const FUND_VAR: Record<string, string> = {
  nhs: "var(--fund-nhs)",
  private: "var(--fund-private)",
  udc: "var(--fund-udc)",
};

/** Shared by both cells, so the arch passes one object twice and the two halves of a
 *  tooth can never disagree about which tooth they are. */
export interface ToothCellProps {
  fdi: number;
  /** The Dentally items touching THIS tooth. Empty is a real answer; a failed read
   *  is `itemsFailed`, and the two must never look alike. */
  items: ChartItem[];
  /** The reducer's selected tooth, not the focus cursor. */
  active: boolean;
  /** Where the arch's single roving tab stop currently sits, or null for every tooth
   *  that is not the focused one. */
  focusedPart: ToothPart | null;
  /** health.items === "failed". Renders chrome and makes no claim. */
  itemsFailed: boolean;
  onHover: (fdi: number | null) => void;
  onFocusPart: (fdi: number, part: ToothPart) => void;
  onNavigate: (fdi: number, part: ToothPart, key: string) => void;
}

export interface ToothCrownProps extends ToothCellProps {
  /** Whole-tooth marks (surfaceless items), precomputed by the arch. */
  marks: ToothMark[];
  onOpenSocket: (fdi: number) => void;
}

export interface ToothGridProps extends ToothCellProps {
  plans: PlanRow[];
  /** The whole draft map, keyed `${tooth}:${treatmentCode}`, exactly as ChartState
   *  holds it. Passed by reference: render-state does the lookup. */
  draft: Record<string, DraftEntry>;
  onSurfaceIntent: (fdi: number, surface: SurfaceId, kind: "first" | "add") => void;
}

/** The tint that marks the reducer's selected tooth. Applied to BOTH cells, or half a
 *  tooth would light up. */
const ACTIVE_CELL = "bg-tint-blue ring-1 ring-blue-royal/40";

/**
 * THE CROWN CELL: the cream tooth diagram, its whole-tooth ring, and the funding rail.
 *
 * The SHAPE is toothShape()'s, and it is real dental anatomy rather than a rounded
 * box: a crown with this tooth's cusps on it and this tooth's roots underneath, the
 * roots pointing away from the occlusal plane in both arches. It is rendered in its
 * OWN viewBox — 75 x 85, DENTALLY.md's measured crown slot — rather than the full
 * per-tooth box, which is what decouples the crown's rendered height from the grid's.
 * The measured proportions are crown 75 x 85 and grid 75 x 72: the crown is TALLER
 * than the grid, and a single shared box cannot express that.
 *
 * ONE PATH, NOT SEVEN. `silhouette` is the crown and every root as subpaths of a
 * single `d`. Filled it is their union, so the tooth is one solid shape and one hit
 * target and the socket click keeps working anywhere on the tooth; stroked, the
 * subpath edges show, which is what makes the furcation visible and a molar
 * distinguishable from an incisor at a glance. Drawing the roots as separate elements
 * would have meant the whole-tooth ring, the unread outline and the focus ring each
 * needing to be repeated once per root, three chances for the ring to disagree with
 * the tooth it is meant to be ringing.
 *
 * THE CREAM IS THE TOOTH AND NEVER A FINDING, WHICH IS AN INVARIANT OF THIS FILE
 * RATHER THAN A PROPERTY OF THE COLOUR. --chart-tooth is now a real warm cream
 * instead of the near-white it was, because beside Dentally's own screen an
 * unfilled crown read as line art. That only stays safe while EVERY crown in the
 * mouth carries the same cream whether it is charted or not, which is to say while
 * the rule below holds:
 *
 *   NOTHING BELOW MAY EVER SET A `fill` ON THE SILHOUETTE FROM AN ORIGIN.
 *
 * A whole-tooth finding is a 3px RING and the unplaceable-surface mark is a dotted
 * outline; both are strokes, and the fill on the base path is the constant
 * --chart-tooth. Painting a state into the crown would make the cream a scale — a
 * lightly charted tooth — and there is no way for a reader to tell the bottom of
 * that scale from an unmarked tooth. If a future state genuinely needs to colour a
 * whole tooth, give it a stroke, a dash pattern or a glyph, not this fill.
 */
export function ToothCrown({
  fdi,
  items,
  marks,
  active,
  focusedPart,
  itemsFailed,
  onHover,
  onFocusPart,
  onNavigate,
  onOpenSocket,
}: ToothCrownProps) {
  const shape = toothShape(fdi);
  // The crown and every root as one `d`. Every path below draws THIS, so the ring
  // and the outline can never trace a different tooth from the one being charted.
  const crown = shape.silhouette;
  const upper = shape.upper;
  // A failed read makes no claim about funding either: the codes come from the same
  // rows that did not arrive.
  const funding = itemsFailed ? [] : toothFunding(fdi, items);
  // Items naming a surface we could not place on the grid. Never merged into
  // `marks`: a whole-tooth ring means "this treatment concerns the whole tooth",
  // and these mean "this treatment concerns a surface we cannot show you".
  const unread = itemsFailed ? [] : unreadSurfaceItems(fdi, items);
  // Through render-state, not by reading the item here: an out-of-scheme INDEX is
  // as unplaceable as an unreadable letter and must be printed beside the ring
  // just the same, and only render-state knows which indices this tooth can hold.
  const unreadValues = (itemsFailed ? [] : unreadValuesFor(fdi, items)).join(" ");
  const spoken = spokenTooth(fdi);
  const railLabel =
    funding
      .map((code) => FUNDING_LABEL[code])
      .filter(Boolean)
      .join(" and ") || undefined;
  const markStyle = marks.length > 0 ? surfaceStyle(marks[0].origin) : null;

  function handleKey(e: React.KeyboardEvent) {
    if (NAV_KEYS.has(e.key)) {
      e.preventDefault();
      onNavigate(fdi, "crown", e.key);
      return;
    }
    // Space scrolls the page by default, which under a clinician's hand mid-chart
    // moves the arch out from under the cursor.
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onOpenSocket(fdi);
    }
  }

  return (
    <div
      className={cn(
        // The rail sits on the GRID-FACING edge in both arches, so the colour bar is
        // always the thing nearest the surfaces it funds and never collides with the
        // number strip on the outboard side.
        "relative flex min-w-0 flex-col rounded-[3px]",
        upper ? "flex-col" : "flex-col-reverse",
        active && ACTIVE_CELL,
      )}
      onMouseEnter={() => onHover(fdi)}
      onMouseLeave={() => onHover(null)}
    >
      <svg
        // The crown's own box, so its rendered height is set by the arch and not by
        // the grid's. The viewBox IS the measured 75 x 85 slot, so the shape is
        // never anisotropically stretched — a squashed molar is a molar that does
        // not read as one. Non-scaling strokes keep the hairline a hairline at every
        // column width.
        viewBox={shape.viewBox}
        overflow="visible"
        className="aspect-[75/85] w-full select-none"
        aria-label={
          unread.length > 0
            ? `${spoken}. Surfaces we could not place: ${unreadValues}. See History.`
            : spoken
        }
        role="group"
      >
        {/* The crown IS a control: the socket menu is where a Dentally user's cursor
            goes for tooth status, and tooth status is precisely what we cannot read. */}
        <path
          d={crown}
          role="button"
          tabIndex={focusedPart === "crown" ? 0 : -1}
          data-tooth={fdi}
          data-part="crown"
          aria-label={`${spoken}, tooth status`}
          style={{ fill: "var(--chart-tooth)", stroke: "var(--chart-tooth-line)" }}
          strokeWidth={focusedPart === "crown" ? 2.5 : 1}
          vectorEffect="non-scaling-stroke"
          className="cursor-pointer outline-none focus-visible:stroke-[var(--blue-royal)]"
          onClick={() => onOpenSocket(fdi)}
          // A right click aimed slightly wide of a surface lands here. Without this
          // the browser's own context menu opens over the chart mid-charting, which
          // is the one thing the surface handlers already go to trouble to prevent.
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={handleKey}
          onFocus={() => onFocusPart(fdi, "crown")}
        />

        {/* Whole-tooth marks: extraction, crown, bridge, endo, implant. They carry no
            surfaces, so without this ring a planned extraction draws as a clean
            tooth. Never a fill: the fill belongs to the surfaces.
            pointerEvents none because a stroked path is hit-testable and this ring
            sits over the crown, so without it the ring would swallow the clicks that
            open the socket panel. */}
        {!itemsFailed && markStyle ? (
          <path
            d={crown}
            fill="none"
            aria-hidden
            pointerEvents="none"
            style={{ stroke: cssVar(markStyle.lineVar) }}
            strokeWidth={3}
            vectorEffect="non-scaling-stroke"
            strokeDasharray={markStyle.dashed ? "6 4" : undefined}
          />
        ) : null}

        {/* A surface value we could not place. A DOTTED crown outline, which is
            neither the solid ring of a whole-tooth finding nor the dashed one of a
            draft: three different statements, three different strokes, so none of
            them can be read as another. The values themselves are in the label
            above, in the tooltip and in History, because the mark says only that
            there is something here. */}
        {unread.length > 0 ? (
          <path
            d={crown}
            fill="none"
            aria-hidden
            pointerEvents="none"
            style={{ stroke: "var(--chart-tooth-line)" }}
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
            strokeDasharray="1.5 3.5"
            strokeLinecap="round"
          />
        ) : null}
      </svg>

      {/* More than one whole-tooth finding on one tooth. HTML rather than SVG text:
          the crown box scales with the column, so SVG text inside it would be
          re-sized by the viewport and would be 11px on a laptop and something else
          on a reception monitor. A count that shrinks is a count nobody reads. */}
      {!itemsFailed && marks.length > 1 ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-0 rounded-[3px] bg-card px-1 text-[11px] font-bold leading-tight text-navy",
            // Clear of the funding rail, which sits on the grid-facing edge.
            upper ? "top-0" : "bottom-2",
          )}
        >
          {marks.length}
        </span>
      ) : null}

      {/* The funding rail: one segment per DISTINCT code, because a tooth can carry an
          NHS filling and a private crown at once. Same vocabulary and the same tokens
          as the diary's block rail, never a second colour system. "unknown" draws
          NOTHING, following funding.ts's own rule that a code we cannot resolve must
          not put a mark on the screen a reader could take for a fact. It is still
          counted in History, where it can be named. */}
      <div
        className="mx-auto mt-[3px] mb-[3px] flex h-[5px] w-[70%] gap-[2px]"
        aria-label={railLabel}
        role={railLabel ? "img" : undefined}
      >
        {funding
          .filter((code) => code !== "unknown")
          .map((code) => (
            <span
              key={code}
              title={FUNDING_LABEL[code]}
              className="h-full flex-1 rounded-[1px]"
              style={{ background: FUND_VAR[code] }}
            />
          ))}
      </div>
    </div>
  );
}

/**
 * THE SURFACE GRID CELL: five regions on most teeth, eight on a permanent molar.
 *
 * WHICH SURFACE THE CLICK CHARTS is resolved through surfaceLayout(), the same tested
 * table tooth-geometry.ts uses, so mesial stays toward the midline on both halves of
 * the mouth. The four centre quadrants of a molar all resolve to the OCCLUSAL surface
 * FOR CHARTING, because a click has to name a surface our draft table can store and we
 * cannot claim to know which cusp index 7 is. Calibrating that is CHARTING.md 3.6's
 * open item, and until it closes, four quadrants sharing one honest answer is better
 * than four quadrants carrying four guessed ones.
 *
 * READING IS PER REGION, AND THAT IS NOT THE SAME THING. Live Dentally names surfaces
 * by INDEX, so quadrants 5, 6, 7 and 8 of a molar are four separate findings and
 * regionOrigin fills each from its own index. Filling by surface NAME would have
 * painted the whole occlusal table for a filling Dentally recorded on one quadrant.
 * Drawing where Dentally drew is a position, which is safe; the anatomy is still never
 * named.
 *
 * ONLY THE FIRST REGION OF EACH SURFACE IS A TAB TARGET. The roving cursor walks the
 * six named parts of a tooth; if all four molar quadrants answered to "occlusal" the
 * cursor would land on whichever the DOM returned first and the arch would grow three
 * unreachable duplicates in the tab order. So the primary region carries data-part and
 * the tab stop, and the rest stay mouse controls with their own labels.
 */
export function ToothGrid({
  fdi,
  items,
  plans,
  draft,
  active,
  focusedPart,
  itemsFailed,
  onSurfaceIntent,
  onHover,
  onFocusPart,
  onNavigate,
}: ToothGridProps) {
  const layout = surfaceLayout(fdi);
  const spoken = spokenTooth(fdi);

  // POSITIONS ONLY, and both halves of the walk come from surfaces.ts: surfaceLayout()
  // says which box side this tooth's mesial is on, and regionsForBoxSide() says which
  // regions cover that side — one on a rim edge, four on a molar's centre, one on
  // everything else's. Nothing here counts, splits, renumbers or mirrors. The union
  // over SURFACE_ORDER is exactly surfaceRegions(fdi), because surfaceLayout uses each
  // of the five box sides once and regionsForBoxSide partitions on the side.
  const regions = SURFACE_ORDER.flatMap((surface) =>
    regionsForBoxSide(fdi, layout[surface]).map((region, i) => ({
      region,
      surface,
      // The first region of each surface is the one the roving cursor lands on.
      primary: i === 0,
      // PER REGION, not per surface. Live Dentally names surfaces by INDEX, and a
      // molar's four centre quadrants are four different indices: rolling them up
      // to one occlusal answer would fill all four for a filling recorded on one.
      // regionOrigin still matches a NAMED surface across the whole box side, so
      // the mock and our own draft table keep filling exactly as before.
      origin: itemsFailed
        ? ("none" as const)
        : regionOrigin(fdi, surface, region, items, plans, draft),
    })),
  );
  const hasDraft = regions.some((r) => r.origin === "draft");

  function handleKey(surface: SurfaceId, e: React.KeyboardEvent) {
    if (NAV_KEYS.has(e.key)) {
      e.preventDefault();
      onNavigate(fdi, surface, e.key);
      return;
    }
    if (e.key === " " || e.key === "Enter") e.preventDefault();
    const kind = intentFromKey({ key: e.key, shiftKey: e.shiftKey });
    if (kind === "first" || kind === "add") onSurfaceIntent(fdi, surface, kind);
  }

  function handlePointer(
    surface: SurfaceId,
    type: "click" | "contextmenu" | "auxclick",
    e: React.MouseEvent,
  ) {
    if (type === "contextmenu") e.preventDefault();
    const kind = intentFromPointer({
      type,
      button: e.button,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    });
    if (kind === "first" || kind === "add") onSurfaceIntent(fdi, surface, kind);
  }

  return (
    <div
      // No padding: the grid must be the same width as the crown above it, or the two
      // halves of a tooth read as two different columns from across the room. The
      // active ring is a box-shadow and costs no layout.
      className={cn("min-w-0 rounded-[3px]", active && ACTIVE_CELL)}
      onMouseEnter={() => onHover(fdi)}
      onMouseLeave={() => onHover(null)}
    >
      <svg
        viewBox={`0 0 ${GRID_VIEW.w} ${GRID_VIEW.h}`}
        overflow="visible"
        className="aspect-[75/72] w-full select-none"
        role="group"
        aria-label={`${spoken}, surfaces`}
      >
        {regions.map(({ region, surface, primary, origin }) => {
          const style = surfaceStyle(origin);
          const focused = primary && focusedPart === surface;
          return (
            <polygon
              key={`${region.kind}-${region.index}`}
              points={regionPoints(region)}
              role="button"
              tabIndex={focused ? 0 : -1}
              data-tooth={primary ? fdi : undefined}
              data-part={primary ? surface : undefined}
              aria-label={`${spoken}, ${surface}, surface ${region.index}${
                style.label ? `, ${style.label}` : ""
              }`}
              aria-pressed={origin !== "none"}
              style={{
                // WHITE, not transparent. The grid rows sit on a faint grey band
                // (--chart-row-band), so a transparent uncharted surface would take
                // the band's grey and read as a charted one from the other side of a
                // surgery. The 1.14:1 between --card and that band is the whole
                // reason a row of unmarked surfaces reads as white squares on paper,
                // so the two tokens have to be judged together and not separately.
                fill: cssVar(style.fillVar) ?? "var(--card)",
                // A DARK hairline, per the measured spec. --chart-tooth-line is the
                // crown's pale outline and disappears at this size against the band.
                stroke: origin === "none" ? "var(--muted)" : cssVar(style.lineVar),
              }}
              strokeWidth={focused ? 3 : 1}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="miter"
              strokeDasharray={style.dashed ? "5 3" : undefined}
              // An UNCHARTED surface must stay clickable: it is the surface a
              // clinician charts FIRST, so if hit-testing ever stopped counting its
              // fill as painted, every empty surface on the chart would go dead.
              pointerEvents="all"
              className="cursor-pointer outline-none focus-visible:stroke-[var(--blue-royal)]"
              onClick={(e) => handlePointer(surface, "click", e)}
              onContextMenu={(e) => handlePointer(surface, "contextmenu", e)}
              onAuxClick={(e) => handlePointer(surface, "auxclick", e)}
              onKeyDown={(e) => handleKey(surface, e)}
              onFocus={() => onFocusPart(fdi, surface)}
            />
          );
        })}

        {/* The draft glyph: a corner tick, so our own planning is distinguishable from
            a Dentally finding by SHAPE and not by colour alone. A hatched trapezoid
            photographed into a complaint file, or read by a red-green deficient
            clinician, is not a distinction that survives. */}
        {hasDraft ? (
          <polygon
            points={`0,0 ${GRID_VIEW.w * 0.22},0 0,${GRID_VIEW.h * 0.22}`}
            style={{ fill: "var(--chart-draft-line)" }}
            pointerEvents="none"
            aria-hidden
          />
        ) : null}
      </svg>
    </div>
  );
}
