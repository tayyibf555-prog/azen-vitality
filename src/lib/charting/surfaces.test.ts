import { describe, it, expect } from "vitest";
import {
  DECIDUOUS_LOWER,
  DECIDUOUS_UPPER,
  PERMANENT_LOWER,
  PERMANENT_UPPER,
  displayNumber,
} from "./fdi";
import {
  SURFACE_LETTER,
  SURFACE_ORDER,
  canonicaliseSurfaces,
  isMolarScheme,
  parseSurfaces,
  regionForIndex,
  regionsForBoxSide,
  serialiseSurfaces,
  splitIndicesByScheme,
  surfaceIndicesOf,
  surfaceLayout,
  surfaceRegions,
} from "./surfaces";
import type { BoxSide, SurfaceId } from "./types";

const ALL_PERMANENT = [...PERMANENT_UPPER, ...PERMANENT_LOWER];
const ALL_DECIDUOUS = [...DECIDUOUS_UPPER, ...DECIDUOUS_LOWER];
const ALL_TEETH = [...ALL_PERMANENT, ...ALL_DECIDUOUS];
const PERMANENT_MOLARS = ALL_PERMANENT.filter((t) => displayNumber(t) >= 6);
const NON_MOLARS = [...ALL_PERMANENT.filter((t) => displayNumber(t) < 6), ...ALL_DECIDUOUS];

describe("surface notation", () => {
  it("serialises in M-O-D-B-L order whatever order it is given", () => {
    // A mesio-occluso-distal is "MOD", the most recognised code in dentistry.
    // "DMO" is not a thing, and a chart that prints it is not trusted.
    expect(serialiseSurfaces(["distal", "mesial", "occlusal"])).toBe("MOD");
    expect(serialiseSurfaces(["occlusal", "distal", "mesial"])).toBe("MOD");
    expect(serialiseSurfaces(["lingual", "buccal", "occlusal"])).toBe("OBL");
    expect(serialiseSurfaces([])).toBe("");
  });

  it("canonicalises by de-duplicating and re-sorting, never by dropping", () => {
    expect(canonicaliseSurfaces(["distal", "mesial", "distal"])).toEqual(["mesial", "distal"]);
    expect(SURFACE_ORDER).toEqual(["mesial", "occlusal", "distal", "buccal", "lingual"]);
    expect(Object.values(SURFACE_LETTER).join("")).toBe("MODBL");
  });
});

// ===========================================================================
// THE SCHEME. Which teeth carry eight regions and which carry five.
//
// CHARTING.md 2.6 measured it against 500 live rows: position 6 reached index
// 8, and every other position — deciduous included — capped at 5. A deciduous
// molar has four cusps and still uses the five-scheme, which is a deliberate
// Dentally simplification and NOT a gap in our reading of it. Getting this
// wrong does not mis-colour a tooth, it decides whether three real charted
// surfaces of every molar exist on our screen at all.
// ===========================================================================

describe("isMolarScheme", () => {
  it("is true for every permanent 6, 7 and 8, in all four quadrants", () => {
    expect(PERMANENT_MOLARS).toHaveLength(12);
    for (const fdi of PERMANENT_MOLARS) {
      expect(isMolarScheme(fdi), `${fdi} should carry the 8-scheme`).toBe(true);
    }
    // Named explicitly, so a quadrant dropped from the helper above is still caught.
    for (const fdi of [16, 17, 18, 26, 27, 28, 36, 37, 38, 46, 47, 48]) {
      expect(isMolarScheme(fdi), `${fdi}`).toBe(true);
    }
  });

  it("is false for every permanent 1-5", () => {
    for (const fdi of [11, 12, 13, 14, 15, 21, 25, 31, 35, 41, 45]) {
      expect(isMolarScheme(fdi), `${fdi}`).toBe(false);
    }
  });

  it("is false for EVERY deciduous tooth, the four-cusp deciduous molars included", () => {
    // 55, 54, 65, 64, 75, 74, 85 and 84 are the deciduous molars. Dentally
    // buckets them with the simple scheme; charting them with eight regions
    // would offer a clinician three positions Dentally cannot hold.
    for (const fdi of ALL_DECIDUOUS) {
      expect(isMolarScheme(fdi), `${fdi} is deciduous and must use the 5-scheme`).toBe(false);
    }
    expect(ALL_DECIDUOUS).toHaveLength(20);
  });

  it("is false for a value that is not a tooth at all", () => {
    for (const notATooth of [0, 9, 19, 49, 50, 86, 99, -16, 1.6]) {
      expect(isMolarScheme(notATooth), `${notATooth}`).toBe(false);
    }
  });
});

