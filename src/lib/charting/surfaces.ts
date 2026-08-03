// ===========================================================================
// THE FIVE-REGION SURFACE GRID: four trapezoids around a centre square.
//
// PURE.
//
// THE TRAP THIS MODULE EXISTS FOR. Mesial means TOWARD THE MIDLINE. So on the
// viewer's left half of the chart (quadrants 1 and 4, the patient's right) the
// midline is to the RIGHT, and mesial is the right-hand trapezoid. On the
// viewer's right half they swap. A layout that draws mesial on one fixed side
// is wrong for half the mouth, and being wrong here records a filling on the
// wrong surface of the right tooth, which is the hardest kind of error to spot
// afterwards.
//
// Buccal always points AWAY from the centre of the page: top on the upper arch,
// bottom on the lower. Lingual is always opposite it. Occlusal is always the
// centre square.
//
// TWO NOTATION DECISIONS, both recorded rather than invented:
//   - DENTALLY.md:91 calls the anterior centre region OCCLUSAL, so we do too.
//     Anteriors have an incisal edge and many charts print I, but inventing a
//     label the reference does not use is exactly the drift this screen is
//     meant to close. It is an open question for the next screenshot.
//   - Lingual is used on BOTH arches, per DENTALLY.md. Many UK charts print P
//     for palatal on the upper. If the screenshot says otherwise it is a
//     one-line change in SURFACE_LETTER and nothing else moves.
//
// DENTALLY SENDS SURFACE INDICES, NOT LETTERS, AND THEY RESOLVE TO A POSITION.
// The API sentence, quoted in DENTALLY.md and again in CHARTING.md §3.2:
// "Surfaces are numbered 1-5 for incisors, canines, premolars and deciduous
// teeth and 1-8 for molar teeth. Surface numbering starts from the top left
// hand corner of the tooth and is counted clockwise around the edge of the
// tooth and into the center."
//
// THE CORRECTION THIS BLOCK REPLACES, and why it mattered. An earlier reading
// said the sentence determines nothing, so every integer was carried into
// `unrecognised` and drawn nowhere. The mock speaks in letters, so dev looked
// right; live Dentally speaks in integers (CHARTING.md §2.6, measured across 500
// real production rows), so on a REAL patient every surface fell into that
// bucket and the arch rendered thirty-two teeth with no fills — a positive claim
// that a patient with a full restorative history has none. Blank is not a safe
// default on a clinical chart.
//
// What the sentence does determine is a POSITION, which is all a diagram needs:
// it describes Dentally's own picture of the tooth ("the top left hand corner"),
// counted clockwise round the rim and then into the middle. So:
//   1 = top trapezoid, 2 = right, 3 = bottom, 4 = left
//   5 = the centre square            (5-scheme: incisors, canines, premolars,
//                                     and ALL deciduous teeth)
//   5, 6, 7, 8 = the four quadrants of a subdivided centre, clockwise from the
//                top-left                        (8-scheme: permanent molars)
//
// WHAT IT DOES NOT DETERMINE IS THE ANATOMY, and that line is held here rather
// than apologised for downstream. Which named surface sits at the top of
// Dentally's box depends on how it orients each quadrant, and nothing public
// says. Filling the correct region is safe; calling it "buccal" in text is a
// wrong-surface clinical claim. So a SurfaceRegion carries a position and the
// verbatim index, never a SurfaceId, and the tooltip, History and the export
// print "surface 2" until Dentally confirms the anatomy. A test asserts that no
// region object can ever hold a surface name.
//
// THE MAPPING IS SCREEN-FIXED, NOT MIRRORED. Index 2 is the right-hand trapezoid
// on every tooth in every quadrant, which means it is a DIFFERENT anatomical
// surface on the two sides of the mouth. CHARTING.md §3.4 lists screen-fixed vs
// anatomically-fixed as an open fork; DENTALLY.md resolves it positionally and
// this module follows DENTALLY.md. The choice is pinned by its own test, so
// resolving the fork upstream fails loudly here instead of drifting.
//
// AN INDEX OUTSIDE THE TOOTH'S OWN SCHEME IS STILL REFUSED — 7 on an incisor has
// no region, and it is never clamped or nudged onto the nearest one. It goes to
// `unrecognised`, stays visible in the tooltip, in History, in the export and in
// the status-bar count, exactly as an unreadable letter does. A guessed region
// is indistinguishable on screen from a real reading, which is why guessing is
// worse than not drawing.
// ===========================================================================

import { archOf, displayNumber, isDeciduous, isTooth, sideOf } from "./fdi";
import type { BoxSide, SurfaceId } from "./types";

/** M-O-D-B-L, so a mesio-occluso-distal serialises as "MOD", the most
 *  recognised code in dentistry, and never as "DMO". */
