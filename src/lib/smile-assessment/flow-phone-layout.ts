// THE PHONE-SCREEN STRIP: where each step of a funnel goes when the funnel is
// drawn as the SCREENS a patient actually sees, rather than as abstract cards.
//
// IT IS THE REAL DIAGRAM, NOT A SECOND ONE. Every number below comes out of
// layoutFlow - the same longest-path layering, the same barycentre row ordering,
// the same orthogonal router that draws the builder's canvas - run again with
// phone-sized metrics and NO TEXT. The strip therefore cannot show a shape the
// canvas contradicts: there is one layout engine, and this is it at another size.
//
// WHY A SEPARATE MODULE AND NOT AN OPTION ON flow-layout.ts. Exactly the
// flow-thumbnail.ts:9-12 argument: flow-layout.ts is shipped and owned elsewhere,
// and this is a PROJECTION of its output (like outlineOrder, flow-layout.ts:783) -
// a named, tested reduction rather than a second code path through the engine.
// Nothing here re-derives a position. flow-layout.ts and flow-canvas.tsx are not
// touched by this feature at all: the EDIT canvas keeps its compact cards.
//
// UNIFORM CARDS, STRUCTURALLY. A phone screen is a fixed rectangle - a taller one
// for the question with eight answers would read as a different device, not a
// longer screen. That is enforced the way the thumbnail enforces "no text": every
// text budget is ZERO, so wrapText returns nothing (flow-layout.ts:271), both line
// arrays come back empty, and the height is exactly `minH` for every node
// (flow-layout.ts:586-589, with headH and bodyPadY zeroed so the max() cannot
// pick the other branch). No node can grow, because there is nothing in the
// layout that could grow it.
//
// WHAT THIS MODULE DOES NOT CARRY: text, colours, radii. The minis are HTML
// positioned at these coordinates, so their type, palette and corners are CSS -
// flow-canvas.tsx:17-22 explains why a literal colour is not allowed in here, and
// the same goes for a font size. The only thing drawn in SVG is the wires.
//
// NO REACT, NO BARREL, NO SERVER IMPORTS, NO TRANSFORMS - the flow-layout.ts:12-19
// boundary, kept for the same reasons. One flat coordinate space in, one out, so
// the SVG wire underlay and the absolutely-positioned HTML minis read the SAME
// numbers and cannot disagree about where a screen is.

import { nodeMap, type FlowGraph, type FlowNodeKind } from "./flow";
import { layoutFlow, round3, DEFAULT_LAYOUT_METRICS, type LayoutMetrics } from "./flow-layout";

// ---------------------------------------------------------------------------
// The inputs. All three are exported so a test can run the layout the EXACT way
// phoneFlowLayout runs it, rather than passing its own copy of them and proving
// only that two identical calls agree (the flow-thumbnail.ts:51-57 rationale).
// ---------------------------------------------------------------------------

/** The card text this projection asks the layout for: none. See the header. */
export const PHONE_CONTENT = (): { title: string } => ({ title: "" });

/**
 * Undefined means "draw an unlabelled wire" (flow-layout.ts:149).
 *
 * THE WIRES CARRY NO ANSWER LABELS, and that is the point of the strip: the
 * answers are ON the screens now, as the option rows a patient taps, so a label
 * in the gutter would be the same words a second time, six inches from the row
 * they came from. The builder's canvas keeps its labels (describeEdge,
 * flow-edit.ts:485) because its cards cannot show the options at all.
 */
export const PHONE_EDGE_LABEL = (): string | undefined => undefined;

/**
 * Phone-sized metrics.
 *
 * `nodeW`/`minH` are the mini's box: a phone's WIDTH, and the height the screens
 * genuinely need (header lockup, progress, step chip, prompt and up to eight
 * answer rows). Not a handset's 2:1 aspect, deliberately - a mini shaped like a
 * real phone would have to clip its own answers, and a screen that hides the
 * options is a screen that lies about the funnel.
 *
 * `gapY` is RAISED above the canvas's 28 because these cards are seven times
 * taller: the same 28 between two 470-tall screens reads as two rows touching,
 * and it is also the return channel's depth (flow-layout.ts:696) on the back edge
 * a cyclic funnel draws.
 *
 * Every TEXT budget is zero on purpose - see the header. `edgeLabelChars: 0` is
 * the structural half of the unlabelled-wire decision above: even if something
 * handed this layout a label, there is no room budgeted to print it.
 */
