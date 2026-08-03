// ===========================================================================
// TOOTH SHAPE: real dental anatomy, as SVG path data, one tooth at a time.
//
// WHY THIS FILE EXISTS AT ALL. Our first chart drew every tooth as the same
// rounded dome — a lozenge with a hint of a cusp — and the owner's verdict, made
// side by side against the real Dentally screen, was that theirs draws teeth and
// ours draws blobs. He is right, and it is not only taste. A clinician scanning
// this chart from a metre away identifies a tooth by its SILHOUETTE before ever
// reading the number strip: a molar is a broad crown on a splayed tripod, an
// incisor is a chisel on a single spike. Thirty-two identical domes remove that
// channel entirely and leave the two-digit number as the only way to tell an
// upper 6 from an upper 1 — on the one screen in this platform where naming the
// wrong tooth is the named hazard (CHARTING.md §8.3).
//
// A DIAGRAM, NOT AN ILLUSTRATION. The pass that fixed the blobs overshot into
// the other ditch, and the same side-by-side found it: against Dentally's own
// screen ours read as thorns. Three specific things did that, and all three are
// undone below.
//   - The apices came to a POINT. Two curves met at the tip at an angle, so
//     however gently the flanks tapered the last pixel was a corner. Dentally's
//     root ends are soft almond domes, so the tip now carries a genuine radius:
//     the two flank curves meet with HORIZONTAL tangents, which is a rounded end
//     by construction rather than a taper that hopes to read as one.
//   - The roots forked AT the cervix. Nothing held them together above the neck,
//     so a V of white opened from the very first unit of root and a molar drew as
//     three separate spikes with air between them. They now share a straight-
//     sided TRUNK for the first stretch of their run — adjacent flanks coincident,
//     no gap at all — and only then draw in. The divisions read as grooves cut
//     into one form, which is what they are in the mouth and what Dentally draws.
//     The tips also splay less far, so the form stays a form.
//   - The biting edge was SCALLOPED, a peak per cusp with a valley between. At
//     chart scale that wave is noise: it costs a clinician a beat per tooth on the
//     one read that has to be instant, and Dentally has no scallop anywhere. The
//     edge is now flat with softly rounded corners. cuspCount() stays — the fifth
//     cusp of a lower 6 is still a clinical fact and still reported — it is simply
//     no longer DRAWN. Anatomy we hold as data, not as ornament.
//
// AND THEN THE PROPORTION WAS WRONG, which is what the pass after that found and
// what the two constants blocks below now carry. Softening the spikes into lobes
// was right and it moved the problem rather than finishing it: the roots still
// took ~60% of the glyph's height, so the crown was a squat block with three
// chunky fingers standing on it, and the fingers ran PARALLEL and stopped at a
// dome, like mittens. Dentally's reads the other way round — more crown, shorter
// roots — and its roots TAPER along their length. Two edits, and only two:
//   - THE CROWN FRACTIONS were rebalanced to parity or better, per family, and
//     the reasoning is written out over PERMANENT_METRICS. They had never been
//     revisited since the day the roots were spikes.
//   - THE FLANK CONTROL was pulled inboard of the lobe's base width (LOBE_TAPER),
//     and the apex domes narrowed to match, so a lobe narrows continuously from
//     base to tip instead of running straight and turning over at the end.
// Neither touches what a root IS: rootCount() is untouched, and the taper is
// applied strictly above the trunk so the bases still partition the cervix exactly.
//
// WHY IT IS A .ts AND NOT MATHS INSIDE tooth.tsx. vitest collects only
// src/**\/*.test.ts in a node environment, so nothing written inside a .tsx is
// ever asserted. Root COUNT is a clinical fact — an upper 6 has three roots, its
// lower counterpart two — and a fact that no test can reach drifts. Worse, the
// UPPER/LOWER MIRROR is invisible in review: a sign flipped here draws the lower
// arch's roots growing into the occlusal plane, and the build stays green. So
// the geometry is pure, exported, and tested against a literal anatomy table
// that was written out by hand rather than derived from this file.
//
// WHAT IT DOES NOT DO. It never names a surface, never mirrors by SIDE, and
// never encodes mesial or distal. surfaces.ts owns the surface layout and
// arch-metrics.ts owns how big a tooth is; both are settled and tested, and
// nothing here touches either. Every shape below is SYMMETRIC about the column's
// vertical centre line precisely so that it makes no left/right claim: we know
// an upper molar has two buccal roots and one palatal, and we do NOT know which
// way round Dentally orients each quadrant's diagram (CHARTING.md §3.4 calls
// that an open fork). Drawing three symmetric roots is true in every
// orientation. Drawing them asymmetrically would be a guess with a patient's
// name on it.
//
// ORIENTATION IS ESTABLISHED, NOT RE-DERIVED. archOf() from fdi.ts is the single
// source of which arch a tooth is in, and the layout it feeds is the reference's
// own: on the UPPER arch the crown sits at the BOTTOM of the cell with the roots
// pointing UP and away from the occlusal plane, and on the LOWER arch the whole
// thing is mirrored. So the shape is built ONCE in a canonical root-up space and
// every y is put through one mirror function on the way out. One mirror, in one
// place, with a test that fails if it is removed.
//
// PURE, unit-free and deterministic. No DOM, no React, no clock — the box is a
// viewBox and the renderer scales it, which is what lets one chart fill both a
// laptop and a 1920 reception monitor.
// ===========================================================================

