// ===========================================================================
// TOOTH GEOMETRY: the actual SVG path data for one tooth.
//
// THIS FILE EXISTS BECAUSE VITEST COLLECTS ONLY .ts. Geometry written inside
// tooth.tsx would be geometry no test can reach, and the wrong-site property
// (mesial on the correct side, buccal on the correct edge, R at the correct end
// of the row) is the one property on this screen that must not be able to break
// silently. A transposed coordinate here fails a test; the same coordinate in a
// .tsx mirrors the whole mouth with a green suite.
//
// PURE, and unit-free: the box is a viewBox, and the renderer scales it.
//
// LAYOUT. The crown sits on the OUTER side of the surface grid, so the upper
// and lower rows face each other across the number strip, exactly as the
// reference draws it.
//
//        upper tooth              lower tooth
//        +-------------+          +-------------+
//        |   crown     |          |  surfaces   |
//        +-------------+          +-------------+
//        |  surfaces   |          |   crown     |
//        +-------------+          +-------------+
// ===========================================================================

import { archOf, archRows } from "./fdi";
import { SURFACE_ORDER, surfaceLayout } from "./surfaces";
import type { BoxSide, Dentition, SurfaceId } from "./types";

/** The per-tooth viewBox. */
export const TOOTH_BOX = { width: 24, height: 40 } as const;

/** The side of the surface grid. The four trapezoids are this deep. */
const GRID = 24;
const INSET = 6;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfacePath {
  surface: SurfaceId;
  side: BoxSide;
  d: string;
  /** The polygon's centroid: where a glyph or a letter sits, and what the tests
   *  measure the mirror against. */
  labelPoint: Point;
}

/** Where the five-region grid sits inside the box, for THIS tooth's arch. */
export function gridRect(fdi: number): Rect {
  const upper = archOf(fdi) === "upper";
  return { x: 0, y: upper ? TOOTH_BOX.height - GRID : 0, width: GRID, height: GRID };
}

/** Where the crown outline sits: always the far side of the grid. */
export function crownRect(fdi: number): Rect {
  const upper = archOf(fdi) === "upper";
  const height = TOOTH_BOX.height - GRID;
  return { x: 2, y: upper ? 0 : GRID, width: TOOTH_BOX.width - 4, height };
}

function polygon(points: readonly Point[]): { d: string; labelPoint: Point } {
  const d =
    points.map((p, i) => `${i === 0 ? "M" : "L"} ${round(p.x)} ${round(p.y)}`).join(" ") + " Z";
  const labelPoint = {
    x: round(points.reduce((sum, p) => sum + p.x, 0) / points.length),
    y: round(points.reduce((sum, p) => sum + p.y, 0) / points.length),
  };
  return { d, labelPoint };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function sidePolygon(side: BoxSide, r: Rect): readonly Point[] {
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.width;
  const y1 = r.y + r.height;
  const ix0 = x0 + INSET;
  const iy0 = y0 + INSET;
  const ix1 = x1 - INSET;
  const iy1 = y1 - INSET;
  switch (side) {
    case "top":
      return [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: ix1, y: iy0 },
        { x: ix0, y: iy0 },
      ];
    case "right":
      return [
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: ix1, y: iy1 },
        { x: ix1, y: iy0 },
      ];
    case "bottom":
      return [
        { x: x1, y: y1 },
        { x: x0, y: y1 },
        { x: ix0, y: iy1 },
        { x: ix1, y: iy1 },
      ];
    case "left":
      return [
        { x: x0, y: y1 },
        { x: x0, y: y0 },
        { x: ix0, y: iy0 },
        { x: ix0, y: iy1 },
      ];
    default:
      return [
        { x: ix0, y: iy0 },
        { x: ix1, y: iy0 },
        { x: ix1, y: iy1 },
        { x: ix0, y: iy1 },
      ];
  }
}

/**
 * The five regions of one tooth, already resolved through surfaceLayout, so
 * mesial/distal and buccal/lingual are placed correctly FOR THIS TOOTH.
 *
 * tooth.tsx is a .map() over this and computes nothing of its own.
 */
export function toothPaths(fdi: number): SurfacePath[] {
  const rect = gridRect(fdi);
  const layout = surfaceLayout(fdi);
  // In M-O-D-B-L order, so the DOM order and the surfaces code agree and the
  // roving-tabindex arrow keys walk the surfaces in the order a dentist reads.
  return SURFACE_ORDER.map((surface) => {
    const side = layout[surface];
    const { d, labelPoint } = polygon(sidePolygon(side, rect));
    return { surface, side, d, labelPoint };
  });
}

/**
 * The crown outline: a rounded box with a suggestion of cusps, drawn away from
 * the grid so the two rows face each other. Shape only, no state.
 */
export function crownPath(fdi: number): string {
  const r = crownRect(fdi);
  const upper = archOf(fdi) === "upper";
  const x0 = round(r.x);
  const x1 = round(r.x + r.width);
  const mid = round(r.x + r.width / 2);
  // The occlusal edge is the one nearest the grid; the root end is the far one.
  const nearGrid = upper ? round(r.y + r.height) : round(r.y);
  const farEdge = upper ? round(r.y) : round(r.y + r.height);
  const shoulder = upper ? round(r.y + r.height * 0.35) : round(r.y + r.height * 0.65);
  const cusp = upper ? round(r.y + r.height * 0.82) : round(r.y + r.height * 0.18);
  return [
    `M ${x0} ${shoulder}`,
    `Q ${x0} ${farEdge} ${mid} ${farEdge}`,
    `Q ${x1} ${farEdge} ${x1} ${shoulder}`,
    `L ${x1} ${cusp}`,
    `Q ${mid} ${nearGrid} ${x0} ${cusp}`,
    "Z",
  ].join(" ");
}

export interface ArchRow {
  teeth: readonly number[];
  arch: "upper" | "lower";
  dentition: "permanent" | "deciduous";
  /** ALWAYS "R": quadrants 1, 4, 5 and 8 lead every row, because the chart is
   *  drawn as the clinician faces the patient. */
  leadingLabel: "R" | "L";
  trailingLabel: "R" | "L";
}

/**
 * The rows the arch renders, with their end markers as DATA.
 *
 * chart-arch.tsx renders this verbatim, so a stray flex-row-reverse or a
 * swapped marker fails a test rather than mirroring the mouth.
 */
export function archMarkers(dentition: Dentition): { rows: ArchRow[] } {
  const rows = archRows(dentition).map((teeth) => {
    const first = teeth[0];
    return {
      teeth,
      arch: archOf(first),
      dentition: (Math.floor(first / 10) >= 5 ? "deciduous" : "permanent") as
        | "permanent"
        | "deciduous",
      leadingLabel: "R" as const,
      trailingLabel: "L" as const,
    };
  });
  return { rows };
}