export const PHONE_METRICS: Partial<LayoutMetrics> = {
  nodeW: 300,
  padX: 20,
  padY: 20,
  gutterX: 88,
  gapY: 40,
  headH: 0,
  titleLineH: 0,
  optionLineH: 0,
  bodyPadY: 0,
  minH: 470,
  corner: 16,
  stub: 24,
  labelLift: 0,
  textPad: 0,
  baseline: 0,
  titleChars: 0,
  optionChars: 0,
  maxTitleLines: 0,
  maxOptions: 0,
  edgeLabelChars: 0,
  labelCharW: 1,
};

// The card chrome metrics (cardRx, accentW, accentInsetY) are left at their
// defaults and never read: this projection emits no rect, no header strip and no
// accent bar, because a mini is HTML and its corners are CSS.

// ---------------------------------------------------------------------------
// The projection.
// ---------------------------------------------------------------------------

export interface PhoneNode {
  id: string;
  kind: FlowNodeKind;
  /** Column = longest path from the entry (flow-layout.ts:311). */
  col: number;
  /** Position within the column, top to bottom. */
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * THE NUMBER ON THE STEP CHIP: "Question 3". Derived from `col` here, so the
   * chip and the picture cannot disagree - the strip says third screen because
   * the screen is in the third column, not because something counted separately.
   *
   * Two adjustments, both facts about the runtime:
   *  - A welcome step draws the FIRST QUESTION'S screen (the hero copy sits above
   *    that question's prompt - deterministic-assessment-quiz.tsx:207-212,549-555),
   *    so it takes the step number of the column to its right.
   *  - A funnel that opens on a welcome step spends column 0 on it, so every
   *    question is one column further right than it is questions deep.
   *
   * Only meaningful on the two question-bearing kinds; screenFor ignores it on a
   * contact or result step, which have no chip.
   *
   * On a BRANCHING funnel a step can be reached by paths of different lengths;
   * this is the longest one, which is the column the picture puts it in.
   */
  step: number;
}

export interface PhoneEdge {
  /** Index into graph.edges, so a key is stable across renders. */
  index: number;
  from: string;
  to: string;
  /** The real orthogonal route: only M, H, V and C, exactly as the canvas draws. */
  d: string;
  /** False on a wire that doubles back - only possible on an invalid graph. */
  forward: boolean;
}

export interface PhoneFlowLayout {
  nodes: PhoneNode[];
  edges: PhoneEdge[];
  columns: number;
  rows: number;
  width: number;
  height: number;
  /**
   * "0 0 w h" - the diagram's own box, at 1:1.
   *
   * NO FRAME, unlike the thumbnail (flow-thumbnail.ts:156-162), and that is
   * load-bearing: the minis are HTML absolutely positioned at these very
   * coordinates in CSS pixels, so the SVG underneath has to be exactly this many
   * pixels wide and tall with no scaling of its own. A widened or letterboxed
   * viewBox would slide every wire off the screen it is meant to be leaving.
   */
  viewBox: string;
}

export interface PhoneLayoutOptions {
  metrics?: Partial<LayoutMetrics>;
}

/**
 * A funnel graph as a row of phone screens: one uniform box per step, the real
 * routed wires between them, and the box the pair of layers share.
 *
 * PURE AND DETERMINISTIC. The same graph in produces byte-identical numbers out,
 * and the graph is never mutated.
 */