import { archOf, displayNumber, isDeciduous } from "./fdi";

/**
 * The shape's own viewBox, in DENTALLY.md's MEASURED crown proportion of
 * 75 wide x 85 tall. The numbers ARE the measurement rather than a normalised
 * 0-100 box, so a reader comparing this file against the reference is comparing
 * like with like, and so the aspect of the box and the aspect of the rendered
 * slot cannot drift apart.
 */
export const SHAPE_VIEW = { w: 75, h: 85 } as const;

/**
 * The four families of permanent dentition. NOT the surface scheme: a deciduous
 * molar is a molar here and a five-region tooth over in surfaces.ts, and that
 * difference is Dentally's own deliberate product choice (CHARTING.md §3.4), not
 * a disagreement to reconcile.
 */
export type ToothFamily = "incisor" | "canine" | "premolar" | "molar";

/**
 * The proportions of one family, all as fractions so the shape scales with the
 * cell and nothing here is a pixel.
 */
interface FamilyMetrics {
  /** Widest point of the crown (the height of contour), as a fraction of the box. */
  crownWidth: number;
  /** The cervix, as a fraction of crownWidth. The waist a tooth has at the gum. */
  neckWidth: number;
  /** The biting edge, as a fraction of crownWidth. */
  occlusalWidth: number;
  /** Crown length, as a fraction of the box height. The rest is root. */
  crownHeight: number;
  /** How far the root apices spread beyond their own bases. 1 = straight down. */
  splay: number;
  /** Where the apices reach, as a fraction of the box height from the root end.
   *  Smaller is a longer root. */
  apexTop: number;
}

