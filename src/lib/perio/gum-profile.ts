// ===========================================================================
// THE GUM LINE — the geometry, and only the geometry.
//
// A periodontal chart is a PICTURE, not a spreadsheet. Dentally's own words for
// why: it "gives you a good visualization of the patient's mouth allowing you to
// see at a glance how oral health has improved or changed over treatment time."
// A full-mouth six-point chart is 192 numbers; nobody reads 192 numbers between
// patients. They read two lines and the shape of the gap between them.
//
// Against a tooth column this module places, per site:
//
//   the GINGIVAL MARGIN   — where the gum sits, from RECESSION
//   the POCKET BASE       — where the probe stopped, from RECESSION + DEPTH (CAL)
//   the band between them — that band IS the pocket
//
// so attachment loss reads across the arch at a glance.
//
// ---------------------------------------------------------------------------
// THE FIVE RULES THIS FILE EXISTS TO OBEY. They outrank the visuals, and every
// one of them is tested in gum-profile.test.ts.
//
// 1. THE DRAWING IS DERIVED, NEVER AN INPUT. Everything here is a pure function
//    of a ChartedTooth[]. There is no setter, no hit-test, no inverse mapping
//    from screen units back to millimetres — deliberately, because the moment
//    one exists someone wires a drag handle to it and a clinician "adjusts" a
//    recorded finding by eye. The numbers are the record; this is a reading of
//    them.
//
// 2. A SITE WITH NO READING BREAKS THE LINE. It is never interpolated across.
//    A smooth curve drawn through a site nobody measured is an INVENTED CLINICAL
//    FINDING, and it is the single worst thing this component could do — worse
//    than drawing nothing, because it is indistinguishable from a real reading.
//    So the break is modelled explicitly (`GumBreak`), carries its own reason,
//    and the segments either side are separate polylines that share no vertex.
//
// 3. NO PRECISION THE NUMBERS LACK. Probing depths are whole millimetres read
//    off a banded probe by eye. The vertices join with STRAIGHT segments. There
//    is no spline, no bezier, no smoothing and no sub-millimetre tick, because a
//    curve through whole-millimetre points draws values nobody measured and
//    implies a probe nobody owns.
//
// 4. THE SCALE IS FIXED AND STATED. `DEFAULT_GUM_SCALE` is the same for every
//    patient, every visit and every arch. There is deliberately NO autoscale: a
//    per-patient fit makes a healthy mouth and a diseased one draw identically,
//    which is exactly the reassuring lie this chart exists to prevent. A reading
//    that runs off the box is marked `clipped` and keeps its true millimetres —
//    it is never quietly squeezed back inside.
//
// 5. BUCCAL AND LINGUAL ARE SEPARATE PROFILES. They are never averaged into one
//    line. Buccal recession is usually a toothbrush; interproximal and palatal
//    attachment loss is usually disease. A mean of the two is a number about
//    neither.
//
// ---------------------------------------------------------------------------
// CAL IS CONSUMED, NEVER RECOMPUTED. `ChartedSite.cal` is produced in exactly
// one place — buildSite() in pocket-chart.ts — and this file reads it. A second
// implementation of "depth + recession" is a second answer, and the one on
// screen is the one a clinician acts on.
//
// NO CLOCK, NO I/O, NO REACT. Pure arithmetic over plain data, because vitest
// collects only src/**/*.test.ts and the millimetre-to-screen mapping is exactly
// the part that has to be tested.
// ===========================================================================

import { PERMANENT_LOWER, PERMANENT_UPPER, sideOf } from "@/lib/charting/fdi";
import type { ChartedSite, ChartedTooth } from "./pocket-chart";
import type { PerioSiteId } from "./types";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type GumArch = "upper" | "lower";

/** The two surfaces, charted and drawn separately (rule 5). "lingual" covers the
 *  palatal row of the upper arch; Dentally calls that row "Upper Palatal" and
 *  charts it as its own pass, which is the same separation. */
export type GumAspect = "buccal" | "lingual";

/** Which sites belong to which surface. mb·b·db face the cheek; ml·l·dl face the
 *  tongue or palate. */
