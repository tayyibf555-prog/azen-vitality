import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { GumLine } from "@/components/client/patients/record/perio/gum-line";
import {
  ARCH_ORDER,
  ASPECT_SITES,
  DEEP_POCKET_MM,
  DEFAULT_GUM_SCALE,
  buildGumProfile,
  buildGumProfiles,
  clippedVertices,
  describeGumProfile,
  describeGumScale,
  rulerLines,
  siteOrderFor,
  toPointsAttribute,
  yForMm,
} from "./gum-profile";
import type { GumProfile, GumSegment } from "./gum-profile";
import { buildPocketChart } from "./pocket-chart";
import type { ChartedSite, ChartedTooth } from "./pocket-chart";
import type { PerioAttribution, PerioSiteId } from "./types";

// ===========================================================================
// THE GUM LINE, PROVEN BY ITS ARITHMETIC.
//
// Every test below names the MUTATION it catches. That is the bar: a test that
// would still pass with the geometry quietly wrong is decoration, and on this
// component "quietly wrong" means a drawn clinical finding nobody measured.
//
// The four things that actually matter, in the order they would hurt someone:
//
//   1. a line drawn ACROSS a site nobody probed        — invented finding
//   2. a chart that autoscales per patient             — disease made to look normal
//   3. recession folded into the pocket                — the shape of the disease lost
//   4. buccal and lingual averaged                     — a number about neither
//
// Everything else here is in support of those four.
// ===========================================================================

const INTERPROXIMAL = new Set<PerioSiteId>(["mb", "db", "ml", "dl"]);
const ALL_SITES: readonly PerioSiteId[] = ["mb", "b", "db", "ml", "l", "dl"];

function site(
  id: PerioSiteId,
  probingDepth: number | null,
  recession: number | null,
  extra: Partial<ChartedSite> = {},
): ChartedSite {
  return {
    site: id,
    probingDepth,
    recession,
    bleeding: false,
    suppuration: false,
    plaque: false,
    // The engine's own rule, restated only so this file can build a fixture
    // without booting the validator. The integration test at the bottom proves
    // buildPocketChart produces the same shape.
    cal: probingDepth !== null && recession !== null ? probingDepth + recession : null,
    recorded: probingDepth !== null,
    interproximal: INTERPROXIMAL.has(id),
    ...extra,
  };
}

function tooth(n: number, sites: ChartedSite[]): ChartedTooth {
  const depths = sites.map((s) => s.probingDepth).filter((d): d is number => d !== null);
  const cals = sites.map((s) => s.cal).filter((c): c is number => c !== null);
  const interCals = sites
    .filter((s) => s.interproximal)
    .map((s) => s.cal)
    .filter((c): c is number => c !== null);
  return {
    tooth: n,
    sextant: null,
    sites,
    mobility: null,
    furcation: null,
    recordedSites: sites.filter((s) => s.recorded).length,
    deepestPocket: depths.length ? Math.max(...depths) : null,
    worstCal: cals.length ? Math.max(...cals) : null,
    worstInterproximalCal: interCals.length ? Math.max(...interCals) : null,
  };
}

/** Every site of a tooth at one depth and one recession. */
function evenTooth(n: number, depth: number | null, recession: number | null): ChartedTooth {
  return tooth(
    n,
    ALL_SITES.map((s) => site(s, depth, recession)),
  );
}

function upperBuccal(teeth: ChartedTooth[], presentTeeth?: number[]): GumProfile {
  return buildGumProfile({ teeth, arch: "upper", aspect: "buccal", presentTeeth });
}

function columnIndex(profile: GumProfile, toothNumber: number, siteId: PerioSiteId): number {
  const found = profile.columns.findIndex((c) => c.tooth === toothNumber && c.site === siteId);
  expect(found, `no column for tooth ${toothNumber} ${siteId}`).toBeGreaterThanOrEqual(0);
  return found;
}