// ===========================================================================
// INDEX -> REGION. The mapping DENTALLY.md fixes, and the one this whole file
// exists for.
//
// Every assertion below names ONE index and ONE position. That is deliberate:
// an assertion that only checked "four distinct edges" would pass with left and
// right swapped, and a chart with left and right swapped marks the wrong
// surface of the right tooth, which is the hardest error to spot afterwards.
// ===========================================================================

describe("surfaceRegions and regionForIndex — the 5-scheme", () => {
  it("places 1 top, 2 right, 3 bottom, 4 left and 5 centre, on an incisor", () => {
    expect(regionForIndex(11, 1)).toEqual({ kind: "peripheral", index: 1, edge: "top" });
    expect(regionForIndex(11, 2)).toEqual({ kind: "peripheral", index: 2, edge: "right" });
    expect(regionForIndex(11, 3)).toEqual({ kind: "peripheral", index: 3, edge: "bottom" });
    expect(regionForIndex(11, 4)).toEqual({ kind: "peripheral", index: 4, edge: "left" });
    expect(regionForIndex(11, 5)).toEqual({ kind: "centre", index: 5 });
  });

  it("runs clockwise from the top, so no two adjacent indices can be swapped", () => {
    // Dentally: "counted CLOCKWISE around the edge of the tooth". Written as a
    // sequence rather than four independent equalities, because the sequence is
    // the claim: top then right then bottom then left, in that order.
    const edges = [1, 2, 3, 4].map((i) => {
      const r = regionForIndex(15, i);
      return r && r.kind === "peripheral" ? r.edge : null;
    });
    expect(edges).toEqual(["top", "right", "bottom", "left"]);
  });

  it("gives every non-molar exactly five regions, indexed 1..5", () => {
    for (const fdi of NON_MOLARS) {
      const regions = surfaceRegions(fdi);
      expect(regions, `${fdi}`).toHaveLength(5);
      expect(regions.map((r) => r.index), `${fdi}`).toEqual([1, 2, 3, 4, 5]);
      expect(regions.filter((r) => r.kind === "peripheral"), `${fdi}`).toHaveLength(4);
      expect(regions.filter((r) => r.kind === "centre"), `${fdi}`).toHaveLength(1);
      expect(regions.some((r) => r.kind === "centre-quadrant"), `${fdi}`).toBe(false);
    }
  });

  it("uses each of the four edges exactly once", () => {
    for (const fdi of NON_MOLARS) {
      const edges = surfaceRegions(fdi)
        .filter((r) => r.kind === "peripheral")
        .map((r) => (r.kind === "peripheral" ? r.edge : ""));
      expect(new Set(edges).size, `${fdi}`).toBe(4);
    }
  });
});