export const ASPECT_SITES: Record<GumAspect, readonly PerioSiteId[]> = {
  buccal: ["mb", "b", "db"],
  lingual: ["ml", "l", "dl"],
};

export const ASPECT_LABEL: Record<GumAspect, string> = {
  buccal: "buccal",
  lingual: "lingual / palatal",
};

export const ARCH_LABEL: Record<GumArch, string> = {
  upper: "upper",
  lower: "lower",
};

/**
 * The teeth of each arch in DRAW ORDER, left to right as the viewer sees them.
 *
 * These are fdi.ts's own arrays, imported rather than restated: the FDI chart
 * already draws 18→11, 21→28 across the page, and a perio chart that laid its
 * teeth out in a different order would be read against the wrong tooth by anyone
 * who had just been looking at the other tab.
 *
 * EVERY POSITION GETS A COLUMN WHETHER OR NOT THE TOOTH IS THERE. Tooth 16 sits
 * at the same x in every exam, so two visits overlay honestly and a missing tooth
 * leaves a visible hole instead of closing the arch up.
 */
export const ARCH_ORDER: Record<GumArch, readonly number[]> = {
  upper: PERMANENT_UPPER,
  lower: PERMANENT_LOWER,
};

// ---------------------------------------------------------------------------
// The scale. Fixed, stated, and the same for everybody.
// ---------------------------------------------------------------------------

export interface GumScale {
  /** Screen units per millimetre. THE WHOLE POINT: a constant. */
  unitsPerMm: number;
  /** How far CORONAL to the CEJ the box reaches, in mm. Recession is negative
   *  when the margin sits coronal to the CEJ (swelling, overgrowth), so the box
   *  has to have room on that side or a real reading has nowhere to go. */
  coronalMm: number;
  /** How far APICAL to the CEJ the box reaches, in mm. pocket-chart.ts validates
   *  depth to 15mm and recession to 15mm, so a CAL can in principle reach 30mm;
   *  anything past this extent is drawn at the edge and flagged `clipped`, never
   *  silently rescaled. */
  apicalMm: number;
  /** Horizontal units per tooth position. The three site columns share it. */
  toothWidth: number;
}

/**
 * ONE SCALE, FOR EVERY PATIENT AND EVERY VISIT.
 *
 * 6 units per millimetre against a 27-unit tooth means a 27-unit-wide tooth is
 * 4.5mm tall per millimetre band — deep enough that a 3mm pocket and a 6mm pocket
 * are unmistakably different heights, shallow enough that a whole 16-tooth arch
 * fits a screen without a scrollbar.
 */
export const DEFAULT_GUM_SCALE: GumScale = {
  unitsPerMm: 6,
  coronalMm: 4,
  apicalMm: 16,
  toothWidth: 27,
};

/**
 * Dentally underlines a pocket depth in red at 4mm or greater. Same number here,
 * and it is the same number for a reason: a hygienist moving between the two
 * screens must not have to learn a second threshold for "deep".
 *
 * It marks a SITE, never a diagnosis. Staging is diagnosis.ts's job and it is
 * defined on interdental attachment loss, not on a depth.
 */
export const DEEP_POCKET_MM = 4;

/** How far apical the schematic root is drawn. A DRAWING CONVENTION, not a
 *  measurement: nothing here knows the real root length, and the outline exists
 *  only to give the two lines something to be read against. */
const ROOT_DRAW_MM = 12;

/** The sentence that puts the scale ON the chart. A scale a reader has to infer
 *  is a scale a reader gets wrong. */
