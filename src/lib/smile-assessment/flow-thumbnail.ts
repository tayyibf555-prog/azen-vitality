// THE FLOW-SHAPE THUMBNAIL: the miniature of a funnel drawn on a gallery card.
//
// IT IS THE REAL DIAGRAM, NOT A DRAWING OF ONE. Every number below comes out of
// layoutFlow - the same ranking, the same barycentre row ordering, the same
// orthogonal router that draws the full-size canvas - run once more with small
// metrics and no text. So a card cannot show a shape the builder then contradicts:
// there is only one layout engine, and this is it at another size.
//
// WHY A SEPARATE MODULE AND NOT AN OPTION ON flow-layout.ts. flow-layout.ts is
// shipped and owned elsewhere; this is a PROJECTION of its output, in the same
// spirit as outlineOrder (flow-layout.ts:681) - a named, tested reduction rather
// than a second code path through the engine. Nothing here re-derives a position.
//
// NO REACT, NO BARREL, NO SERVER IMPORTS - the same boundary the layout keeps.
// NO COLOURS: a thumbnail is geometry, and the card puts the CSS custom
// properties on (flow-canvas.tsx:14-19 explains why a literal is not allowed).
//
// NO TRANSFORMS, for the tooth-shape.ts:483 reason. The miniature is centred by
// widening the VIEWBOX around the diagram, never by moving the diagram: one
// coordinate space in, one coordinate space out.

import type { FlowGraph, FlowNodeKind } from "./flow";
import { layoutFlow, round3, type LayoutMetrics } from "./flow-layout";

// ---------------------------------------------------------------------------
// The frame.
// ---------------------------------------------------------------------------

/**
 * Width/height of every thumbnail frame. Fixed, so a 3-across grid of cards has
 * one thumbnail shape rather than eight, and the SVG's default
 * preserveAspectRatio has nothing to letterbox.
 */
export const THUMBNAIL_ASPECT = 4.8;

/**
 * The frame's logical width when the diagram fits inside it - which every one of
 * the seven templates does. Holding the frame CONSTANT rather than fitting it to
 * each diagram is what makes the cards comparable: a six-step funnel genuinely
 * draws shorter than a nine-step one, instead of every funnel being stretched to
 * the same width and the difference disappearing.
 *
 * A diagram bigger than the frame widens it (see flowThumbnail), so an
 * unusually large authored funnel scales down rather than spilling out of view.
 */
export const THUMBNAIL_FRAME_W = 480;

/** Corner radius on a thumbnail card. Small rounded rects, per the brief. */
export const THUMBNAIL_RX = 3;

/**
 * The card text a thumbnail asks the layout for: none.
 *
 * Exported alongside THUMBNAIL_EDGE_LABEL and THUMBNAIL_METRICS so a test can run
 * the layout the EXACT way flowThumbnail runs it, rather than passing its own
 * copy of these three and proving only that two identical calls agree.
 */
export const THUMBNAIL_CONTENT = (): { title: string } => ({ title: "" });

/** Undefined means "draw an unlabelled wire" (flow-layout.ts:126). */
export const THUMBNAIL_EDGE_LABEL = (): string | undefined => undefined;

/**
 * Small metrics. Every text budget is ZERO on purpose: wrapText returns nothing
 * for a zero budget (flow-layout.ts:220), so a thumbnail card carries no title
 * lines and no option lines, and its height is therefore exactly `minH`. That is
 * how "no text" is enforced structurally rather than by remembering not to draw
 * any - there is no text in the layout to draw.
 */
export const THUMBNAIL_METRICS: Partial<LayoutMetrics> = {
  nodeW: 30,
  padX: 8,
  padY: 8,
  gutterX: 18,
  gapY: 8,
  headH: 0,
  titleLineH: 0,
  optionLineH: 0,
  bodyPadY: 0,
  minH: 14,
  corner: 4,
  stub: 6,
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

// ---------------------------------------------------------------------------
// The projection.
// ---------------------------------------------------------------------------

export interface ThumbnailNode {
  id: string;
  kind: FlowNodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner radius, carried here so the card computes nothing at all. */
  rx: number;
}

export interface ThumbnailEdge {
  /** Index into graph.edges, so a key is stable across renders. */
  index: number;
  /** The real orthogonal route: only M, H, V and C, exactly as the canvas draws. */
  d: string;
  /** False on a wire that doubles back - only possible on an invalid graph. */
  forward: boolean;
}

export interface FlowThumbnail {
  nodes: ThumbnailNode[];
  edges: ThumbnailEdge[];
  /** "x y w h" - the widened frame, with the diagram centred inside it. */
  viewBox: string;
  /** The same four numbers, for tests and for anything that needs them apart. */
  frame: { x: number; y: number; width: number; height: number };
  /** The diagram's own bounds before the frame was widened around it. */
  content: { width: number; height: number };
}

export interface ThumbnailOptions {
  aspect?: number;
  frameWidth?: number;
  rx?: number;
  metrics?: Partial<LayoutMetrics>;
}

/**
 * A funnel graph as a miniature: small rounded rects for the steps, the real
 * routed wires between them, no text, and a viewBox of a fixed aspect with the
 * diagram centred in it.
 *
 * PURE AND DETERMINISTIC. The same graph in produces byte-identical numbers out,
 * which is the property the gallery depends on - a card that reshuffled its own
 * picture between renders would read as a different template each time.
 */
export function flowThumbnail(graph: FlowGraph, opts: ThumbnailOptions = {}): FlowThumbnail {
  const aspect = opts.aspect && opts.aspect > 0 ? opts.aspect : THUMBNAIL_ASPECT;
  const frameW = opts.frameWidth && opts.frameWidth > 0 ? opts.frameWidth : THUMBNAIL_FRAME_W;
  const rx = opts.rx ?? THUMBNAIL_RX;

  const layout = layoutFlow(graph, {
    content: THUMBNAIL_CONTENT,
    edgeLabel: THUMBNAIL_EDGE_LABEL,
    metrics: { ...THUMBNAIL_METRICS, ...(opts.metrics ?? {}) },
  });

  // The frame is at least the fixed width, at least as wide as the diagram, and
  // at least wide enough that its derived height clears the diagram's height.
  // All three at once, so the diagram is always fully inside the frame.
  const width = Math.max(frameW, layout.width, layout.height * aspect);
  const height = width / aspect;
  const x = (layout.width - width) / 2;
  const y = (layout.height - height) / 2;

  const frame = {
    x: round3(x),
    y: round3(y),
    width: round3(width),
    height: round3(height),
  };

  return {
    nodes: layout.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      rx,
    })),
    edges: layout.edges.map((e) => ({ index: e.index, d: e.d, forward: e.forward })),
    viewBox: `${frame.x} ${frame.y} ${frame.width} ${frame.height}`,
    frame,
    content: { width: layout.width, height: layout.height },
  };
}