export const SURFACE_ORDER: readonly SurfaceId[] = [
  "mesial",
  "occlusal",
  "distal",
  "buccal",
  "lingual",
];

export const SURFACE_LETTER: Record<SurfaceId, string> = {
  mesial: "M",
  occlusal: "O",
  distal: "D",
  buccal: "B",
  lingual: "L",
};

export const SURFACE_LABEL: Record<SurfaceId, string> = {
  mesial: "mesial",
  occlusal: "occlusal",
  distal: "distal",
  buccal: "buccal",
  lingual: "lingual",
};

const BY_LETTER: ReadonlyMap<string, SurfaceId> = new Map(
  SURFACE_ORDER.map((s) => [SURFACE_LETTER[s], s]),
);
const BY_NAME: ReadonlyMap<string, SurfaceId> = new Map(SURFACE_ORDER.map((s) => [s, s]));

/** De-duplicates and re-sorts into M-O-D-B-L. Never drops. */
export function canonicaliseSurfaces(surfaces: readonly SurfaceId[]): SurfaceId[] {
  return SURFACE_ORDER.filter((s) => surfaces.includes(s));
}

export function serialiseSurfaces(surfaces: readonly SurfaceId[]): string {
  return canonicaliseSurfaces(surfaces)
    .map((s) => SURFACE_LETTER[s])
    .join("");
}

export interface ParsedSurfaces {
  surfaces: SurfaceId[];
  /** The integer surface indices Dentally actually sends, sorted and
   *  de-duplicated. Resolved to a region PER TOOTH by regionForIndex, because
   *  1-5 and 1-8 are different schemes and only the tooth decides which. */
  indices: number[];
  /** Values Dentally sent that we cannot place: an unknown letter, an unreadable
   *  word, an integer outside 1-8. KEPT, so the tooltip and History can show
   *  them. A value dropped at the mapper is a finding the clinician never learns
   *  exists. */
  unrecognised: string[];
}

/** The widest index any scheme holds. 9 is not a surface on any tooth Dentally
 *  charts, so it is refused here rather than clamped onto 8. */
const MAX_SURFACE_INDEX = 8;

/**
 * Dentally's `surfaces` field, in whatever shape it arrives.
 *
 * THE LIVE SHAPE IS AN ARRAY OF INTEGERS — [5], [3, 7, 8] — measured against
 * production, not inferred (CHARTING.md §2.6). Those land in `indices`.
 *
 * The letter and long-name forms ("MOD", "M,O,D", ["mesial","occlusal"]) are
 * kept because the local mock emits them and our own draft table stores them,
 * and because a letter is unambiguous where an index is not. A tolerant parser
 * that dropped one form to accept the other would trade a blank chart in dev for
 * a blank chart in production.
 *
 * An ABSENT value is not an unrecognised one: a whole-tooth treatment
 * (extraction, crown, bridge) legitimately carries no surfaces, and that is
 * reported by ChartItem.wholeTooth rather than as a parse failure.
 */
export function parseSurfaces(raw: unknown): ParsedSurfaces {
  const tokens: string[] = [];
  // A BARE NUMBER IS A REAL WIRE SHAPE, and one value: `12` is not "1 then 2",
  // it is a twelve that no scheme holds. A compact STRING is a code and is read
  // character by character below, exactly as "MOD" is.
  if (typeof raw === "number") tokens.push(String(raw));
  else if (typeof raw === "string") tokens.push(...splitSurfaceString(raw));
  else if (Array.isArray(raw)) {
    for (const part of raw) {
      if (typeof part === "string") tokens.push(...splitSurfaceString(part));
      else if (part !== null && part !== undefined) tokens.push(String(part));
    }
  }

  const surfaces: SurfaceId[] = [];
  const indices: number[] = [];
  const unrecognised: string[] = [];
  for (const token of tokens) {
    const t = token.trim();
    if (t.length === 0) continue;
    const hit = BY_NAME.get(t.toLowerCase()) ?? BY_LETTER.get(t.toUpperCase());
    if (hit) {
      if (!surfaces.includes(hit)) surfaces.push(hit);
      continue;
    }
    // An integer in range is a SURFACE INDEX. Out of range it is not nudged into
    // one: 0, 9 and 12 name no region on any tooth and are reported instead.
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_SURFACE_INDEX) {
      if (!indices.includes(n)) indices.push(n);
      continue;
    }
    if (!unrecognised.includes(t.toUpperCase())) unrecognised.push(t.toUpperCase());
  }
  return {
    surfaces: canonicaliseSurfaces(surfaces),
    // Ascending, so two reads of the same row order their fills and their
    // printed "surfaces 3, 8" identically.
    indices: indices.sort((a, b) => a - b),
    unrecognised,
  };
}