/**
 * Permanent proportions, from standard tooth morphology rather than invention.
 *
 * The incisor is the only family WIDER THAN IT IS DEEP — that chisel is what makes
 * the six anteriors read as a block. The canine carries the LONGEST ROOT IN THE
 * MOUTH. The molar is the widest crown, because its identity comes from the root
 * tripod underneath and from sheer breadth, not from an occlusal table we no
 * longer draw.
 *
 * THE SPLAY NUMBERS CAME DOWN in the diagram pass — the premolar from 1.5 and the
 * molar from 1.35 — because splay is what pushes the tips apart, and tips far
 * apart are what made a molar read as separate prongs rather than as one form
 * with grooves in it. The ORDER is untouched and still says what it always said:
 * a molar flares, an incisor runs straight down, and a primary molar flares
 * widest of all to make room for the premolar developing between its roots.
 *
 * ---------------------------------------------------------------------------
 * THE CROWN FRACTIONS WERE REBALANCED, and they are the reason this comment is
 * long. They were 0.38–0.42 and had never been touched since the day they were
 * written, when the roots below them were sharp spikes: against a spike, a squat
 * crown still read as a tooth. Once the spikes were softened into lobes the same
 * numbers read as THREE FINGERS ON A BLOCK — roots took about 60% of the glyph
 * and the crown was the leftover. Dentally's is the other way round, and it is
 * not a stylistic preference: the crown is where every surface, every finding and
 * every click lives, and the root is a shape that says which tooth this is. The
 * chart should give the most room to the part that carries the information.
 *
 * The lever is subtle because crownHeight is a fraction of the WHOLE BOX, not of
 * the tooth: the glyph runs from the biting edge at 0.985 down to `apexTop`, so
 * the crown's share of what is actually drawn is
 *
 *     share = crownHeight / (0.985 - apexTop)
 *
 * and the root takes the rest. Setting every family to a flat 0.5 would NOT have
 * given parity — it would have given the canine (apexTop 0) a 50.8% crown and the
 * molar (apexTop 0.07) a 54.6% one, and it would have been an accident either
 * way. The numbers below were chosen as shares and converted back.
 *
 * WHY THE FAMILIES DIFFER, which they do by one step and only for a reason:
 *
 *   - MOLAR 0.48 (share 0.525) — the least crown of the four, because it is the
 *     only family whose identity lives in the root. Two or three lobes have to
 *     read as separate lobes ABOVE the shared trunk, and the trunk already eats
 *     54% of the run; shorten the root further and the grooves become nicks. The
 *     molar can afford the shortest crown because it has the widest one (0.98 of
 *     the box) and reads as a molar on breadth alone.
 *   - INCISOR and PREMOLAR 0.50 (share 0.529) — the most crown. A single conical
 *     root reads perfectly well short, so nothing is lost by spending the height
 *     on the crown, and the incisor's chisel is the whole of its identity.
 *   - CANINE 0.50 (share 0.508) — the same crown fraction as the incisor, and the
 *     smallest SHARE of the four, which is how it keeps the longest root in the
 *     mouth. That length now comes ENTIRELY from apexTop 0 — its apex reaching
 *     the very top of the box — and no longer from a stunted crown. The old
 *     arrangement bought the canine's length by making it the squattest tooth on
 *     the chart, which is a true fact expressed as a wrong drawing.
 *
 * Every family sits at or above parity in both dentitions, and the test beside
 * this file asserts that both ways: the crown is never less than the root, and
 * the root is never allowed to become a stub either.
 */
const PERMANENT_METRICS: Record<ToothFamily, FamilyMetrics> = {
  incisor: {
    crownWidth: 0.9,
    neckWidth: 0.62,
    occlusalWidth: 0.96,
    crownHeight: 0.5,
    splay: 1,
    apexTop: 0.04,
  },
  canine: {
    crownWidth: 0.78,
    neckWidth: 0.6,
    occlusalWidth: 0.82,
    crownHeight: 0.5,
    splay: 1,
    apexTop: 0,
  },
  premolar: {
    crownWidth: 0.74,
    neckWidth: 0.66,
    occlusalWidth: 0.82,
    crownHeight: 0.5,
    splay: 1.08,
    apexTop: 0.04,
  },
  molar: {
    crownWidth: 0.98,
    neckWidth: 0.84,
    occlusalWidth: 0.92,
    crownHeight: 0.48,
    splay: 1.12,
    apexTop: 0.07,
  },
};

/**
 * The deciduous adjustment: SMALLER AND MORE BULBOUS, with molar roots that
 * splay more widely. Every one of those is a real morphological difference and
 * not a scale factor for its own sake — a primary molar has a pronounced
 * cervical constriction (hence the neck taken in hardest, to 0.80 of its
 * permanent fraction) and its roots flare wide to make room for the permanent
 * premolar developing between them (hence the extra splay). The roots are also
 * markedly shorter, which is apexTop pushed down the box.
 *
 * A child's chart that drew adult teeth at adult proportions would be the same
 * failure as the domes, one dentition further along.
 */
const DECIDUOUS_CROWN_WIDTH = 0.88;
const DECIDUOUS_NECK_WIDTH = 0.8;
const DECIDUOUS_CROWN_HEIGHT = 0.95;
const DECIDUOUS_SPLAY = 1.2;
const DECIDUOUS_APEX_DROP = 0.13;

// ---------------------------------------------------------------------------
// THE DIAGRAM CONSTANTS. Shared by every family, because these four are about
// how a tooth is DRAWN rather than about what any one tooth is, and the moment
// they vary by family the arch stops looking like one drawing.
// ---------------------------------------------------------------------------