describe("surfaceRegions and regionForIndex — the 8-scheme", () => {
  it("keeps 1-4 on the same four trapezoids as every other tooth", () => {
    // The two schemes differ ONLY in the centre. If the rim ever diverges, a
    // molar's mesial fill lands somewhere a premolar's does not.
    expect(regionForIndex(16, 1)).toEqual({ kind: "peripheral", index: 1, edge: "top" });
    expect(regionForIndex(16, 2)).toEqual({ kind: "peripheral", index: 2, edge: "right" });
    expect(regionForIndex(16, 3)).toEqual({ kind: "peripheral", index: 3, edge: "bottom" });
    expect(regionForIndex(16, 4)).toEqual({ kind: "peripheral", index: 4, edge: "left" });
  });

  it("subdivides the centre into 5 top-left, 6 top-right, 7 bottom-right and 8 bottom-left", () => {
    // Clockwise again, continuing from the top-left corner exactly as the rim
    // started there. Each corner is asserted by name, so swapping any pair —
    // including the diagonal tr/bl swap a 'four distinct corners' check would
    // sail through — fails here.
    expect(regionForIndex(16, 5)).toEqual({ kind: "centre-quadrant", index: 5, corner: "tl" });
    expect(regionForIndex(16, 6)).toEqual({ kind: "centre-quadrant", index: 6, corner: "tr" });
    expect(regionForIndex(16, 7)).toEqual({ kind: "centre-quadrant", index: 7, corner: "br" });
    expect(regionForIndex(16, 8)).toEqual({ kind: "centre-quadrant", index: 8, corner: "bl" });
  });

  it("gives every permanent molar exactly eight regions, indexed 1..8", () => {
    for (const fdi of PERMANENT_MOLARS) {
      const regions = surfaceRegions(fdi);
      expect(regions, `${fdi}`).toHaveLength(8);
      expect(regions.map((r) => r.index), `${fdi}`).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(regions.filter((r) => r.kind === "peripheral"), `${fdi}`).toHaveLength(4);
      expect(regions.filter((r) => r.kind === "centre-quadrant"), `${fdi}`).toHaveLength(4);
      // A molar has NO undivided centre. A renderer that drew one would paint
      // over the four quadrants that carry the real cusp-level findings.
      expect(regions.some((r) => r.kind === "centre"), `${fdi}`).toBe(false);
    }
  });

  it("uses each of the four corners exactly once", () => {
    for (const fdi of PERMANENT_MOLARS) {
      const corners = surfaceRegions(fdi)
        .filter((r) => r.kind === "centre-quadrant")
        .map((r) => (r.kind === "centre-quadrant" ? r.corner : ""));
      expect(new Set(corners).size, `${fdi}`).toBe(4);
      expect([...corners].sort()).toEqual(["bl", "br", "tl", "tr"]);
    }
  });
});

describe("regionForIndex — the mapping is POSITIONAL, never mirrored", () => {
  // DENTALLY.md is explicit: render by POSITION, never by anatomical name. The
  // index says where on the diagram, and Dentally's sentence describes the
  // DIAGRAM ("the top left hand corner of the tooth"), not the mouth. So index 2
  // is the right-hand trapezoid on every tooth in every quadrant, and it is a
  // DIFFERENT anatomical surface on the two sides of the mouth. That is exactly
  // why nothing here ever returns "mesial".
  //
  // CHARTING.md 3.4 leaves anatomically-fixed vs screen-fixed open. This module
  // implements screen-fixed, per DENTALLY.md, and the choice lives in this test
  // so that resolving it upstream fails here loudly rather than drifting.
  it("does not mirror between the patient's right and left", () => {
    for (const index of [1, 2, 3, 4]) {
      expect(regionForIndex(16, index)).toEqual(regionForIndex(26, index));
      expect(regionForIndex(46, index)).toEqual(regionForIndex(36, index));
      expect(regionForIndex(11, index)).toEqual(regionForIndex(21, index));
    }
    for (const index of [5, 6, 7, 8]) {
      expect(regionForIndex(16, index)).toEqual(regionForIndex(26, index));
      expect(regionForIndex(48, index)).toEqual(regionForIndex(38, index));
    }
  });

  it("does not mirror between the arches either", () => {
    for (const index of [1, 2, 3, 4, 5]) {
      expect(regionForIndex(15, index)).toEqual(regionForIndex(45, index));
    }
  });

  // The guard on the whole no-naming rule. A region carries a POSITION and the
  // verbatim index, and nothing else: the moment one of these objects can hold
  // "mesial" or "buccal", the screen is making a clinical claim it cannot support.
  it("never returns an anatomical surface name", () => {
    const names = new Set<string>(SURFACE_ORDER);
    for (const fdi of ALL_TEETH) {
      for (const region of surfaceRegions(fdi)) {
        for (const value of Object.values(region)) {
          expect(names.has(String(value)), `${fdi} leaked ${String(value)}`).toBe(false);
        }
      }
    }
  });
});