/**
 * One string value into tokens, and the ONE place a surface can be fabricated.
 *
 * THE BUG THIS EXISTS TO KILL. The previous rule was "no delimiter, so split
 * into characters", which meant the single word "occlusal" became O, C, C, L, U,
 * S, A, L: the trailing L matched LINGUAL, and the chart filled the lingual
 * trapezoid of a tooth that has no lingual restoration. Every one of "mesial",
 * "distal", "buccal" and "occlusal" ends in the letter L, so the whole
 * long-form vocabulary produced a fabricated lingual finding. A fabricated
 * positive on a clinical chart is worse than a missing one, because nothing on
 * screen distinguishes it from a real reading.
 *
 * So: a delimited value splits on the delimiter; a whole value that IS a known
 * name or a known letter is one token; a short compact value is read as a code
 * and split per character; and anything else is kept WHOLE as one unrecognised
 * token rather than mined for letters that happen to match.
 */
function splitSurfaceString(raw: string): string[] {
  const cleaned = raw.trim();
  if (cleaned.length === 0) return [];
  if (/[,;\s]/.test(cleaned)) return cleaned.split(/[,;\s]+/);
  // A whole known value: "occlusal", "M", "mesial".
  if (BY_NAME.has(cleaned.toLowerCase()) || BY_LETTER.has(cleaned.toUpperCase())) return [cleaned];
  // A compact ALL-DIGIT code: "135", or "12345678" on a molar. Eight is the
  // widest the 8-scheme can be. Kept apart from the letter branch below so that
  // widening it cannot start mining longer WORDS for letters, which is the
  // fabrication bug above.
  if (cleaned.length <= 8 && /^[0-9]+$/.test(cleaned)) return cleaned.split("");
  // A compact letter code: "MOD", "MODX". Five characters is the widest a
  // five-region code can be, so nothing longer is read letter by letter.
  if (cleaned.length <= 5 && /^[A-Za-z0-9]+$/.test(cleaned)) return cleaned.split("");
  // Something else entirely. Kept whole and reported, never mined.
  return [cleaned];
}

/**
 * Which box side each surface occupies ON THIS TOOTH.
 *
 * Everything about the mirror lives here, so tooth-geometry.ts and the renderer
 * can be dumb about it.
 */
export function surfaceLayout(fdi: number): Record<SurfaceId, BoxSide> {
  const patientRight = sideOf(fdi) === "right";
  const upper = archOf(fdi) === "upper";
  return {
    // The patient's right sits on the viewer's LEFT, so its midline is to the
    // right of the box.
    mesial: patientRight ? "right" : "left",
    distal: patientRight ? "left" : "right",
    // Buccal points away from the centre of the page on both arches.
    buccal: upper ? "top" : "bottom",
    lingual: upper ? "bottom" : "top",
    occlusal: "centre",
  };
}

// ===========================================================================
// REGIONS. A surface index resolved to a POSITION on the diagram.
// ===========================================================================

export type SurfaceEdge = "top" | "right" | "bottom" | "left";
/** Clockwise from the top-left, matching the rim. */
export type SurfaceCorner = "tl" | "tr" | "br" | "bl";

/**
 * Where one surface index sits on one tooth's grid. NEVER an anatomical name:
 * see the header. `index` travels with the position so the tooltip, History and
 * the export can print what Dentally actually said.
 */
export type SurfaceRegion =
  | { kind: "peripheral"; index: number; edge: SurfaceEdge }
  /** Non-molars, index 5: the undivided centre square. */
  | { kind: "centre"; index: number }
  /** Permanent molars, indices 5-8: the four quadrants of a subdivided centre. */
  | { kind: "centre-quadrant"; index: number; corner: SurfaceCorner };

/** Clockwise from the top, because Dentally counts "clockwise around the edge".
 *  The order IS the mapping: position 0 of this array is index 1. */
const EDGES: readonly SurfaceEdge[] = ["top", "right", "bottom", "left"];
/** Clockwise from the top-left, continuing "and into the center". */
const CORNERS: readonly SurfaceCorner[] = ["tl", "tr", "br", "bl"];

const RIM: readonly SurfaceRegion[] = EDGES.map((edge, i) =>
  Object.freeze({ kind: "peripheral" as const, index: i + 1, edge }),
);
const FIVE_SCHEME: readonly SurfaceRegion[] = [
  ...RIM,
  Object.freeze({ kind: "centre" as const, index: 5 }),
];
const EIGHT_SCHEME: readonly SurfaceRegion[] = [
  ...RIM,
  ...CORNERS.map((corner, i) => Object.freeze({ kind: "centre-quadrant" as const, index: i + 5, corner })),
];