function vertexAt(segments: GumSegment[], column: number) {
  for (const seg of segments) {
    const point = seg.points.find((p) => p.column === column);
    if (point) return point;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Millimetres to screen units. The mapping, at known values.
// ---------------------------------------------------------------------------

describe("millimetres map to screen units at a fixed, stated rate", () => {
  // DEFAULT_GUM_SCALE: 6 units/mm, 4mm coronal, 16mm apical, 27 units/tooth.
  // Upper arch is drawn crowns-down, so APICAL IS UP THE SCREEN: apicalSign -1,
  // and the CEJ baseline sits 16mm (96 units) down from the top.
  const upper = upperBuccal([evenTooth(11, 3, 0)]);
  const lower = buildGumProfile({ teeth: [evenTooth(41, 3, 0)], arch: "lower", aspect: "buccal" });

  it("puts the CEJ where the box's apical extent says, per arch", () => {
    // MUTATION CAUGHT: swapping coronalMm and apicalMm in the cejY expression —
    // the whole drawing slides 12mm and every reading is drawn in the wrong half
    // of the box while still looking like a chart.
    expect(upper.cejY).toBe(96); // 16mm apical extent × 6
    expect(upper.apicalSign).toBe(-1);
    expect(lower.cejY).toBe(24); // 4mm coronal extent × 6
    expect(lower.apicalSign).toBe(1);
    expect(upper.height).toBe(120);
    expect(lower.height).toBe(120);
  });

  it("converts known millimetre values exactly", () => {
    // MUTATION CAUGHT: dropping apicalSign (every reading drawn on the wrong side
    // of the CEJ — recession would draw as gingival overgrowth), or an off-by-one
    // in unitsPerMm.
    expect(yForMm(0, upper)).toBe(96);
    expect(yForMm(1, upper)).toBe(90);
    expect(yForMm(3, upper)).toBe(78);
    expect(yForMm(-2, upper)).toBe(108); // coronal to the CEJ: DOWN, on the upper arch
    expect(yForMm(0, lower)).toBe(24);
    expect(yForMm(3, lower)).toBe(42);
    expect(yForMm(-2, lower)).toBe(12);
  });

  it("places the margin from recession and the pocket base from CAL", () => {
    // 3mm pocket, 0mm recession: margin AT the CEJ, base 3mm apical of it.
    const profile = upperBuccal([evenTooth(11, 3, 0)]);
    const col = columnIndex(profile, 11, "b");
    expect(vertexAt(profile.margin, col)!.y).toBe(96);
    expect(vertexAt(profile.base, col)!.y).toBe(78);
    // MUTATION CAUGHT: placing the base at `depth` rather than at `recession +
    // depth`. With 0 recession the two agree, which is exactly why the second
    // case is here.
    const receded = upperBuccal([evenTooth(11, 3, 2)]);
    expect(vertexAt(receded.margin, col)!.y).toBe(84); // 2mm apical
    expect(vertexAt(receded.base, col)!.y).toBe(66); // CAL 5mm apical
  });

  it("states its scale in words, because a scale nobody can read is not stated", () => {
    const sentence = describeGumScale();
    expect(sentence).toContain("6 units per millimetre");
    expect(sentence).toContain("same for every patient");
  });
});

// ---------------------------------------------------------------------------
// 2. THE SCALE IS FIXED. No per-patient autoscale.
// ---------------------------------------------------------------------------

describe("a healthy mouth and a diseased one are drawn to the same scale", () => {
  const healthy = upperBuccal(ARCH_ORDER.upper.map((t) => evenTooth(t, 2, 0)));
  const diseased = upperBuccal(ARCH_ORDER.upper.map((t) => evenTooth(t, 9, 3)));

  it("gives the same box and the same baseline to both", () => {
    expect(diseased.height).toBe(healthy.height);
    expect(diseased.cejY).toBe(healthy.cejY);
    expect(diseased.scale).toEqual(healthy.scale);
    expect(diseased.scale.unitsPerMm).toBe(DEFAULT_GUM_SCALE.unitsPerMm);
  });

  it("draws a 2mm pocket at the same height in both, so disease does not normalise away", () => {
    // MUTATION CAUGHT: any autoscale — `unitsPerMm = height / maxCal` is the
    // obvious "make it fit" fix, and it is the one that makes a 9mm mouth and a
    // 2mm mouth photograph identically. Under it the healthy chart's 2mm band
    // would be as tall as the diseased chart's 12mm one.
    const col = columnIndex(healthy, 16, "b");
    const healthyBand = vertexAt(healthy.margin, col)!.y - vertexAt(healthy.base, col)!.y;
    const diseasedBand = vertexAt(diseased.margin, col)!.y - vertexAt(diseased.base, col)!.y;
    expect(healthyBand).toBe(2 * DEFAULT_GUM_SCALE.unitsPerMm);
    expect(diseasedBand).toBe(9 * DEFAULT_GUM_SCALE.unitsPerMm);
    expect(diseasedBand).toBeGreaterThan(healthyBand * 4);
  });

  it("marks a reading that runs off the box instead of squeezing it back in", () => {
    // 15mm depth on 15mm recession is a CAL of 30 — legal input under
    // pocket-chart.ts's own bounds, and past the 16mm apical extent.
    const extreme = upperBuccal([evenTooth(11, 15, 15)]);
    const clipped = clippedVertices(extreme);
    expect(clipped.length).toBeGreaterThan(0);
    // MUTATION CAUGHT: clamping mm as well as y. The drawn point is at the edge;
    // the RECORDED millimetres must survive the clamp untouched, or the chart has
    // quietly restated a 30mm attachment loss as 16mm.
    for (const vertex of clipped) expect(vertex.mm).toBe(30);
    expect(clipped.every((v) => v.y >= 0 && v.y <= extreme.height)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. THE BREAK. The rule that outranks everything else here.
// ---------------------------------------------------------------------------

/** No segment anywhere may join two columns that are not neighbours. */
function assertNoSegmentSpansAGap(profile: GumProfile) {
  for (const segments of [profile.margin, profile.base]) {
    for (const seg of segments) {
      for (let i = 1; i < seg.points.length; i += 1) {
        expect(
          seg.points[i].column - seg.points[i - 1].column,
          `a ${seg.kind} segment joins columns ${seg.points[i - 1].column} and ${seg.points[i].column}`,
        ).toBe(1);
      }
    }
  }
}

describe("a site with no reading breaks the line and is never interpolated across", () => {
  it("breaks across a tooth that was not charted", () => {
    // 16 and 14 charted, 15 not. A single smooth line from 16 to 14 would draw a
    // gum margin over a tooth nobody probed.
    const profile = upperBuccal([evenTooth(16, 3, 1), evenTooth(14, 3, 1)]);
    assertNoSegmentSpansAGap(profile);
    expect(profile.margin.length).toBe(2);
    expect(profile.base.length).toBe(2);
    // MUTATION CAUGHT: filtering nulls out of one flat list before segmenting —
    // the classic `points.filter(Boolean)` — which yields ONE segment whose
    // consecutive points sit three columns apart and draws straight over 15.
    const first = profile.margin[0].points;
    const second = profile.margin[1].points;
    expect(first.every((p) => p.tooth === 16)).toBe(true);
    expect(second.every((p) => p.tooth === 14)).toBe(true);
    expect(second[0].column - first[first.length - 1].column).toBeGreaterThan(1);
    // and the two segments share no vertex, so nothing bridges them
    expect(first.some((p) => second.some((q) => q.column === p.column))).toBe(false);
  });

  it("breaks inside a single tooth when one of its sites was skipped", () => {
    // Tooth 16, mesiobuccal and distobuccal probed, mid-buccal not.
    const profile = upperBuccal([tooth(16, [site("mb", 3, 1), site("db", 3, 1)])]);
    assertNoSegmentSpansAGap(profile);
    const skipped = columnIndex(profile, 16, "b");
    expect(vertexAt(profile.margin, skipped)).toBeNull();
    expect(profile.margin.length).toBe(2);
    expect(profile.margin.every((s) => s.points.length === 1)).toBe(true);
  });

  it("models the gap explicitly, with a reason and a sentence", () => {
    const profile = upperBuccal([evenTooth(16, 3, 1), evenTooth(14, 3, 1)]);
    const interior = profile.breaks.filter((b) => b.interior);
    expect(interior.length).toBe(1);
    expect(interior[0].teeth).toEqual([15]);
    expect(interior[0].reasons).toEqual(["tooth-not-charted"]);
    // MUTATION CAUGHT: a break that renders as blank space with no explanation.
    // "Not charted" and "healthy" look identical as white space, and CHARTING.md
    // §6.3 names that confusion as the way this screen kills someone.
    expect(interior[0].note).toContain("not a finding of health");
  });

  it("tells an extracted tooth apart from an unprobed one", () => {
    const present = ARCH_ORDER.upper.filter((t) => t !== 15);
    const profile = upperBuccal([evenTooth(16, 3, 1), evenTooth(14, 3, 1)], present);
    const gap = profile.breaks.find((b) => b.teeth.includes(15))!;
    expect(gap.reasons).toEqual(["absent-tooth"]);
    expect(gap.note).toContain("not in the mouth");
    // MUTATION CAUGHT: collapsing the two into one "no data" state. A tooth that
    // is gone has no periodontium; a tooth that was skipped has one and nobody
    // looked. Only the second is an outstanding examination.
    expect(gap.note).not.toContain("not a finding of health");
    expect(profile.teeth.find((t) => t.tooth === 15)!.presence).toBe("absent");
    expect(profile.teeth.find((t) => t.tooth === 13)!.presence).toBe("not-charted");
    expect(profile.teeth.find((t) => t.tooth === 16)!.presence).toBe("charted");
  });

  it("draws neither line when a depth was typed but no recession, rather than assuming zero", () => {
    // The half-entered site. Assuming recession 0 places the margin at the CEJ —
    // a specific, confident, invented clinical claim.
    const profile = upperBuccal([tooth(16, [site("b", 5, null)])]);
    const col = columnIndex(profile, 16, "b");
    expect(vertexAt(profile.margin, col)).toBeNull();
    expect(vertexAt(profile.base, col)).toBeNull();
    expect(profile.depthWithoutRecession).toContain(col);
    expect(profile.measuredColumns).toBe(0);
  });

  it("says how much of the row it could not draw", () => {
    const profile = upperBuccal([evenTooth(16, 3, 1)]);
    expect(profile.totalColumns).toBe(48); // 16 teeth × 3 buccal sites
    expect(profile.measuredColumns).toBe(3);
    const sentence = describeGumProfile(profile);
    expect(sentence).toContain("3 of 48");
    expect(sentence).toContain("broken across");
  });

  it("never draws an empty row as a clean one", () => {
    const sentence = describeGumProfile(upperBuccal([]));
    expect(sentence).toContain("no gum line is drawn");
    expect(sentence).toContain("Nothing here is a finding of health");
  });
});

// ---------------------------------------------------------------------------
// 4. THE SHADED POCKET — between the two lines, and nowhere else.
// ---------------------------------------------------------------------------

describe("the pocket is shaded between the margin and the base", () => {
  const profile = upperBuccal([evenTooth(16, 4, 1)]);

  it("closes the polygon on the margin above and the base below, over the same columns", () => {
    expect(profile.bands.length).toBe(1);
    const band = profile.bands[0];
    expect(band.columns.length).toBe(3);
    // Six points: three margin left-to-right, three base right-to-left.
    expect(band.points.length).toBe(6);
    const top = band.points.slice(0, 3);
    const bottom = band.points.slice(3);
    for (let i = 0; i < 3; i += 1) {
      const col = band.columns[i];
      expect(top[i].y).toBe(vertexAt(profile.margin, col)!.y);
      // the base half runs backwards, which is what closes the polygon
      expect(bottom[2 - i].y).toBe(vertexAt(profile.base, col)!.y);
      expect(top[i].x).toBe(bottom[2 - i].x);
    }
    // MUTATION CAUGHT: building the polygon from the base twice, or forgetting
    // to reverse the lower edge — the second draws a bow-tie that crosses itself
    // and shades the wrong region entirely.
    expect(band.deepestMm).toBe(4);
  });

  it("shades nothing over a column with no reading", () => {
    const gapped = upperBuccal([evenTooth(16, 4, 1), evenTooth(14, 4, 1)]);
    const skipped = new Set(gapped.breaks.flatMap((b) => b.columns));
    expect(skipped.size).toBeGreaterThan(0);
    // MUTATION CAUGHT: one band spanning the whole arch. A single polygon from 16
    // to 14 shades a pocket over tooth 15 — the invented finding, in its most
    // convincing form, because a shaded area reads as measured.
    expect(gapped.bands.length).toBe(2);
    for (const band of gapped.bands) {
      for (const col of band.columns) expect(skipped.has(col)).toBe(false);
    }
  });

  it("shades nothing where the depth is known but the recession is not", () => {
    const profile2 = upperBuccal([tooth(16, [site("mb", 4, 1), site("b", 4, null), site("db", 4, 1)])]);
    expect(profile2.bands.length).toBe(2);
    expect(profile2.bands.every((b) => b.columns.length === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. THE HEADLINE. Same CAL, different disease, different picture.
// ---------------------------------------------------------------------------

describe("3mm of pocket and 3mm of recession are the same CAL and must not draw alike", () => {
  const pocket = upperBuccal([evenTooth(11, 3, 0)]); // deep pocket, gum at the CEJ
  const recession = upperBuccal([evenTooth(11, 0, 3)]); // no pocket, gum 3mm down the root
  const col = columnIndex(pocket, 11, "b");

  it("agrees about the attachment level, because that is what CAL means", () => {
    expect(vertexAt(pocket.base, col)!.mm).toBe(3);
    expect(vertexAt(recession.base, col)!.mm).toBe(3);
    expect(vertexAt(pocket.base, col)!.y).toBe(vertexAt(recession.base, col)!.y);
  });

  it("disagrees about where the gum is, by the whole 3mm", () => {
    // MUTATION CAUGHT — and this is THE mutation this component exists to
    // survive: drawing the gingival margin at the CEJ always, i.e. ignoring
    // recession and treating the pocket depth as the band. Under it these two
    // charts are pixel-identical, and a chart that draws periodontitis and
    // toothbrush abrasion identically is worthless.
    expect(vertexAt(pocket.margin, col)!.y).toBe(96); // at the CEJ
    expect(vertexAt(recession.margin, col)!.y).toBe(78); // 3mm apical of it
    expect(vertexAt(pocket.margin, col)!.y - vertexAt(recession.margin, col)!.y).toBe(
      3 * DEFAULT_GUM_SCALE.unitsPerMm,
    );
  });

  it("shades a pocket in one and no pocket in the other", () => {
    expect(pocket.bands[0].deepestMm).toBe(3);
    expect(recession.bands[0].deepestMm).toBe(0);
    const height = (p: GumProfile) =>
      Math.abs(vertexAt(p.margin, col)!.y - vertexAt(p.base, col)!.y);
    expect(height(pocket)).toBe(18);
    // A zero-height band is the right answer, not a missing one: there is no
    // pocket to shade. The band still EXISTS so the row is not read as unprobed.
    expect(height(recession)).toBe(0);
    expect(recession.bands.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Buccal and lingual are separate profiles.
// ---------------------------------------------------------------------------

describe("buccal and lingual are never averaged into one line", () => {
  const mixed = tooth(16, [
    site("mb", 2, 0),
    site("b", 2, 0),
    site("db", 2, 0),
    site("ml", 8, 0),
    site("l", 8, 0),
    site("dl", 8, 0),
  ]);

  it("draws each surface at its own depth, and neither at the mean", () => {
    const buccal = buildGumProfile({ teeth: [mixed], arch: "upper", aspect: "buccal" });
    const lingual = buildGumProfile({ teeth: [mixed], arch: "upper", aspect: "lingual" });
    const bY = vertexAt(buccal.base, columnIndex(buccal, 16, "b"))!.y;
    const lY = vertexAt(lingual.base, columnIndex(lingual, 16, "l"))!.y;
    expect(bY).toBe(96 - 12); // 2mm
    expect(lY).toBe(96 - 48); // 8mm
    // MUTATION CAUGHT: one line per tooth built from a mean or a max of all six
    // sites. The mean of 2 and 8 is 5 — a depth measured nowhere in this mouth,
    // and one that hides an 8mm palatal pocket behind a reassuring middle.
    const mean = 96 - 5 * DEFAULT_GUM_SCALE.unitsPerMm;
    expect(bY).not.toBe(mean);
    expect(lY).not.toBe(mean);
  });

  it("gives a profile per arch and per surface, four rows, none of them merged", () => {
    const rows = buildGumProfiles([mixed]);
    expect(rows.map((r) => `${r.arch}-${r.aspect}`)).toEqual([
      "upper-buccal",
      "upper-lingual",
      "lower-buccal",
      "lower-lingual",
    ]);
    // The lower rows hold nothing and are still returned: a row that is not on
    // the page cannot be seen to be empty.
    expect(rows[2].measuredColumns).toBe(0);
    expect(rows[3].measuredColumns).toBe(0);
  });

  it("puts only its own three sites in a row", () => {
    const buccal = buildGumProfile({ teeth: [mixed], arch: "upper", aspect: "buccal" });
    expect(new Set(buccal.columns.map((c) => c.site))).toEqual(new Set(ASPECT_SITES.buccal));
  });
});

// ---------------------------------------------------------------------------
// Arch layout: the columns a reader reads a tooth number against.
// ---------------------------------------------------------------------------

describe("the arch is laid out where a clinician expects to find a tooth", () => {
  it("runs the patient's right on the viewer's left, matching the FDI chart", () => {
    const profile = upperBuccal([]);
    expect(profile.teeth.map((t) => t.tooth)).toEqual([...ARCH_ORDER.upper]);
    expect(profile.teeth[0].tooth).toBe(18);
    expect(profile.teeth[15].tooth).toBe(28);
  });

  it("puts the mesial site towards the midline on both sides", () => {
    // MUTATION CAUGHT: a single fixed site order for the whole arch. It looks
    // right on one side and mirrors the other, which puts a fake step at the
    // midline and a kink at every tooth junction on half the chart.
    expect(siteOrderFor(16, "buccal")).toEqual(["db", "b", "mb"]); // right: mesial rightmost
    expect(siteOrderFor(26, "buccal")).toEqual(["mb", "b", "db"]); // left: mesial leftmost
    expect(siteOrderFor(46, "lingual")).toEqual(["dl", "l", "ml"]);
    expect(siteOrderFor(36, "lingual")).toEqual(["ml", "l", "dl"]);

    const profile = upperBuccal([]);
    const mesialOf16 = profile.columns[columnIndex(profile, 16, "mb")].x;
    const distalOf16 = profile.columns[columnIndex(profile, 16, "db")].x;
    expect(mesialOf16).toBeGreaterThan(distalOf16);
    const mesialOf26 = profile.columns[columnIndex(profile, 26, "mb")].x;
    const distalOf26 = profile.columns[columnIndex(profile, 26, "db")].x;
    expect(mesialOf26).toBeLessThan(distalOf26);
  });

  it("keeps a tooth at the same x whether or not it holds a reading", () => {
    // MUTATION CAUGHT: laying columns out from the CHARTED teeth. The arch would
    // close up around a missing tooth, so two visits could not be overlaid and a
    // gap would vanish instead of showing.
    const empty = upperBuccal([]);
    const partial = upperBuccal([evenTooth(16, 3, 1)]);
    expect(partial.columns.map((c) => c.x)).toEqual(empty.columns.map((c) => c.x));
    expect(partial.width).toBe(16 * DEFAULT_GUM_SCALE.toothWidth);
  });

  it("charts a third molar, which has a column and no sextant", () => {
    const profile = upperBuccal([evenTooth(18, 4, 1)]);
    expect(profile.measuredColumns).toBe(3);
    expect(profile.unplacedTeeth).toEqual([]);
  });

  it("names a tooth it cannot place rather than dropping its readings", () => {
    // A deciduous tooth is in no permanent arch. Silently discarding it is how a
    // mixed-dentition child's chart loses half its findings.
    const profile = upperBuccal([evenTooth(55, 3, 1)]);
    expect(profile.unplacedTeeth).toEqual([55]);
  });
});

// ---------------------------------------------------------------------------
// Dentally's own 4mm threshold, and the backdrop the lines are read against.
// ---------------------------------------------------------------------------

describe("a site of 4mm or deeper is marked, on Dentally's threshold", () => {
  it("marks the depth, not the attachment level", () => {
    // MUTATION CAUGHT: testing CAL against 4mm. 3mm of recession with a 1mm
    // sulcus is a CAL of 4 and a perfectly healthy pocket — marking it red teaches
    // a hygienist to ignore the mark, which is worse than not having one.
    expect(DEEP_POCKET_MM).toBe(4);
    const shallowButReceded = upperBuccal([evenTooth(16, 1, 3)]);
    expect(shallowButReceded.deepColumns).toEqual([]);
    const deep = upperBuccal([evenTooth(16, 4, 0)]);
    expect(deep.deepColumns.length).toBe(3);
  });

  it("shades a deep pocket more strongly than a shallow one, per band", () => {
    expect(upperBuccal([evenTooth(16, 3, 0)]).bands[0].deepestMm).toBe(3);
    expect(upperBuccal([evenTooth(16, 6, 0)]).bands[0].deepestMm).toBe(6);
  });
});

describe("the tooth outline is a backdrop and nothing is measured from it", () => {
  it("puts the crown on the coronal side of the CEJ on both arches", () => {
    const upper = upperBuccal([]);
    const lower = buildGumProfile({ teeth: [], arch: "lower", aspect: "buccal" });
    // Upper arch is drawn crowns-DOWN, so the crown occupies the bottom band.
    expect(upper.teeth[0].outline.crown.y).toBe(upper.cejY);
    expect(upper.teeth[0].outline.crown.height).toBe(24);
    // Lower arch crowns-UP: the top band.
    expect(lower.teeth[0].outline.crown.y).toBe(0);
    expect(lower.teeth[0].outline.crown.height).toBe(24);
    // The root runs the other way from the CEJ, on both.
    expect(upper.teeth[0].outline.root[2].y).toBeLessThan(upper.cejY);
    expect(lower.teeth[0].outline.root[2].y).toBeGreaterThan(lower.cejY);
  });

  it("gives every column a strip, so a renderer marks a site without arithmetic", () => {
    const profile = upperBuccal([]);
    for (const column of profile.columns) {
      expect(column.left).toBeLessThan(column.x);
      expect(column.left + column.width).toBeGreaterThan(column.x);
      expect(column.width).toBe(profile.siteWidth);
    }
    const gapped = upperBuccal([evenTooth(16, 3, 1), evenTooth(14, 3, 1)]);
    const gap = gapped.breaks.find((b) => b.interior)!;
    expect(gap.x).toBe(gapped.columns[gap.fromColumn].left);
    expect(gap.width).toBe(gap.columns.length * gapped.siteWidth);
  });
});

// ---------------------------------------------------------------------------
// No precision the numbers lack.
// ---------------------------------------------------------------------------

describe("the drawing claims no precision the probe has", () => {
  it("rules in whole millimetres only, with no half-millimetre tick", () => {
    const profile = upperBuccal([]);
    const lines = rulerLines(profile);
    expect(lines.every((l) => Number.isInteger(l.mm))).toBe(true);
    expect(lines[0].mm).toBe(-DEFAULT_GUM_SCALE.coronalMm);
    expect(lines[lines.length - 1].mm).toBe(DEFAULT_GUM_SCALE.apicalMm);
    expect(lines.find((l) => l.mm === 0)!.label).toBe("CEJ");
    expect(lines.find((l) => l.mm === 5)!.label).toBe("5mm");
    expect(lines.find((l) => l.mm === 3)!.label).toBeNull();
    expect(lines.find((l) => l.mm === 5)!.y).toBe(yForMm(5, profile));
  });

  it("emits straight-segment point lists and nothing a curve could be built from", () => {
    // MUTATION CAUGHT: a smoothing pass. `toPointsAttribute` is the ONLY way
    // coordinates leave this module, and a `points` attribute cannot express a
    // bezier — so a spline would need a new exported path builder, which the
    // source check below forbids.
    expect(toPointsAttribute([{ x: 1, y: 2 }, { x: 3.456, y: 4 }])).toBe("1,2 3.46,4");
  });

  it("exports no curve builder and no way back from screen units to millimetres", () => {
    // Rule 1: the drawing is DERIVED. An inverse mapping is the first thing a
    // drag handle needs, so there is not one — and this fails the moment somebody
    // adds it, which is the point.
    const source = readFileSync(fileURLToPath(new URL("./gum-profile.ts", import.meta.url)), "utf8");
    const exported = [...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
    expect(exported).toContain("buildGumProfile");
    for (const name of exported) {
      expect(name, `${name} looks like an inverse mapping`).not.toMatch(/^(mmFor|mmAt|toMm|fromY)/);
    }
    // Comments stripped first. Three of them explain why there is no spline, and
    // a check that cannot tell a comment from code would forbid saying so.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/bezier|cubicTo|quadraticTo|catmull|spline|curveTo|smooth/i);
    // Nor a path-data builder, which is the other way a curve reaches a screen.
    expect(code).not.toMatch(/["'`]M\s*\$?\{|\bd:\s*`/);
  });
});

// ---------------------------------------------------------------------------
// Purity, and the real engine.
// ---------------------------------------------------------------------------

describe("the profile is a pure reading of the record", () => {
  it("returns the same geometry every time it is asked", () => {
    const teeth = [evenTooth(16, 4, 1), evenTooth(26, 6, 2)];
    expect(JSON.stringify(upperBuccal(teeth))).toBe(JSON.stringify(upperBuccal(teeth)));
  });

  it("draws from a chart the engine built, not only from a fixture this file wrote", () => {
    const recorded: PerioAttribution = {
      clinician: { id: "u1", name: "Blerta Hoxha", gdcNumber: null },
      at: "2026-07-01T09:00:00.000Z",
    };
    const chart = buildPocketChart({
      sextants: ["UR"],
      teeth: [17, 16, 15, 14].map((t) => ({
        tooth: t,
        sites: ALL_SITES.map((s) => ({
          site: s,
          probingDepth: 5,
          recession: 2,
          bleeding: true,
          suppuration: false,
          plaque: false,
        })),
        mobility: null,
        furcation: null,
      })),
      recorded,
      probe: "who-621",
    });
    const profile = buildGumProfile({ teeth: chart.teeth, arch: "upper", aspect: "buccal" });
    expect(profile.measuredColumns).toBe(12);
    const col = columnIndex(profile, 16, "b");
    // The engine computed cal = 7; this file only placed it.
    expect(vertexAt(profile.base, col)!.mm).toBe(7);
    expect(vertexAt(profile.margin, col)!.mm).toBe(2);
    expect(vertexAt(profile.margin, col)!.bleeding).toBe(true);
    // Four ADJACENT charted teeth in a sixteen-tooth arch. The twelve measured
    // columns join into ONE segment — they are neighbours, so joining them is
    // correct — and the other thirty-six are broken rather than drawn flat.
    expect(profile.margin.length).toBe(1);
    expect(profile.margin[0].points.length).toBe(12);
    expect(profile.breaks.flatMap((b) => b.columns).length).toBe(36);
    expect(profile.breaks.every((b) => b.reasons.includes("tooth-not-charted"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE RENDERER, checked by reading it. vitest collects no .tsx, and the claims
// below are properties of the SOURCE rather than of any render.
// ---------------------------------------------------------------------------

const GUM_LINE = readFileSync(
  fileURLToPath(
    new URL("../../components/client/patients/record/perio/gum-line.tsx", import.meta.url),
  ),
  "utf8",
);

/** Text as a reader sees it: tags stripped, entities undone, whitespace collapsed. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function renderRows(teeth: ChartedTooth[], presentTeeth?: number[]): string {
  return renderToStaticMarkup(
    createElement(GumLine, {
      profiles: buildGumProfiles(teeth, { presentTeeth }),
      scopeNote: "SCOPE-SENTENCE-MARKER",
    }),
  );
}

describe("the drawing, rendered", () => {
  const markup = renderRows([evenTooth(16, 5, 2), evenTooth(14, 3, 0), evenTooth(36, 2, 0)], [
    ...ARCH_ORDER.upper.filter((t) => t !== 15),
    ...ARCH_ORDER.lower,
  ]);

  it("draws straight polylines and a filled band, and no path element at all", () => {
    expect(markup).toContain("<polyline");
    expect(markup).toContain("<polygon");
    expect(markup).not.toContain("<path");
    // A `points` attribute cannot carry a curve. This is the property, not the
    // intention: whatever else changes, a spline cannot get onto this screen
    // without a path element.
    expect(markup).not.toMatch(/\bC\s?-?\d|\bQ\s?-?\d/);
  });

  it("authors nothing — the picture is derived and cannot be typed into", () => {
    for (const tag of ["<input", "<button", "<textarea", "<select", "contenteditable"]) {
      expect(markup, `the gum line renders ${tag}`).not.toContain(tag);
    }
    expect(text(markup)).toContain("cannot be drawn on");
  });

  it("says out loud what it did not draw", () => {
    const body = text(markup);
    expect(body).toContain("tooth 15 is not in the mouth"); // extracted
    expect(body).toContain("teeth 18, 17 were not charted"); // nobody probed them
    expect(body).toContain("This is not a finding of health");
    // MUTATION CAUGHT: `teeth 18, 17 was not charted`. Not pedantry — a sentence
    // that reads as machine output is a sentence a clinician stops reading, and
    // these are the sentences that stop a gap being mistaken for health.
    expect(body).not.toMatch(/teeth [\d, ]+ was not charted/);
    expect(body).not.toMatch(/teeth [\d, ]+ is not in the mouth/);
  });

  it("renders no React warning, so every tooltip it thinks it drew is on the page", () => {
    // An <svg><title> whose children are an ARRAY does not render, and React only
    // says so on stderr — the drawing looks right and the explanation is gone.
    // Rendering without listening for that is how this shipped once already.
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      renderRows([evenTooth(16, 5, 2)], ARCH_ORDER.upper as number[]);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([]);
  });

  it("carries the scale and the scope on the page, not in a caption nobody prints", () => {
    const body = text(markup);
    expect(body).toContain("6 units per millimetre");
    expect(body).toContain("SCOPE-SENTENCE-MARKER");
  });

  it("gives every hatch pattern its own id, so four rows do not collide", () => {
    const ids = [...markup.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
    // MUTATION CAUGHT: one hard-coded id. Duplicate ids in a document resolve to
    // whichever loaded first, so three of the four rows would silently lose the
    // hatch that says "not recorded" — leaving plain white space, which is the
    // exact false-completeness reading this component must never produce.
    for (const id of ids) expect(markup).toContain(`url(#${id})`);
  });

  it("labels the picture for a screen reader with the same sentence it prints", () => {
    expect(markup).toContain('role="img"');
    expect(markup).toContain("aria-label=\"upper arch, buccal surface: gum line drawn from");
  });

  it("renders an entirely empty chart without inventing a single line", () => {
    const empty = renderToStaticMarkup(createElement(GumLine, { profiles: buildGumProfiles([]) }));
    expect(empty).not.toContain("<polyline");
    expect(empty).not.toContain("<polygon points=\"\"");
    expect(text(empty).split("Nothing here is a finding of health").length - 1).toBe(4);
  });
});

describe("the renderer is thin, server-safe and cannot be drawn on", () => {
  it("stays universal, so the server perio tab can render it", () => {
    // The perio client-boundary test pins which files may be islands; this one is
    // not on that list and must never declare itself one.
    expect(GUM_LINE).not.toMatch(/^\s*["']use client["']/m);
    expect(GUM_LINE).not.toMatch(/\buseState|useEffect|useRef|useReducer\b/);
    expect(GUM_LINE).not.toMatch(/from\s+["'][^"']*perio\/gate["']/);
  });

  it("takes no handler prop and installs no pointer or drag affordance", () => {
    // Rule 1, enforced where it would actually be broken. A gum line a clinician
    // can drag is a clinical finding edited by eye.
    expect(GUM_LINE).not.toMatch(/^\s*on[A-Z]\w*\??:\s*\(/m);
    expect(GUM_LINE).not.toMatch(/onPointer|onMouse|onDrag|draggable|onClick|onChange|onKeyDown/);
  });

  it("computes no geometry of its own", () => {
    // Every coordinate on screen comes from the tested module. A second mapping
    // in the renderer is a second answer nobody tested.
    expect(GUM_LINE).toMatch(/from\s+["']@\/lib\/perio\/gum-profile["']/);
    expect(GUM_LINE).not.toMatch(/unitsPerMm\s*\*/);
    expect(GUM_LINE).not.toMatch(/\bMath\.(min|max|abs)\(/);
  });

  it("draws straight segments and reads no clock", () => {
    expect(GUM_LINE).not.toMatch(/<path/);
    expect(GUM_LINE).not.toMatch(/Date\.now\(\)|new Date\(/);
  });

  it("writes its Tailwind classes literally, because Tailwind v4 scans raw source", () => {
    // An interpolated class name is a class Tailwind never sees and never emits.
    expect(GUM_LINE).not.toMatch(/className=\{`[^`]*\$\{/);
  });
});