/** How much of the shortest root's run is straight-sided shared trunk, before
 *  the roots begin to draw apart. Higher merges the lobes lower; too high and a
 *  three-rooted molar stops reading as three-rooted, which is a clinical read and
 *  not a stylistic one. */
const TRUNK_RUN = 0.6;
/** Where up the run the flank's control point sits, as a fraction of the run
 *  measured DOWN from the tip. It is the HEIGHT at which the taper below is
 *  applied, and it sits between the trunk's top and the tip so the lobe narrows
 *  across the whole of its free run rather than only at the very end. */
const FLANK_HOLD = 0.24;
/**
 * THE TAPER. How much of its base half-width a lobe still carries at the flank
 * control point, partway up its free run.
 *
 * This is the constant that turns a MITTEN into a ROOT. Before it existed the
 * flank control sat at the lobe's FULL base width, so the outline left the trunk
 * running dead parallel and then turned over into the apex dome all at once:
 * measured at the mid-height of the free run, a lobe was still 82–90% of its base
 * width. Whatever the apex radius did after that, the lobe read as a straight-
 * sided finger with a rounded end. A real root narrows CONTINUOUSLY along its
 * length, and pulling this control inboard is what makes the narrowing continuous
 * rather than an event at the tip: the same measurement is now 60–67%.
 *
 * It does NOT touch the base. The base is `neckHalf / roots` and partitions the
 * cervix exactly — roots that overhang the crown or overlap each other were two
 * real bugs with two tests pinning them — so the taper is applied strictly ABOVE
 * the trunk, to the flank, and the first thing the test beside this file checks is
 * that the bases are where they always were.
 */
const LOBE_TAPER = 0.58;
/**
 * The apex dome's radius, as a fraction of the root's own base half-width.
 *
 * THESE CAME DOWN WITH THE TAPER (from 0.78 and 0.55) and they had to: a dome
 * fixes the lobe's width where it turns, so a dome at 78% of the base is a lobe
 * that is still 78% wide at its tip, which is a mitten by definition however the
 * flank behaves below it. They were set that high to stop a wide white V opening
 * between neighbouring roots — a real problem, but one the shared TRUNK now
 * solves properly, holding the lobes coincident for the first half of the run so
 * nothing can open below it at all.
 *
 * THE TIPS ARE STILL ROUNDED, and in fact rounder: what makes a dome read as a
 * dome is its radius against its own width, and both fell together. Neither is
 * anywhere near a point — a molar lobe still ends 58% as wide as it began, and the
 * test holds every apex radius above a third of its base, which is the assertion
 * that stops a future pass tapering this back into a thorn.
 *
 * A lone conical root — an incisor's, a canine's — tapers FURTHER than a molar's,
 * which is true of the teeth and is what keeps the anterior block reading tapered.
 *
 * THE MULTI VALUE IS ALSO WHAT KEEPS A SPLAYED LOBE SMOOTH, and that is what set
 * it precisely rather than roughly. A leaning lobe carries its dome outboard of
 * its own flank; if the dome is as wide as the flank below it, the outer edge
 * gains a SHOULDER where the two meet — drawn at 0.58 it was plainly visible on
 * an upper 6, a bump the reference has nowhere. Sized so the dome's outer control
 * lands level with the flank's, the taper runs straight into the dome and the
 * outer edge is one clean line. A primary molar still shows a trace of it: its
 * splay is the widest in the mouth (1.12 x 1.2) and no dome above a third of the
 * base can be tucked inside that lean. It is smaller than it was before this pass,
 * which is the most that can be had without touching splay, and splay is a claim
 * about a real tooth rather than a drawing knob.
 */
const APEX_ROUND_SINGLE = 0.4;
const APEX_ROUND_MULTI = 0.46;
/** How far the crown's flank control point sits outboard of the biting edge's
 *  corner, as a fraction of the crown's shoulder — the corner radius. Kept under
 *  1 so the rounding never bulges the crown past its own height of contour. */
const OCCLUSAL_CORNER = 0.55;
/** The outer roots of a three-rooted upper molar against its palatal root. */
const SHORT_ROOT = 0.9;