/**
 * True when this tooth carries the 8-scheme.
 *
 * PERMANENT MOLARS ONLY: FDI position 6, 7 or 8 in quadrants 1-4. Deciduous
 * teeth use the 5-scheme even though a deciduous molar has four cusps —
 * CHARTING.md §3.4 records that as a deliberate Dentally simplification, and
 * §2.6 measured it across 500 live rows: only position 6 ever reached index 8
 * and every deciduous row capped at 5. Charting a deciduous molar with eight
 * regions would offer four positions Dentally cannot hold, so half of them could
 * never be reconciled against the record this screen mirrors.
 *
 * The `isDeciduous` guard is belt-and-braces rather than load-bearing: deciduous
 * FDI positions only run 1-5, so the position test alone already excludes them.
 * It is written out because the RULE is "permanent molars", and a reader should
 * not have to re-derive that from the numbering.
 */
export function isMolarScheme(fdi: number): boolean {
  return isTooth(fdi) && !isDeciduous(fdi) && displayNumber(fdi) >= 6;
}

/**
 * Every region this tooth draws, in index order: five, or eight on a permanent
 * molar. A value that is not a tooth draws NOTHING, rather than defaulting to a
 * scheme and inviting a fill onto a tooth that does not exist.
 */
export function surfaceRegions(toothFdi: number): SurfaceRegion[] {
  if (!isTooth(toothFdi)) return [];
  return [...(isMolarScheme(toothFdi) ? EIGHT_SCHEME : FIVE_SCHEME)];
}

/**
 * One Dentally surface index, resolved on THIS tooth. `null` when the index has
 * no region here — 7 on an incisor, anything outside 1-8, a fraction, a tooth we
 * do not draw.
 *
 * NULL IS THE POINT. The caller must keep an unresolvable index visible
 * (`unrecognised`) rather than clamping it onto the nearest region: a fill in
 * the wrong place is indistinguishable on screen from a real reading, whereas an
 * index printed verbatim beside the tooth tells a clinician to open Dentally.
 */
export function regionForIndex(toothFdi: number, index: number): SurfaceRegion | null {
  if (!Number.isInteger(index)) return null;
  if (!isTooth(toothFdi)) return null;
  const scheme = isMolarScheme(toothFdi) ? EIGHT_SCHEME : FIVE_SCHEME;
  return scheme.find((r) => r.index === index) ?? null;
}

/**
 * Which of these indices the item's TEETH can actually carry.
 *
 * `placeable` if ANY named tooth resolves it. One treatment_plan_item can name
 * several teeth — a bridge spans them — and discarding a molar's index 7 because
 * the premolar beside it has no seventh region would delete a real charted
 * surface from the molar.
 *
 * An item that names NO tooth keeps everything: it draws nowhere regardless, and
 * counting its surfaces as unreadable would print a figure that describes our
 * parser rather than the patient.
 */
export function splitIndicesByScheme(
  teeth: readonly number[],
  indices: readonly number[],
): { placeable: number[]; outOfScheme: number[] } {
  if (teeth.length === 0) return { placeable: [...indices], outOfScheme: [] };
  const placeable: number[] = [];
  const outOfScheme: number[] = [];
  for (const index of indices) {
    if (teeth.some((t) => regionForIndex(t, index) !== null)) placeable.push(index);
    else outOfScheme.push(index);
  }
  return { placeable, outOfScheme };
}

/**
 * The regions a NAMED surface covers on this tooth.
 *
 * The one crossing point between the letter vocabulary (the mock, and our own
 * draft table) and the diagram, and it goes name -> position only. A named
 * occlusal on a molar covers the WHOLE centre table, so it returns all four
 * quadrants: drawing it as one would show a quarter of a filling the practice
 * recorded across the lot.
 */
export function regionsForBoxSide(toothFdi: number, side: BoxSide): SurfaceRegion[] {
  return surfaceRegions(toothFdi).filter((r) =>
    side === "centre"
      ? r.kind === "centre" || r.kind === "centre-quadrant"
      : r.kind === "peripheral" && r.edge === side,
  );
}

/**
 * The integer surface indices carried on a chart row.
 *
 * `surfaceIndices` is now a REQUIRED field on ChartItem itself (types.ts), so this
 * is a convenience reader rather than a shim. It is kept because it is the one
 * name every consumer already calls, and because it tolerates the looser shapes
 * that reach the renderer from a draft or a fixture without each of them needing a
 * guard.
 */
export interface ChartItemSurfaceIndices {
  /** Dentally's own surface numbers for this row, sorted and de-duplicated, each
   *  one placeable on at least one of the row's teeth. */
  surfaceIndices: number[];
}

export function surfaceIndicesOf(item: Partial<ChartItemSurfaceIndices>): number[] {
  return item.surfaceIndices ?? [];
}