export function phoneFlowLayout(graph: FlowGraph, opts: PhoneLayoutOptions = {}): PhoneFlowLayout {
  const layout = layoutFlow(graph, {
    content: PHONE_CONTENT,
    edgeLabel: PHONE_EDGE_LABEL,
    metrics: { ...PHONE_METRICS, ...(opts.metrics ?? {}) },
  });

  // A funnel that opens on a welcome step spends its first column on a step that
  // is not a question. Read off the graph rather than assumed, because a funnel
  // may open straight on a question (the runtime then renders the hero copy above
  // that question instead - deterministic-assessment-quiz.tsx:515,549).
  const entry = nodeMap(graph).get(graph.entry);
  const welcomeOffset = entry && entry.kind === "welcome" ? 1 : 0;

  return {
    nodes: layout.nodes.map((n) => {
      // A welcome step draws the screen of the question that follows it.
      const screenCol = n.kind === "welcome" ? n.col + 1 : n.col;
      return {
        id: n.id,
        kind: n.kind,
        col: n.col,
        row: n.row,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        // Never below 1: a stranded step parked in column 0 of a welcome-led
        // funnel would otherwise be announced as "Question 0".
        step: Math.max(1, screenCol - welcomeOffset + 1),
      };
    }),
    edges: layout.edges.map((e) => ({
      index: e.index,
      from: e.from,
      to: e.to,
      d: e.d,
      forward: e.forward,
    })),
    columns: layout.columns,
    rows: layout.rows,
    width: round3(layout.width),
    height: round3(layout.height),
    viewBox: layout.viewBox,
  };
}

/**
 * The metrics actually in force, defaults filled in. Exported so a caller (and a
 * test) can read the box a mini has to fit inside without knowing which fields
 * PHONE_METRICS chose to override.
 */
export function phoneMetrics(overrides: Partial<LayoutMetrics> = {}): LayoutMetrics {
  return { ...DEFAULT_LAYOUT_METRICS, ...PHONE_METRICS, ...overrides };
}

// ---------------------------------------------------------------------------
// WHERE A "+" GOES.
// ---------------------------------------------------------------------------

/** The box an "add a screen after this one" control occupies, in layout pixels. */
export interface PhoneAddPoint {
  /** The screen it sits after. The control's meaning; the strip never derives it. */
  nodeId: string;
  x: number;
  y: number;
  /** Square: the same number is its width and its height. */
  size: number;
}

/**
 * The control's own edge length, in the same pixels as everything else here.
 * Comfortably inside the 88px gutter it centres in.
 *
 * EXPORTED because the small-screen list draws the same control with no layout to
 * consult (it is a row between two stacked screens, not a dot in a gutter), and a
 * second number there would be a + that is one size on a desktop and another on a
 * phone - or, worse, one the fit check below is no longer measuring.
 */
export const PHONE_ADD_SIZE = 28;
const ADD_SIZE = PHONE_ADD_SIZE;

/**
 * The + between one screen and the next: centred in the gutter the wire leaves
 * through, level with the middle of the screen it belongs to.
 *
 * IT IS HERE AND NOT IN THE COMPONENT for the reason the header gives: a position
 * computed in JSX is a position no test can reach, and this one has two ways to be
 * subtly wrong (off-centre in the gutter, or outside the box the SVG and the minis
 * share, which would silently widen the scroll region). The strip renders
 * `left: x, top: y, width: size, height: size` and computes nothing.
 *
 * A SCREEN WITH NO WIRE OUT GETS NO +, and both reasons are load-bearing. There is
 * nothing to add a screen TO - insertQuestionOnEdge splices into a WIRE, so a
 * terminal step has no insertion point and planScreenInsertion refuses in words.
 * And a terminal step is in the last column, where the gutter is outside
 * `layout.width`: a control drawn there would hang off the diagram's own box.
 * Belt and braces, because the second is geometry this module can actually see:
 * the fit is checked rather than assumed.
 */
export function insertionPoints(
  layout: PhoneFlowLayout,
  metrics: LayoutMetrics = phoneMetrics(),
): PhoneAddPoint[] {
  const leaves = new Set(layout.edges.map((e) => e.from));
  const out: PhoneAddPoint[] = [];
  for (const n of layout.nodes) {
    if (!leaves.has(n.id)) continue;
    const x = round3(n.x + n.w + (metrics.gutterX - ADD_SIZE) / 2);
    if (x < 0 || x + ADD_SIZE > layout.width) continue;
    out.push({ nodeId: n.id, x, y: round3(n.y + (n.h - ADD_SIZE) / 2), size: ADD_SIZE });
  }
  return out;
}