function metricsFor(fdi: number): FamilyMetrics {
  const base = PERMANENT_METRICS[toothFamily(fdi)];
  if (!isDeciduous(fdi)) return base;
  return {
    ...base,
    crownWidth: base.crownWidth * DECIDUOUS_CROWN_WIDTH,
    neckWidth: base.neckWidth * DECIDUOUS_NECK_WIDTH,
    crownHeight: base.crownHeight * DECIDUOUS_CROWN_HEIGHT,
    splay: base.splay * DECIDUOUS_SPLAY,
    apexTop: base.apexTop + DECIDUOUS_APEX_DROP,
  };
}

/**
 * Which family a tooth belongs to.
 *
 * THERE ARE NO DECIDUOUS PREMOLARS. Positions 4 and 5 of a primary quadrant are
 * the first and second primary MOLARS (D and E) — the permanent premolars erupt
 * into those sockets later. A classifier that reused the permanent rule would
 * draw a child's D and E as single-rooted premolars, which is the exact tooth
 * whose roots a clinician is looking at when deciding whether it can be
 * restored or has to come out.
 */
export function toothFamily(fdi: number): ToothFamily {
  const position = displayNumber(fdi);
  if (position <= 2) return "incisor";
  if (position === 3) return "canine";
  if (isDeciduous(fdi)) return "molar";
  return position <= 5 ? "premolar" : "molar";
}

/**
 * How many roots this tooth has. Standard permanent and primary dentition.
 *
 * The two that carry the surprise, and therefore the two the tests name
 * explicitly:
 *
 * - The UPPER FIRST PREMOLAR (4) commonly has TWO roots, buccal and palatal,
 *   while the upper second (5) and both lower premolars have one. This is the
 *   single most-forgotten root count in the mouth.
 * - MOLARS SPLIT BY ARCH: upper molars have THREE roots (two buccal, one
 *   palatal), lower molars TWO (mesial and distal). Primary molars follow their
 *   own arch the same way — three above, two below — which is why this function
 *   asks archOf() and not the dentition.
 *
 * Third molars are genuinely variable in life; they are drawn to the arch's
 * standard here, because a chart diagram is a position marker and not a
 * radiograph.
 */
export function rootCount(fdi: number): number {
  const family = toothFamily(fdi);
  const upper = archOf(fdi) === "upper";
  if (family === "incisor" || family === "canine") return 1;
  if (family === "premolar") return upper && displayNumber(fdi) === 4 ? 2 : 1;
  return upper ? 3 : 2;
}

/**
 * How many cusps the biting edge carries. Zero on an incisor, which is the
 * point: an incisor has an EDGE, not a table, and CHARTING.md §3.1 is explicit
 * that "occlusal" is never the right word for one.
 *
 * DATA, NOT DRAWING. Nothing scallops the biting edge any more — see the header —
 * so this number no longer changes a single coordinate. It stays exported and
 * stays on the shape because it is a clinical fact about the tooth, it is the
 * distinction between an edge and a table that §3.1 turns on, and the next thing
 * that needs it (a cusp-level annotation, a wear score) should find it here
 * rather than rediscover it. Deleting a true fact because today's renderer has no
 * use for it is how the fact comes back wrong.
 *
 * FIVE CUSPS ON THE LOWER FIRST MOLAR, four on everything else in the family.
 * The mandibular first permanent molar and the mandibular second PRIMARY molar
 * both carry a fifth distal cusp, and they are the same tooth position one
 * dentition apart. It is a small tell, and it is the sort of small tell a
 * clinician reads without noticing they read it.
 */
export function cuspCount(fdi: number): number {
  const family = toothFamily(fdi);
  if (family === "incisor") return 0;
  if (family === "canine") return 1;
  if (family === "premolar") return 2;
  const position = displayNumber(fdi);
  const fifthCusp = isDeciduous(fdi) ? position === 5 : position === 6;
  return archOf(fdi) === "lower" && fifthCusp ? 5 : 4;
}