describe("regionForIndex — an index outside the tooth's own scheme is REFUSED", () => {
  // Never clamped, never guessed onto the nearest region. An index we cannot
  // place is carried through to `unrecognised` and stays visible on screen; a
  // guessed one marks a surface the practice never charted, and nothing on the
  // page distinguishes it from a real reading.
  it("refuses 6, 7 and 8 on every non-molar", () => {
    for (const fdi of NON_MOLARS) {
      for (const index of [6, 7, 8]) {
        expect(regionForIndex(fdi, index), `${fdi} index ${index}`).toBeNull();
      }
    }
  });

  it("refuses 6, 7 and 8 on a DECIDUOUS MOLAR, which has four cusps and still uses the 5-scheme", () => {
    for (const fdi of [55, 54, 65, 64, 75, 74, 85, 84]) {
      expect(regionForIndex(fdi, 6), `${fdi}`).toBeNull();
      expect(regionForIndex(fdi, 8), `${fdi}`).toBeNull();
      expect(regionForIndex(fdi, 5), `${fdi}`).toEqual({ kind: "centre", index: 5 });
    }
  });

  it("refuses 0, 9 and anything else outside the range, on both schemes", () => {
    for (const fdi of [11, 16]) {
      for (const index of [0, -1, 9, 10, 99]) {
        expect(regionForIndex(fdi, index), `${fdi} index ${index}`).toBeNull();
      }
    }
  });

  it("refuses a non-integer rather than rounding it onto a region", () => {
    for (const index of [1.5, 4.9, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(regionForIndex(16, index), `${index}`).toBeNull();
    }
  });

  it("refuses every index on a value that is not a tooth, and draws no regions for it", () => {
    expect(surfaceRegions(99)).toEqual([]);
    expect(surfaceRegions(0)).toEqual([]);
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(regionForIndex(99, index), `${index}`).toBeNull();
    }
  });
});

// ===========================================================================
// PARSING. The defect that made the chart blank on real patients.
//
// The mock emits letters; live Dentally emits integers (CHARTING.md 2.6, 500
// real rows). Before this, an integer matched neither the name map nor the
// letter map, so EVERY live surface landed in `unrecognised` and the arch drew
// thirty-two teeth with no fills — a positive claim that a patient with a full
// restorative history has none. It looked right in dev for exactly that reason.
// ===========================================================================