export function describeGumScale(scale: GumScale = DEFAULT_GUM_SCALE): string {
  return (
    `Drawn to a fixed scale of ${scale.unitsPerMm} units per millimetre, from ` +
    `${scale.coronalMm}mm coronal to ${scale.apicalMm}mm apical of the cemento-enamel ` +
    `junction. The scale is the same for every patient and every visit, so a healthy ` +
    `mouth and a diseased one do not draw alike.`
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * Where a tooth's three site columns sit, and whether the tooth is there at all.
 *
 * "not-charted" and "absent" are DIFFERENT and are never collapsed. A tooth that
 * was extracted has no periodontium to measure; a tooth that was simply not
 * probed has one and nobody looked. The line breaks at both — the label does not.
 */
export type ToothPresence = "charted" | "not-charted" | "absent";

/** A schematic crown and root for the tooth to be read against. PURELY a
 *  backdrop — no measurement is taken from it and none is implied by it. */
export interface ToothOutline {
  crown: { x: number; y: number; width: number; height: number };
  /** A trapezoid narrowing apically, as a closed point list. */
  root: { x: number; y: number }[];
}

export interface GumToothColumn {
  tooth: number;
  presence: ToothPresence;
  /** Left edge. */
  x: number;
  width: number;
  /** Centre, for a label. */
  centreX: number;
  /** Where the tooth number sits: the middle of the crown, which is the coronal
   *  end of the box and therefore the same edge on both arches. */
  labelY: number;
  outline: ToothOutline;
}

export interface GumColumn {
  index: number;
  tooth: number;
  site: PerioSiteId;
  /** Centre x of this site's column. Every vertex sits here. */
  x: number;
  /** The strip this column owns, so a renderer marks a site without doing its
   *  own arithmetic. */
  left: number;
  width: number;
}

/**
 * The three sites of one surface, ordered LEFT TO RIGHT for this tooth.
 *
 * Mesial means "towards the midline". On the patient's right (quadrants 1 and 4,
 * drawn on the viewer's LEFT and running 8→1 towards the centre) the midline is
 * to the right, so the mesial site is the rightmost of the three. On the
 * patient's left it is the leftmost. Getting this backwards puts a kink in the
 * line at every tooth junction and a fake step at the midline — the drawing still
 * looks plausible, which is what makes it worth a test.
 */
export function siteOrderFor(tooth: number, aspect: GumAspect): readonly PerioSiteId[] {
  const [mesial, mid, distal] = ASPECT_SITES[aspect];
  return sideOf(tooth) === "right" ? [distal, mid, mesial] : [mesial, mid, distal];
}

// ---------------------------------------------------------------------------
// Vertices, segments, breaks
// ---------------------------------------------------------------------------

export type GumLineKind = "margin" | "base";

export interface GumVertex {
  /** Index into `GumProfile.columns`. Adjacency is defined on THIS, not on x. */
  column: number;
  tooth: number;
  site: PerioSiteId;
  x: number;
  /**
   * Millimetres from the cemento-enamel junction, apical positive. This is the
   * measurement; `y` is only where it landed on a screen.
   */
  mm: number;
  y: number;
  /** `mm` fell outside the drawing box. `y` is the box edge, `mm` is still true.
   *  A renderer must mark these — a clamped point that looks like a measured one
   *  is a reading understated by however far it ran off. */
  clipped: boolean;
  bleeding: boolean;
  suppuration: boolean;
}

/**
 * A run of ADJACENT measured columns.
 *
 * A run of one point is legal and common — a single probed site between two
 * unprobed ones. It is a dot, not a line, and `points.length === 1` is how a
 * renderer knows. Nothing in this module ever joins two segments.
 */
export interface GumSegment {
  kind: GumLineKind;
  points: GumVertex[];
}

/** Why nothing is drawn across this gap. */
export type GumBreakReason =
  /** The tooth is not in the mouth. */
  | "absent-tooth"
  /** The tooth is in the mouth and holds no reading at all. */
  | "tooth-not-charted"
  /** The tooth was charted; this site was not, or carries no recession. */
  | "site-not-recorded";

/**
 * A modelled gap. Rule 2 made explicit rather than implied by two segments
 * happening not to touch: a break is a thing the chart states, with a reason,
 * because "we did not look here" is clinical information.
 */
export interface GumBreak {
  /** Inclusive column range with no reading. */
  fromColumn: number;
  toColumn: number;
  columns: number[];
  teeth: number[];
  /** The strip of the drawing this gap occupies, so a renderer can mark it
   *  rather than leave a suggestive blank. */
  x: number;
  width: number;
  reasons: GumBreakReason[];
  /** A measured column exists on BOTH sides. These are the gaps a smoothed curve
   *  would have bridged, and the ones a reader is most likely to read across. */
  interior: boolean;
  /** A whole sentence for a tooltip or a caption. Never a fragment. */
  note: string;
}

/**
 * The pocket, as a closed polygon: the margin left to right, then the base right
 * to left. Its AREA is the attachment lost between those columns, which is what
 * makes the picture readable at arm's length.
 *
 * A zero-height band is a real answer, not a bug — 3mm of recession with a 0mm
 * pocket has no pocket to shade. See the disease-shape test.
 */
export interface PocketBand {
  points: { x: number; y: number }[];
  columns: number[];
  /** The greatest pocket depth in mm anywhere in this band, for a title. */
  deepestMm: number;
}

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

export interface GumProfile {
  arch: GumArch;
  aspect: GumAspect;
  scale: GumScale;
  width: number;
  height: number;
  /** Horizontal units per site column. Three to a tooth. */
  siteWidth: number;
  /** The cemento-enamel junction baseline: y for 0mm. */
  cejY: number;
  /** Screen direction of APICAL. The upper arch is drawn crowns-down, so apical
   *  is up the screen (-1); the lower arch crowns-up, so apical is down (+1).
   *  Both rows of one arch use the SAME sign — mirroring the palatal row would
   *  make the two halves of one chart read in opposite directions. */
  apicalSign: 1 | -1;
  teeth: GumToothColumn[];
  columns: GumColumn[];
  margin: GumSegment[];
  base: GumSegment[];
  bands: PocketBand[];
  breaks: GumBreak[];
  /** Every measured margin vertex, in column order. Dots go here, so an isolated
   *  reading is still visible. */
  marginVertices: GumVertex[];
  baseVertices: GumVertex[];
  /** Columns carrying a probing depth but NO recession: the pocket is known and
   *  its position is not, so neither line can be placed. Counted and stated
   *  rather than drawn at a guessed zero. */
  depthWithoutRecession: number[];
  /** Columns whose PROBING DEPTH is DEEP_POCKET_MM or more — Dentally's own 4mm
   *  red-underline threshold, kept identical so nobody has to learn a second one. */
  deepColumns: number[];
  measuredColumns: number;
  totalColumns: number;
  /** Charted teeth that are in no permanent arch — the deciduous dentition. They
   *  have no column here and are named rather than dropped. */
  unplacedTeeth: number[];
}

export interface GumProfileInput {
  teeth: readonly ChartedTooth[];
  arch: GumArch;
  aspect: GumAspect;
  /** FDI numbers of teeth in the mouth. Supplying it is what lets an extracted
   *  tooth read as extracted instead of as unexamined. Omitted, no tooth is
   *  called absent — the safer of the two errors, since "not charted" understates
   *  nothing. */
  presentTeeth?: readonly number[] | null;
  scale?: GumScale;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function siteMap(tooth: ChartedTooth): Map<PerioSiteId, ChartedSite> {
  const map = new Map<PerioSiteId, ChartedSite>();
  for (const site of tooth.sites) map.set(site.site, site);
  return map;
}

/** mm → y. The whole mapping, in one place, so one test pins it. */
export function yForMm(mm: number, profile: Pick<GumProfile, "cejY" | "apicalSign" | "scale">): number {
  return profile.cejY + profile.apicalSign * mm * profile.scale.unitsPerMm;
}

function clampY(raw: number, height: number): { y: number; clipped: boolean } {
  if (raw < 0) return { y: 0, clipped: true };
  if (raw > height) return { y: height, clipped: true };
  return { y: raw, clipped: false };
}

function runsOf(defined: boolean[]): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let start: number | null = null;
  for (let i = 0; i < defined.length; i += 1) {
    if (defined[i]) {
      if (start === null) start = i;
    } else if (start !== null) {
      runs.push({ from: start, to: i - 1 });
      start = null;
    }
  }
  if (start !== null) runs.push({ from: start, to: defined.length - 1 });
  return runs;
}

function breakNote(reasons: GumBreakReason[], teeth: number[], columnCount: number): string {
  const sites = columnCount === 1 ? "1 site" : `${columnCount} sites`;
  const one = teeth.length === 1;
  const subject = one ? `tooth ${teeth[0]}` : `teeth ${teeth.join(", ")}`;
  if (reasons.length === 1 && reasons[0] === "absent-tooth") {
    return `${sites} not drawn: ${subject} ${one ? "is" : "are"} not in the mouth.`;
  }
  if (reasons.length === 1 && reasons[0] === "tooth-not-charted") {
    return `${sites} not drawn: ${subject} ${one ? "was" : "were"} not charted. This is not a finding of health.`;
  }
  if (reasons.length === 1 && reasons[0] === "site-not-recorded") {
    return `${sites} not drawn: no recession was recorded at ${subject}. This is not a finding of health.`;
  }
  return `${sites} not drawn across ${subject}; the line is broken rather than joined across readings that were never taken.`;
}

/**
 * The gum line for ONE arch and ONE surface.
 *
 * Pure. Same input, same output, no clock, no randomness — a chart that redrew
 * differently on a refresh would be a chart nobody could compare against last
 * visit's screenshot.
 */
export function buildGumProfile(input: GumProfileInput): GumProfile {
  const scale = input.scale ?? DEFAULT_GUM_SCALE;
  const order = ARCH_ORDER[input.arch];
  const siteWidth = scale.toothWidth / 3;
  const width = order.length * scale.toothWidth;
  const height = (scale.coronalMm + scale.apicalMm) * scale.unitsPerMm;
  const apicalSign: 1 | -1 = input.arch === "upper" ? -1 : 1;
  const cejY = (apicalSign === -1 ? scale.apicalMm : scale.coronalMm) * scale.unitsPerMm;
  const frame = { cejY, apicalSign, scale };

  const charted = new Map<number, ChartedTooth>();
  for (const tooth of input.teeth) charted.set(tooth.tooth, tooth);
  const present = input.presentTeeth ? new Set(input.presentTeeth) : null;

  const placeable = new Set<number>([...ARCH_ORDER.upper, ...ARCH_ORDER.lower]);
  const unplacedTeeth = input.teeth
    .map((t) => t.tooth)
    .filter((t) => !placeable.has(t))
    .sort((a, b) => a - b);

  // -- columns -------------------------------------------------------------
  const teethColumns: GumToothColumn[] = [];
  const columns: GumColumn[] = [];
  const crownY = apicalSign === -1 ? cejY : 0;
  const crownHeight = scale.coronalMm * scale.unitsPerMm;
  const rootApexY = yForMm(ROOT_DRAW_MM, frame);
  const inset = scale.toothWidth * 0.08;
  const taper = scale.toothWidth * 0.26;

  order.forEach((tooth, toothIndex) => {
    const x = toothIndex * scale.toothWidth;
    const presence: ToothPresence = charted.has(tooth)
      ? "charted"
      : present && !present.has(tooth)
        ? "absent"
        : "not-charted";
    teethColumns.push({
      tooth,
      presence,
      x,
      width: scale.toothWidth,
      centreX: x + scale.toothWidth / 2,
      labelY: crownY + crownHeight / 2,
      outline: {
        crown: { x: x + inset, y: crownY, width: scale.toothWidth - inset * 2, height: crownHeight },
        root: [
          { x: x + inset, y: cejY },
          { x: x + scale.toothWidth - inset, y: cejY },
          { x: x + scale.toothWidth - taper, y: rootApexY },
          { x: x + taper, y: rootApexY },
        ],
      },
    });
    siteOrderFor(tooth, input.aspect).forEach((site, k) => {
      columns.push({
        index: columns.length,
        tooth,
        site,
        x: x + (k + 0.5) * siteWidth,
        left: x + k * siteWidth,
        width: siteWidth,
      });
    });
  });

  // -- vertices ------------------------------------------------------------
  const marginAt: (GumVertex | null)[] = [];
  const baseAt: (GumVertex | null)[] = [];
  const depthWithoutRecession: number[] = [];
  const deepColumns: number[] = [];
  const siteCache = new Map<number, Map<PerioSiteId, ChartedSite>>();

  for (const column of columns) {
    const tooth = charted.get(column.tooth);
    if (tooth && !siteCache.has(tooth.tooth)) siteCache.set(tooth.tooth, siteMap(tooth));
    const site = tooth ? siteCache.get(tooth.tooth)!.get(column.site) : undefined;
    const recession = site?.recession ?? null;
    const cal = site?.cal ?? null;

    if (site && site.probingDepth !== null && site.probingDepth >= DEEP_POCKET_MM) {
      deepColumns.push(column.index);
    }
    if (site && recession === null && site.probingDepth !== null) {
      depthWithoutRecession.push(column.index);
    }

    if (recession === null) {
      marginAt.push(null);
      baseAt.push(null);
      continue;
    }
    const bleeding = Boolean(site?.bleeding);
    const suppuration = Boolean(site?.suppuration);
    const marginRaw = yForMm(recession, frame);
    const marginClamped = clampY(marginRaw, height);
    marginAt.push({
      column: column.index,
      tooth: column.tooth,
      site: column.site,
      x: column.x,
      mm: recession,
      y: marginClamped.y,
      clipped: marginClamped.clipped,
      bleeding,
      suppuration,
    });

    if (cal === null) {
      baseAt.push(null);
      continue;
    }
    const baseRaw = yForMm(cal, frame);
    const baseClamped = clampY(baseRaw, height);
    baseAt.push({
      column: column.index,
      tooth: column.tooth,
      site: column.site,
      x: column.x,
      mm: cal,
      y: baseClamped.y,
      clipped: baseClamped.clipped,
      bleeding,
      suppuration,
    });
  }

  // -- segments ------------------------------------------------------------
  const marginRuns = runsOf(marginAt.map((v) => v !== null));
  const baseRuns = runsOf(baseAt.map((v) => v !== null));

  const margin: GumSegment[] = marginRuns.map((run) => ({
    kind: "margin" as const,
    points: marginAt.slice(run.from, run.to + 1).filter((v): v is GumVertex => v !== null),
  }));
  const base: GumSegment[] = baseRuns.map((run) => ({
    kind: "base" as const,
    points: baseAt.slice(run.from, run.to + 1).filter((v): v is GumVertex => v !== null),
  }));

  // -- bands ---------------------------------------------------------------
  // A base vertex requires a recession, so every base run is also a margin run:
  // the band is bounded above and below by real readings at every column.
  const bands: PocketBand[] = baseRuns.map((run) => {
    const top: { x: number; y: number }[] = [];
    const bottom: { x: number; y: number }[] = [];
    const cols: number[] = [];
    let deepestMm = 0;
    for (let i = run.from; i <= run.to; i += 1) {
      const m = marginAt[i];
      const b = baseAt[i];
      if (!m || !b) continue;
      top.push({ x: m.x, y: m.y });
      bottom.push({ x: b.x, y: b.y });
      cols.push(i);
      deepestMm = Math.max(deepestMm, b.mm - m.mm);
    }
    return { points: [...top, ...bottom.reverse()], columns: cols, deepestMm };
  });

  // -- breaks --------------------------------------------------------------
  const gaps = runsOf(marginAt.map((v) => v === null));
  const breaks: GumBreak[] = gaps.map((gap) => {
    const cols: number[] = [];
    const teeth: number[] = [];
    const reasons = new Set<GumBreakReason>();
    for (let i = gap.from; i <= gap.to; i += 1) {
      cols.push(i);
      const column = columns[i];
      if (!teeth.includes(column.tooth)) teeth.push(column.tooth);
      const toothRecord = charted.get(column.tooth);
      if (toothRecord) reasons.add("site-not-recorded");
      else if (present && !present.has(column.tooth)) reasons.add("absent-tooth");
      else reasons.add("tooth-not-charted");
    }
    const reasonList = [...reasons];
    const left = columns[gap.from].left;
    return {
      fromColumn: gap.from,
      toColumn: gap.to,
      columns: cols,
      teeth,
      x: left,
      width: columns[gap.to].left + columns[gap.to].width - left,
      reasons: reasonList,
      interior: gap.from > 0 && gap.to < columns.length - 1,
      note: breakNote(reasonList, teeth, cols.length),
    };
  });

  return {
    arch: input.arch,
    aspect: input.aspect,
    scale,
    width,
    height,
    siteWidth,
    cejY,
    apicalSign,
    teeth: teethColumns,
    columns,
    margin,
    base,
    bands,
    breaks,
    marginVertices: marginAt.filter((v): v is GumVertex => v !== null),
    baseVertices: baseAt.filter((v): v is GumVertex => v !== null),
    depthWithoutRecession,
    deepColumns,
    measuredColumns: marginAt.filter((v) => v !== null).length,
    totalColumns: columns.length,
    unplacedTeeth,
  };
}

/**
 * All four rows of a chart: upper buccal, upper lingual, lower buccal, lower
 * lingual. Rows with nothing measured are STILL RETURNED — an empty row that a
 * clinician can see is empty is the whole difference between "not examined" and
 * "examined and clean" (CHARTING.md §6.3).
 */
export function buildGumProfiles(
  teeth: readonly ChartedTooth[],
  options: { presentTeeth?: readonly number[] | null; scale?: GumScale } = {},
): GumProfile[] {
  const rows: { arch: GumArch; aspect: GumAspect }[] = [
    { arch: "upper", aspect: "buccal" },
    { arch: "upper", aspect: "lingual" },
    { arch: "lower", aspect: "buccal" },
    { arch: "lower", aspect: "lingual" },
  ];
  return rows.map((row) =>
    buildGumProfile({
      teeth,
      arch: row.arch,
      aspect: row.aspect,
      presentTeeth: options.presentTeeth ?? null,
      scale: options.scale,
    }),
  );
}

// ---------------------------------------------------------------------------
// The ruler. A scale nobody can read is not a stated scale.
// ---------------------------------------------------------------------------

export interface GumRulerLine {
  mm: number;
  y: number;
  /** Every 5mm, and the CEJ itself. Labelled; the rest are hairlines. */
  major: boolean;
  label: string | null;
}

/**
 * One line per whole millimetre across the box, apical positive.
 *
 * WHOLE MILLIMETRES ONLY, and there is no half-millimetre tick anywhere in this
 * module (rule 3). The probe is banded in millimetres and read by eye; a chart
 * offering a 0.5mm gridline invites a reader to see a precision the reading does
 * not have.
 */
export function rulerLines(profile: GumProfile): GumRulerLine[] {
  const lines: GumRulerLine[] = [];
  for (let mm = -profile.scale.coronalMm; mm <= profile.scale.apicalMm; mm += 1) {
    const major = mm === 0 || mm % 5 === 0;
    lines.push({
      mm,
      y: yForMm(mm, profile),
      major,
      label: mm === 0 ? "CEJ" : major ? `${mm}mm` : null,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Rendering helpers. Pure string building, kept here so gum-line.tsx stays a
// thin renderer and every coordinate that reaches the screen is testable.
// ---------------------------------------------------------------------------

/** "x,y x,y x,y" — the `points` attribute of a <polyline> or <polygon>.
 *  STRAIGHT SEGMENTS ONLY: there is no path-building function in this file and
 *  no bezier control point anywhere in it (rule 3). */
export function toPointsAttribute(points: readonly { x: number; y: number }[]): string {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A whole sentence describing what this row draws and what it does not. */
export function describeGumProfile(profile: GumProfile): string {
  const where = `${ARCH_LABEL[profile.arch]} arch, ${ASPECT_LABEL[profile.aspect]} surface`;
  if (profile.measuredColumns === 0) {
    return `No recession was recorded on the ${where}, so no gum line is drawn. Nothing here is a finding of health.`;
  }
  const missing = profile.totalColumns - profile.measuredColumns;
  const head =
    `${where}: gum line drawn from ${profile.measuredColumns} of ${profile.totalColumns} sites, ` +
    `shaded between the gingival margin and the base of the pocket.`;
  if (missing === 0) return head;
  return (
    `${head} ${missing} ${missing === 1 ? "site was" : "sites were"} not recorded and the line is ` +
    `broken across ${missing === 1 ? "it" : "them"} rather than joined.`
  );
}

/** Sites drawn at the edge of the box because the reading ran past it. Named so
 *  a renderer can mark them; a clamped point that reads as measured understates
 *  the finding. */
export function clippedVertices(profile: GumProfile): GumVertex[] {
  return [...profile.marginVertices, ...profile.baseVertices].filter((v) => v.clipped);
}