export interface ToothShape {
  /** Ready for the SVG's viewBox attribute. */
  viewBox: string;
  family: ToothFamily;
  upper: boolean;
  deciduous: boolean;
  rootCount: number;
  cuspCount: number;
  /** The crown silhouette on its own. */
  crown: string;
  /** One `d` per root, in drawing order across the box. */
  roots: readonly string[];
  /**
   * Where each root TIP lands, already mirrored. Exported because the flare of a
   * root is a claim about anatomy — a primary molar's roots spread wider than
   * its successor's — and a claim nothing can measure is a claim nothing can
   * hold. Reading it out of the path string in a test would be reading the
   * drawing rather than the geometry.
   */
  apices: readonly { x: number; y: number }[];
  /** Half the width of the cervix. The waist the roots emerge from, and what the
   *  flare above is measured against. */
  neckHalf: number;
  /**
   * Where the shared trunk ends and the grooves between roots begin, on screen.
   *
   * Below this line (above it, on the lower arch) every root holds its full base
   * width, so adjacent flanks are coincident and the root block is ONE solid form
   * with no gap in it at all. Exported for the same reason `apices` is: "the roots
   * merge low" is a claim about the drawing that a reader can only otherwise check
   * by eye, and the eye is what let the first two root bugs through.
   */
  trunkY: number;
  /**
   * The radius of the rounded apex, in box units. Half the width of the dome the
   * root ends in, and greater than zero on every tooth — a zero here is a point,
   * which is the exact thing this shape is not allowed to be.
   */
  apexRadius: number;
  /**
   * Crown and roots as one multi-subpath `d`. FILLED it is their union, so the
   * tooth is one solid silhouette and one hit target; STROKED the subpath edges
   * show, which is what makes the root divisions visible. One path, both jobs,
   * and no second element to fall out of sync with the first.
   */
  silhouette: string;
  /** Where the biting edge sits ON SCREEN, after the arch mirror. */
  occlusalY: number;
  /** The cervix — the crown/root junction. */
  cervixY: number;
  /** The furthest root tip. Above the cervix on the upper arch, below it on the
   *  lower, and that ordering is what the mirror test asserts. */
  apexY: number;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * The full shape of one tooth.
 *
 * Built in CANONICAL space — y = 0 at the root apices, y = SHAPE_VIEW.h at the
 * biting edge — and mirrored on the way out for the lower arch by the single
 * `py` function below. Nothing downstream of `py` knows which arch it is in,
 * which is the only way to be sure the two arches cannot drift apart.
 */
export function toothShape(fdi: number): ToothShape {
  const m = metricsFor(fdi);
  const upper = archOf(fdi) === "upper";
  const roots = rootCount(fdi);
  const cusps = cuspCount(fdi);

  const W = SHAPE_VIEW.w;
  const H = SHAPE_VIEW.h;
  const cx = W / 2;

  // THE ONE MIRROR. On the upper arch canonical y is screen y: the apices are at
  // the top of the cell, pointing away from the occlusal plane, and the crown is
  // at the bottom against the surface grid. On the lower arch every y is
  // reflected through the middle of the box, so the roots point down.
  const py = (y: number) => (upper ? y : H - y);
  const pt = (x: number, y: number) => `${round(x)} ${round(py(y))}`;

  const crownHalf = (W * m.crownWidth) / 2;
  const neckHalf = crownHalf * m.neckWidth;
  const occlusalHalf = crownHalf * m.occlusalWidth;

  // A hair of margin at the biting edge so a 3px whole-tooth ring is not clipped
  // by the cell it is drawn in.
  const occlusalY = H * 0.985;
  const crownH = H * m.crownHeight;
  const cervixY = occlusalY - crownH;
  const apexY = H * m.apexTop;

  // ---- the crown -------------------------------------------------------
  // Out from the cervix to the height of contour, then in to a FLAT biting edge.
  // The bulge is what stops this reading as a rectangle, and it is the shape a
  // tooth actually has; the flat edge is what stops it reading as a saw, and it
  // is what Dentally draws.
  //
  // The corner where the flank meets the edge is rounded WITHOUT a second command,
  // by putting the flank's last control point at the edge's own y: a cubic leaves
  // its final control point along the line to its endpoint, so a control level
  // with the endpoint means the curve arrives HORIZONTALLY and merges into the
  // straight edge with no crease. Rounding it with a quadratic instead would have
  // been the obvious way and the wrong one — a `Q` in an incisor's crown is the
  // signature of the scallop this pass exists to delete, and one test reads the
  // path for exactly that.
  const cornerR = (crownHalf - occlusalHalf) * OCCLUSAL_CORNER;
  const crown = [
    `M ${pt(cx - neckHalf, cervixY)}`,
    `C ${pt(cx - crownHalf, cervixY + crownH * 0.3)} ${pt(cx - occlusalHalf - cornerR, occlusalY)} ${pt(cx - occlusalHalf, occlusalY)}`,
    `L ${pt(cx + occlusalHalf, occlusalY)}`,
    `C ${pt(cx + occlusalHalf + cornerR, occlusalY)} ${pt(cx + crownHalf, cervixY + crownH * 0.3)} ${pt(cx + neckHalf, cervixY)}`,
    "Z",
  ].join(" ");

  // ---- the roots -------------------------------------------------------
  // The roots meet the crown exactly AT the cervix, so the crown's own base line
  // and every root's base line fall on one another and draw as a single CEJ
  // line. Overlapping them into the crown instead put a second rule across the
  // neck, and two parallel lines under every tooth read as a feature rather than
  // as anatomy.
  const baseY = cervixY;
  // The shortest root on this tooth, and therefore the one that fixes where the
  // shared trunk can end: see the loop below.
  const shortestRun = (baseY - apexY) * (roots === 3 ? SHORT_ROOT : 1);
  const trunkY = baseY - shortestRun * TRUNK_RUN;
  // Half the width of the dome each root ends in. A lone conical root — an
  // incisor's, a canine's — still tapers further than a molar's before it turns,
  // which is true and is what keeps the anterior block reading as tapered. It is a
  // narrower dome, never a point: both are rounded, one more sharply than the other.
  const apexR = (neckHalf / roots) * (roots === 1 ? APEX_ROUND_SINGLE : APEX_ROUND_MULTI);
  const rootPaths: string[] = [];
  const apices: { x: number; y: number }[] = [];
  for (let i = 0; i < roots; i += 1) {
    // Bases divide the neck evenly and PARTITION it: adjacent roots meet on a
    // shared boundary and never overlap, and the outermost pair land exactly on
    // the cervix corners the crown's own path starts and ends at.
    //
    // THEY USED TO OVERLAP, BY A THIRD OF A SLOT, to put the furcation high up a
    // shared trunk. Rendered, that did the opposite of what it was reaching for,
    // and only rendered — no assertion in this file could see it. The silhouette
    // is STROKED as one multi-subpath `d`, so every edge of every subpath draws,
    // including the parts buried inside a neighbour: two overlapping roots do not
    // fuse into a trunk on screen, they draw an X, and a lower molar read as two
    // crossed leaves rather than one root bifurcating. The overlap also pushed the
    // root block WIDER than the cervix it grows out of — measured on tooth 46, the
    // bases spanned +/-36.1 against a neck of +/-30.87 — so a ledge of root stuck
    // out past the crown on both sides, which is anatomically impossible and read
    // as a drawing error at arm's length.
    //
    // THE TRUNK IS NOW A REAL SEGMENT, not a hint from a control point. The
    // previous pass tried to imply it by holding the flank CONTROL points out at
    // near-full width, which is a curve that starts narrowing immediately however
    // gently: measured, a gap opened from the very first unit above the cervix, so
    // a lower molar drew as two leaves touching at a point and an upper as three
    // spikes on a common base. Every root now runs STRAIGHT-SIDED at its full base
    // width up to `trunkY`, where adjacent flanks are coincident — the same x, so
    // literally no gap and, stroked, one line over another rather than two — and
    // only above it do they draw in. What is left between them is a groove that
    // starts partway up and stops well short of the cervix, which is both what a
    // furcation looks like and what the reference draws.
    //
    // trunkY is deliberately the SAME for every root of the tooth, computed off the
    // SHORTEST of them. A trunk measured per root would end higher under the long
    // palatal root of an upper 6 than under its two buccal neighbours, and the base
    // of the tooth would come apart in steps.
    const baseCentre = cx - neckHalf + ((2 * i + 1) * neckHalf) / roots;
    const baseHalf = neckHalf / roots;
    const apexX = cx + (baseCentre - cx) * m.splay;
    // On a three-rooted tooth the middle root runs longest, which is the
    // palatal root of an upper molar. On one and two roots every root is the
    // same length: see the header on why nothing here is asymmetric.
    const lengthFactor = roots === 3 && i !== 1 ? SHORT_ROOT : 1;
    const tipY = baseY - (baseY - apexY) * lengthFactor;
    const runY = baseY - tipY;
    // THE APEX IS ROUNDED BY CONSTRUCTION. Both cubics meeting at the tip carry
    // their adjacent control point at the tip's OWN y, one either side, so each
    // arrives and leaves horizontally: the two tangents are collinear and the tip
    // is a dome of radius `apexR` rather than the corner that two curves meeting at
    // an angle always make, however small the angle. That is the difference between
    // a root end and a thorn, and it is why the radius is exported and asserted
    // rather than left to the eye.
    //
    // Pushing the roundness through a control point ABOVE the tip instead — the
    // classic circle approximation — would put geometry outside the box on the
    // canine, whose apexTop is 0 and whose tip is therefore already on the edge of
    // it. Horizontal tangents round the tip using no vertical room at all.
    //
    // AND THE FLANK TAPERS ON ITS WAY THERE. `flankHalf` is the only difference
    // between this lobe and the parallel-sided one it replaces: the control that
    // used to sit at the lobe's full base width now sits at LOBE_TAPER of it, so
    // the outline starts drawing in the moment it leaves the trunk and keeps
    // drawing in all the way to the dome. Width against height is then a cubic
    // with controls (2*baseHalf, 2*flankHalf, 2*apexR, 0) — non-increasing from
    // the first unit and falling steadily through the middle, which is what a
    // taper IS and what the old (2*baseHalf, 2*baseHalf, ...) could never be: a
    // Bezier whose first two controls are equal leaves its start FLAT, so the old
    // lobe was mathematically guaranteed to run parallel before it turned.
    //
    // THE TAPER IS MEASURED ABOUT THE LOBE'S OWN AXIS, NOT ABOUT ITS BASE, and
    // that is what `flankCentre` is for. Taking the width in about `baseCentre`
    // was the first attempt and it drew a NOTCH into every splayed root: a lobe
    // that leans outward has its apex displaced from its base, so a control
    // narrowed about the base sits inboard of a dome that has already moved out,
    // and the outer edge went in and then back out again — worst on a primary
    // molar, whose splay is the widest in the mouth. Rendered side by side against
    // the shape this replaces, that notch was the one thing the taper made WORSE.
    // Sliding the control along the lobe's own spine, by exactly the fraction of
    // the free run it sits at, removes it: the lobe leans as one form and narrows
    // as one form. It changes no width — the lean is the same on both flanks and
    // cancels in the difference — so every measurement above still reads the same.
    const flankHalf = baseHalf * LOBE_TAPER;
    const flankY = tipY + runY * FLANK_HOLD;
    const flankCentre = baseCentre + (apexX - baseCentre) * ((trunkY - flankY) / (trunkY - tipY));
    rootPaths.push(
      [
        `M ${pt(baseCentre - baseHalf, baseY)}`,
        `L ${pt(baseCentre - baseHalf, trunkY)}`,
        `C ${pt(flankCentre - flankHalf, flankY)} ${pt(apexX - apexR, tipY)} ${pt(apexX, tipY)}`,
        `C ${pt(apexX + apexR, tipY)} ${pt(flankCentre + flankHalf, flankY)} ${pt(baseCentre + baseHalf, trunkY)}`,
        `L ${pt(baseCentre + baseHalf, baseY)}`,
        "Z",
      ].join(" "),
    );
    apices.push({ x: round(apexX), y: round(py(tipY)) });
  }

  return {
    viewBox: `0 0 ${W} ${H}`,
    family: toothFamily(fdi),
    upper,
    deciduous: isDeciduous(fdi),
    rootCount: roots,
    cuspCount: cusps,
    crown,
    roots: rootPaths,
    apices,
    neckHalf: round(neckHalf),
    trunkY: round(py(trunkY)),
    apexRadius: round(apexR),
    silhouette: [crown, ...rootPaths].join(" "),
    occlusalY: round(py(occlusalY)),
    cervixY: round(py(cervixY)),
    apexY: round(py(apexY)),
  };
}

// (The scalloped biting edge that used to live here — one peak per cusp with a
// valley back up to the shoulder between each pair — is deliberately gone. See
// the header: the edge is flat, and cuspCount() survives as data.)