describe("parseSurfaces", () => {
  it("reads a letter code, an array of letters and an array of names identically", () => {
    const expected = { surfaces: ["mesial", "occlusal", "distal"], indices: [], unrecognised: [] };
    expect(parseSurfaces("MOD")).toEqual(expected);
    expect(parseSurfaces("mod")).toEqual(expected);
    expect(parseSurfaces(["M", "O", "D"])).toEqual(expected);
    expect(parseSurfaces(["mesial", "occlusal", "distal"])).toEqual(expected);
    expect(parseSurfaces("M,O,D")).toEqual(expected);
  });

  // An unknown letter dropped at the mapper is a finding the clinician never
  // learns about. It is kept so the tooltip and History can show it.
  it("keeps an unrecognised letter rather than swallowing it", () => {
    expect(parseSurfaces("MODX")).toEqual({
      surfaces: ["mesial", "occlusal", "distal"],
      indices: [],
      unrecognised: ["X"],
    });
    expect(parseSurfaces("P")).toEqual({ surfaces: [], indices: [], unrecognised: ["P"] });
  });

  it("treats absent surfaces as a whole-tooth item, not as an unknown letter", () => {
    expect(parseSurfaces(null)).toEqual({ surfaces: [], indices: [], unrecognised: [] });
    expect(parseSurfaces("")).toEqual({ surfaces: [], indices: [], unrecognised: [] });
    expect(parseSurfaces([])).toEqual({ surfaces: [], indices: [], unrecognised: [] });
  });

  // THE FABRICATION BUG, and it is the reason splitSurfaceString exists. The old
  // rule was "no delimiter, so split into characters", and every one of mesial,
  // distal, buccal and occlusal ENDS IN L: the chart filled the lingual
  // trapezoid of a tooth that had no lingual restoration, and printed "OL" in
  // History and in the export. A fabricated positive on a clinical chart is
  // worse than a missing one, because nothing on screen marks it as a guess.
  it("never invents a surface from the letters inside a surface NAME", () => {
    for (const name of ["mesial", "occlusal", "distal", "buccal", "lingual"] as const) {
      const parsed = parseSurfaces(name);
      expect(parsed.surfaces, `${name} was mined for letters`).toEqual([name]);
      expect(parsed.indices).toEqual([]);
      expect(parsed.unrecognised).toEqual([]);
    }
  });

  it("keeps an unreadable long value whole rather than mining it for letters", () => {
    // "l" would otherwise match lingual and "o" occlusal.
    expect(parseSurfaces("root canal")).toEqual({
      surfaces: [],
      indices: [],
      unrecognised: ["ROOT", "CANAL"],
    });
    expect(parseSurfaces("palatal-cusp")).toEqual({
      surfaces: [],
      indices: [],
      unrecognised: ["PALATAL-CUSP"],
    });
  });

  it("reads the live wire shape: an ARRAY OF INTEGERS", () => {
    // CHARTING.md 2.6, verified against production: `surfaces` is an array of
    // integers. This is the shape every real row arrives in.
    expect(parseSurfaces([5])).toEqual({ surfaces: [], indices: [5], unrecognised: [] });
    expect(parseSurfaces([3, 7, 8])).toEqual({ surfaces: [], indices: [3, 7, 8], unrecognised: [] });
    expect(parseSurfaces(3)).toEqual({ surfaces: [], indices: [3], unrecognised: [] });
    expect(parseSurfaces("3")).toEqual({ surfaces: [], indices: [3], unrecognised: [] });
    expect(parseSurfaces(["3", "5"])).toEqual({ surfaces: [], indices: [3, 5], unrecognised: [] });
    expect(parseSurfaces("1,2,3")).toEqual({ surfaces: [], indices: [1, 2, 3], unrecognised: [] });
  });

  it("sorts and de-duplicates indices, so a repeat cannot double-draw", () => {
    expect(parseSurfaces([8, 3, 3, 5]).indices).toEqual([3, 5, 8]);
  });

  it("carries all eight molar indices, which is the whole point of the 8-scheme", () => {
    expect(parseSurfaces([1, 2, 3, 4, 5, 6, 7, 8]).indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseSurfaces([1, 2, 3, 4, 5, 6, 7, 8]).unrecognised).toEqual([]);
  });

  it("refuses an integer that is not a surface index in ANY scheme, and keeps it visible", () => {
    // 0, 9 and 12 are not surfaces on any tooth Dentally charts. They are not
    // clamped to 1 or 8; they stay in `unrecognised` so the tooltip, History,
    // the export and the status bar all say a value arrived that we could not
    // place.
    expect(parseSurfaces(0)).toEqual({ surfaces: [], indices: [], unrecognised: ["0"] });
    expect(parseSurfaces(9)).toEqual({ surfaces: [], indices: [], unrecognised: ["9"] });
    expect(parseSurfaces(12)).toEqual({ surfaces: [], indices: [], unrecognised: ["12"] });
    expect(parseSurfaces(-1)).toEqual({ surfaces: [], indices: [], unrecognised: ["-1"] });
    expect(parseSurfaces(2.5)).toEqual({ surfaces: [], indices: [], unrecognised: ["2.5"] });
  });

  it("reads a mixed value without losing either half", () => {
    // Not a shape live Dentally sends, but the mock and our own draft table use
    // letters and a tolerant parser must not drop one form to accept the other.
    expect(parseSurfaces("M,3")).toEqual({
      surfaces: ["mesial"],
      indices: [3],
      unrecognised: [],
    });
    expect(parseSurfaces(["occlusal", 8, "Z"])).toEqual({
      surfaces: ["occlusal"],
      indices: [8],
      unrecognised: ["Z"],
    });
  });

  it("reads a compact digit string the way it reads a compact letter code", () => {
    // "135" is three indices, exactly as "MOD" is three letters.
    expect(parseSurfaces("135")).toEqual({ surfaces: [], indices: [1, 3, 5], unrecognised: [] });
    expect(parseSurfaces("678")).toEqual({ surfaces: [], indices: [6, 7, 8], unrecognised: [] });
    // A molar can carry all eight. A five-character ceiling — the width of a
    // five-region letter code — dropped the whole value into `unrecognised`.
    expect(parseSurfaces("12345678").indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("still refuses to mine a long WORD for letters after the digit widening", () => {
    // The fabrication guard and the digit branch must not have merged: "palatal"
    // is seven characters and every letter of it would match something.
    expect(parseSurfaces("palatal")).toEqual({
      surfaces: [],
      indices: [],
      unrecognised: ["PALATAL"],
    });
    expect(parseSurfaces("occlusa1")).toEqual({
      surfaces: [],
      indices: [],
      unrecognised: ["OCCLUSA1"],
    });
  });
});

// ===========================================================================
// SCHEME SPLIT AT THE READ. Which of an item's indices this item's teeth can
// actually carry.
// ===========================================================================

describe("splitIndicesByScheme", () => {
  it("places every index a molar can hold", () => {
    expect(splitIndicesByScheme([16], [3, 7, 8])).toEqual({
      placeable: [3, 7, 8],
      outOfScheme: [],
    });
  });

  it("rejects a molar-only index on an incisor, and keeps it visible", () => {
    expect(splitIndicesByScheme([11], [5, 7])).toEqual({ placeable: [5], outOfScheme: [7] });
  });

  it("places an index that ANY of the item's teeth can hold", () => {
    // One treatment_plan_item can name several teeth — a bridge spans them. An
    // index the molar carries must not be discarded because the premolar beside
    // it cannot, or a real charted surface disappears from the molar.
    expect(splitIndicesByScheme([15, 16], [7])).toEqual({ placeable: [7], outOfScheme: [] });
    expect(splitIndicesByScheme([15, 14], [7])).toEqual({ placeable: [], outOfScheme: [7] });
  });

  it("keeps indices when the item names no tooth, because there is nothing to reject against", () => {
    // A tooth-less row draws nothing anyway. Calling its surfaces unreadable
    // would put a count on screen that describes our parser, not the patient.
    expect(splitIndicesByScheme([], [5, 7])).toEqual({ placeable: [5, 7], outOfScheme: [] });
  });

  it("never invents an index and never reorders one", () => {
    const { placeable, outOfScheme } = splitIndicesByScheme([11, 16], [1, 5, 6, 7, 8]);
    expect([...placeable, ...outOfScheme].sort((a, b) => a - b)).toEqual([1, 5, 6, 7, 8]);
  });
});

describe("surfaceIndicesOf", () => {
  it("reads the indices off an item, and reports none for an item that carries none", () => {
    expect(surfaceIndicesOf({ surfaceIndices: [3, 8] })).toEqual([3, 8]);
    expect(surfaceIndicesOf({})).toEqual([]);
  });
});

// ===========================================================================
// THE LETTER BRIDGE. The mock, and our own draft table, speak in named
// surfaces; the diagram speaks in regions. This is the only crossing point,
// and it goes NAME -> POSITION, never the reverse.
// ===========================================================================

describe("regionsForBoxSide", () => {
  it("maps each edge to the single region that sits there", () => {
    expect(regionsForBoxSide(11, "top")).toEqual([{ kind: "peripheral", index: 1, edge: "top" }]);
    expect(regionsForBoxSide(11, "right")).toEqual([
      { kind: "peripheral", index: 2, edge: "right" },
    ]);
    expect(regionsForBoxSide(11, "bottom")).toEqual([
      { kind: "peripheral", index: 3, edge: "bottom" },
    ]);
    expect(regionsForBoxSide(11, "left")).toEqual([{ kind: "peripheral", index: 4, edge: "left" }]);
  });

  it("maps a non-molar centre to the one centre square", () => {
    expect(regionsForBoxSide(11, "centre")).toEqual([{ kind: "centre", index: 5 }]);
  });

  it("maps a MOLAR centre to all four quadrants, because a named occlusal covers the whole table", () => {
    // "O" on a molar is the whole occlusal surface. Drawing it as one quadrant
    // would show a quarter of a filling the practice recorded across the table.
    const centre = regionsForBoxSide(16, "centre");
    expect(centre).toHaveLength(4);
    expect(centre.map((r) => r.index)).toEqual([5, 6, 7, 8]);
  });

  it("draws nothing for a value that is not a tooth", () => {
    expect(regionsForBoxSide(99, "centre")).toEqual([]);
  });
});

describe("surfaceLayout", () => {
  const ALL = ALL_PERMANENT;

  // THE TRAP THIS MODULE EXISTS FOR. Mesial means toward the midline, so it is
  // on a different SIDE of the box for each half of the mouth. A layout that
  // draws mesial on one fixed side is wrong for half the mouth, and being wrong
  // here marks the wrong surface.
  it("mirrors mesial and distal about the midline", () => {
    expect(surfaceLayout(16).mesial).toBe("right");
    expect(surfaceLayout(16).distal).toBe("left");
    expect(surfaceLayout(26).mesial).toBe("left");
    expect(surfaceLayout(26).distal).toBe("right");
    expect(surfaceLayout(16).mesial).not.toBe(surfaceLayout(26).mesial);
    expect(surfaceLayout(16).distal).not.toBe(surfaceLayout(26).distal);
    // The lower arch mirrors on the same axis.
    expect(surfaceLayout(46).mesial).toBe("right");
    expect(surfaceLayout(36).mesial).toBe("left");
  });

  it("flips buccal and lingual between the arches, so buccal always points away from the page centre", () => {
    expect(surfaceLayout(16).buccal).toBe("top");
    expect(surfaceLayout(16).lingual).toBe("bottom");
    expect(surfaceLayout(46).buccal).toBe("bottom");
    expect(surfaceLayout(46).lingual).toBe("top");
    expect(surfaceLayout(16).buccal).not.toBe(surfaceLayout(46).buccal);
  });

  it("puts occlusal in the centre square on every tooth, deciduous included", () => {
    for (const fdi of [...ALL, 55, 51, 61, 65, 85, 81, 71, 75]) {
      expect(surfaceLayout(fdi).occlusal).toBe("centre");
    }
  });

  it("uses all five box sides exactly once on every tooth", () => {
    for (const fdi of ALL) {
      const layout = surfaceLayout(fdi);
      const sides = SURFACE_ORDER.map((s: SurfaceId) => layout[s]);
      expect(new Set<BoxSide>(sides).size).toBe(5);
    }
  });
});
