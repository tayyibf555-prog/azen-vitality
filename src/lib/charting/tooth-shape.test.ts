import { describe, expect, it } from "vitest";

import {
  DECIDUOUS_LOWER,
  DECIDUOUS_UPPER,
  PERMANENT_LOWER,
  PERMANENT_UPPER,
} from "./fdi";
import { SHAPE_VIEW, cuspCount, rootCount, toothFamily, toothShape } from "./tooth-shape";

// ===========================================================================
// THE ANATOMY TABLE, WRITTEN OUT BY HAND.
//
// Deliberately literal, and deliberately NOT derived from the module under test:
// a test that recomputed root counts with the same rule the module uses would
// pass just as happily with the rule inverted. These are the standard permanent
// and primary dentitions, indexed by POSITION (1..8 permanent, 1..5 primary) as
// [roots, cusps].
//
// The three claims that carry the weight, and the three a careless edit breaks:
//   - the upper FIRST premolar has two roots and the upper second has one;
//   - upper molars have three roots and lower molars two, in BOTH dentitions;
//   - the lower first permanent molar and the lower second primary molar carry a
//     fifth cusp, and nothing else does.
// ===========================================================================

type Anatomy = readonly [roots: number, cusps: number];

const UPPER_PERMANENT: readonly Anatomy[] = [
  [1, 0], // 1 central incisor
  [1, 0], // 2 lateral incisor
  [1, 1], // 3 canine
  [2, 2], // 4 first premolar - TWO roots, buccal and palatal
  [1, 2], // 5 second premolar
  [3, 4], // 6 first molar
  [3, 4], // 7 second molar
  [3, 4], // 8 third molar
];

const LOWER_PERMANENT: readonly Anatomy[] = [
  [1, 0], // 1 central incisor
  [1, 0], // 2 lateral incisor
  [1, 1], // 3 canine
  [1, 2], // 4 first premolar - one root, unlike its upper counterpart
  [1, 2], // 5 second premolar
  [2, 5], // 6 first molar - the five-cusped one
  [2, 4], // 7 second molar
  [2, 4], // 8 third molar
];

const UPPER_DECIDUOUS: readonly Anatomy[] = [
  [1, 0], // A central incisor
  [1, 0], // B lateral incisor
  [1, 1], // C canine
  [3, 4], // D first molar - there are no deciduous premolars
  [3, 4], // E second molar
];

const LOWER_DECIDUOUS: readonly Anatomy[] = [
  [1, 0], // A
  [1, 0], // B
  [1, 1], // C
  [2, 4], // D
  [2, 5], // E second primary molar - five cusps, as the lower first permanent
];

const ROWS: readonly { teeth: readonly number[]; anatomy: readonly Anatomy[]; name: string }[] = [
  { teeth: PERMANENT_UPPER, anatomy: UPPER_PERMANENT, name: "permanent upper" },
  { teeth: PERMANENT_LOWER, anatomy: LOWER_PERMANENT, name: "permanent lower" },
  { teeth: DECIDUOUS_UPPER, anatomy: UPPER_DECIDUOUS, name: "deciduous upper" },
  { teeth: DECIDUOUS_LOWER, anatomy: LOWER_DECIDUOUS, name: "deciduous lower" },
];

function anatomyOf(fdi: number, row: (typeof ROWS)[number]): Anatomy {
  return row.anatomy[(fdi % 10) - 1];
}

/** Every coordinate pair in a `d`, as points. The commands are dropped: what is
 *  being asserted is WHERE the geometry sits, never how it was drawn there. */
function pathPoints(d: string): { x: number; y: number }[] {
  const numbers = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: Number(numbers[i]), y: Number(numbers[i + 1]) });
  }
  return points;
}

describe("toothFamily", () => {
  it("puts deciduous 4 and 5 in the MOLAR family, because no deciduous premolar exists", () => {
    expect(toothFamily(54)).toBe("molar");
    expect(toothFamily(55)).toBe("molar");
    expect(toothFamily(84)).toBe("molar");
    // The same positions in the permanent dentition are premolars.
    expect(toothFamily(14)).toBe("premolar");
    expect(toothFamily(45)).toBe("premolar");
  });

  it("classifies every tooth in every row", () => {
    for (const row of ROWS) {
      for (const fdi of row.teeth) {
        expect(["incisor", "canine", "premolar", "molar"]).toContain(toothFamily(fdi));
      }
    }
  });
});

describe("root and cusp counts", () => {
  for (const row of ROWS) {
    it(`matches the anatomy table across the whole ${row.name} arch`, () => {
      expect(row.teeth.length).toBeGreaterThan(0);
      for (const fdi of row.teeth) {
        const [roots, cusps] = anatomyOf(fdi, row);
        expect({ fdi, roots: rootCount(fdi), cusps: cuspCount(fdi) }).toEqual({
          fdi,
          roots,
          cusps,
        });
      }
    });

    it(`draws exactly one root path per root across the ${row.name} arch`, () => {
      for (const fdi of row.teeth) {
        const shape = toothShape(fdi);
        const [roots, cusps] = anatomyOf(fdi, row);
        expect(shape.roots).toHaveLength(roots);
        expect(shape.rootCount).toBe(roots);
        expect(shape.cuspCount).toBe(cusps);
        // The silhouette is the crown plus every root, and nothing else.
        expect(shape.silhouette).toBe([shape.crown, ...shape.roots].join(" "));
      }
    });
  }

  it("gives the upper first premolar two roots and the upper second only one", () => {
    expect(rootCount(14)).toBe(2);
    expect(rootCount(24)).toBe(2);
    expect(rootCount(15)).toBe(1);
    expect(rootCount(25)).toBe(1);
    // And neither lower premolar gains the second root.
    expect(rootCount(34)).toBe(1);
    expect(rootCount(44)).toBe(1);
  });

  it("splits molars three roots above and two below, in both dentitions", () => {
    for (const fdi of [16, 17, 18, 26, 27, 28, 54, 55, 64, 65]) expect(rootCount(fdi)).toBe(3);
    for (const fdi of [36, 37, 38, 46, 47, 48, 74, 75, 84, 85]) expect(rootCount(fdi)).toBe(2);
  });

  it("gives a fifth cusp only to the lower first permanent and second primary molars", () => {
    expect(cuspCount(36)).toBe(5);
    expect(cuspCount(46)).toBe(5);
    expect(cuspCount(75)).toBe(5);
    expect(cuspCount(85)).toBe(5);
    for (const fdi of [16, 26, 37, 47, 38, 48, 74, 84, 54, 64]) expect(cuspCount(fdi)).toBe(4);
  });

  it("gives an incisor an edge and not a cusped table", () => {
    for (const fdi of [11, 12, 21, 22, 31, 32, 41, 42, 51, 52, 71, 72, 81, 82]) {
      expect(cuspCount(fdi)).toBe(0);
    }
  });

  it("gives every canine exactly one cusp on one root", () => {
    for (const fdi of [13, 23, 33, 43, 53, 63, 73, 83]) {
      expect(cuspCount(fdi)).toBe(1);
      expect(rootCount(fdi)).toBe(1);
    }
  });
});

describe("arch orientation", () => {
  // The whole point of these two: a shape module that ignored the arch, or that
  // mirrored the wrong way, would sail through every count assertion above.

  it("puts the roots ABOVE the crown on the upper arch, in screen coordinates", () => {
    for (const fdi of [...PERMANENT_UPPER, ...DECIDUOUS_UPPER]) {
      const shape = toothShape(fdi);
      expect(shape.upper).toBe(true);
      // Smaller y is higher on screen: apex above cervix above biting edge.
      expect(shape.apexY).toBeLessThan(shape.cervixY);
      expect(shape.cervixY).toBeLessThan(shape.occlusalY);

      const rootYs = shape.roots.flatMap((d) => pathPoints(d).map((p) => p.y));
      const crownYs = pathPoints(shape.crown).map((p) => p.y);
      // Every scrap of root geometry sits above the lowest point of the crown.
      expect(Math.max(...rootYs)).toBeLessThan(Math.max(...crownYs));
      expect(Math.min(...rootYs)).toBeLessThan(Math.min(...crownYs));
    }
  });

  it("puts the roots BELOW the crown on the lower arch, in screen coordinates", () => {
    for (const fdi of [...PERMANENT_LOWER, ...DECIDUOUS_LOWER]) {
      const shape = toothShape(fdi);
      expect(shape.upper).toBe(false);
      expect(shape.apexY).toBeGreaterThan(shape.cervixY);
      expect(shape.cervixY).toBeGreaterThan(shape.occlusalY);

      const rootYs = shape.roots.flatMap((d) => pathPoints(d).map((p) => p.y));
      const crownYs = pathPoints(shape.crown).map((p) => p.y);
      expect(Math.min(...rootYs)).toBeGreaterThan(Math.min(...crownYs));
      expect(Math.max(...rootYs)).toBeGreaterThan(Math.max(...crownYs));
    }
  });

  it("draws the lower arch as the exact vertical mirror of its upper counterpart", () => {
    // Pairs that share a family and both counts, so the ONLY difference between
    // them is the mirror. 14/44 is deliberately absent: those two differ in root
    // count and are covered above.
    for (const [upperFdi, lowerFdi] of [
      [11, 41],
      [12, 42],
      [13, 43],
      [15, 45],
      [51, 81],
      [53, 83],
    ]) {
      const upper = pathPoints(toothShape(upperFdi).silhouette);
      const lower = pathPoints(toothShape(lowerFdi).silhouette);
      expect(lower).toHaveLength(upper.length);
      for (let i = 0; i < upper.length; i += 1) {
        expect(lower[i].x).toBeCloseTo(upper[i].x, 3);
        expect(lower[i].y).toBeCloseTo(SHAPE_VIEW.h - upper[i].y, 2);
      }
    }
  });

  it("does not mirror horizontally: every shape is symmetric about the column centre", () => {
    // Nothing in this module may encode mesial or distal. A shape that leaned to
    // one side would be a left/right claim, and CHARTING.md 3.4 records that we
    // do not know how Dentally orients a quadrant's diagram.
    for (const fdi of [11, 14, 16, 23, 36, 46, 54, 85]) {
      const xs = pathPoints(toothShape(fdi).silhouette).map((p) => p.x);
      const centre = SHAPE_VIEW.w / 2;
      expect(Math.min(...xs) - 0).toBeCloseTo(SHAPE_VIEW.w - Math.max(...xs), 2);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(centre, 2);
    }
  });
});

describe("proportions", () => {
  it("draws an incisor crown wider than it is deep, and a chisel with no cusps", () => {
    const shape = toothShape(11);
    const points = pathPoints(shape.crown);
    const width = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
    const depth = Math.abs(shape.occlusalY - shape.cervixY);
    expect(width).toBeGreaterThan(depth);
    expect(shape.crown).not.toContain("Q");
  });

  it("gives the canine the longest root in the mouth", () => {
    const canine = Math.abs(toothShape(13).apexY - toothShape(13).cervixY);
    for (const fdi of [11, 12, 14, 15, 16, 17, 18]) {
      expect(canine).toBeGreaterThan(Math.abs(toothShape(fdi).apexY - toothShape(fdi).cervixY));
    }
  });

  // =========================================================================
  // THE CROWN CARRIES THE GLYPH.
  //
  // The crown fractions were written when the roots below them were sharp
  // spikes, and were never revisited after the spikes were softened into lobes.
  // The result, measured: the root took ~58% of a molar's glyph and ~53% of an
  // incisor's, so the crown was a squat body under three chunky fingers. The
  // reference's proportion is the other way round, and it is the right way round
  // for us too — the crown is where every surface, finding and click lives.
  //
  // NOTHING IN THIS FILE COULD SEE IT. Every assertion above is about counts,
  // orientation, width, flare or the root block's internals; not one compares the
  // crown's height against the root's. It took a screenshot, again.
  //
  // Bracketed on BOTH sides deliberately. "More crown" answered on its own invites
  // the opposite overshoot — a crown that swallows the glyph and leaves the roots
  // as a fringe, which loses the silhouette that tells a molar from a premolar at
  // a metre. So: the crown is never the smaller half, and the root is never less
  // than three fifths of the crown.
  // =========================================================================
  it("gives the crown at least as much of the glyph as the roots, in both dentitions", () => {
    for (const row of ROWS) {
      for (const fdi of row.teeth) {
        const shape = toothShape(fdi);
        const crown = Math.abs(shape.occlusalY - shape.cervixY);
        const root = Math.abs(shape.cervixY - shape.apexY);
        expect({ fdi, crownLeads: crown >= root }).toEqual({ fdi, crownLeads: true });
        expect({ fdi, rootSurvives: root >= crown * 0.6 }).toEqual({ fdi, rootSurvives: true });
      }
    }
  });

  it("keeps the canine closest to parity and the molar's root the longest share", () => {
    // The two families that pull in opposite directions, so the flat-0.5 answer
    // is ruled out as well as the old one. The canine must still carry the longest
    // root in the mouth (asserted above) and therefore takes the smallest crown
    // SHARE; the molar's identity is its root tripod, and lobes need vertical room
    // above the trunk to read as lobes, so it takes the smallest crown FRACTION.
    const share = (fdi: number) => {
      const shape = toothShape(fdi);
      const crown = Math.abs(shape.occlusalY - shape.cervixY);
      return crown / (crown + Math.abs(shape.cervixY - shape.apexY));
    };
    for (const fdi of [11, 14, 16]) expect(share(13)).toBeLessThan(share(fdi));
    const crownOf = (fdi: number) => Math.abs(toothShape(fdi).occlusalY - toothShape(fdi).cervixY);
    for (const fdi of [11, 13, 14]) expect(crownOf(16)).toBeLessThan(crownOf(fdi));
  });

  it("splays a deciduous molar's roots wider than its permanent counterpart's", () => {
    // Apex spread measured against the CERVIX the roots leave from, so this is
    // about flare and not about the deciduous tooth simply being drawn smaller.
    const flare = (fdi: number) => {
      const shape = toothShape(fdi);
      const xs = shape.apices.map((a) => a.x);
      return (Math.max(...xs) - Math.min(...xs)) / (shape.neckHalf * 2);
    };
    expect(flare(55)).toBeGreaterThan(flare(17));
    expect(flare(85)).toBeGreaterThan(flare(47));
    expect(flare(54)).toBeGreaterThan(flare(16));
    expect(flare(84)).toBeGreaterThan(flare(46));
  });

  it("gives a deciduous tooth a narrower, more constricted crown than its successor", () => {
    const width = (fdi: number) => {
      const xs = pathPoints(toothShape(fdi).crown).map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    // Smaller overall...
    expect(width(55)).toBeLessThan(width(17));
    expect(width(51)).toBeLessThan(width(11));
    // ...and more bulbous, which is the neck taken in harder relative to the
    // widest part of the crown.
    const waist = (fdi: number) => (toothShape(fdi).neckHalf * 2) / width(fdi);
    expect(waist(55)).toBeLessThan(waist(17));
    expect(waist(51)).toBeLessThan(waist(11));
  });

  // =========================================================================
  // THE ROOT TRUNK FITS THE NECK, AND ROOTS DO NOT OVERLAP.
  //
  // Both of these were wrong in the first anatomical pass and NOTHING in this
  // file caught it, because every assertion above is about counts, orientation
  // and outer extents — none of them looks at where one root sits relative to
  // its neighbour or to the cervix. It took a screenshot. Measured on tooth 46
  // then: the root bases spanned +/-36.1 about the centre against a cervix of
  // +/-30.87, so a shelf of root stuck out past the crown on both sides; and the
  // two bases overlapped by 10.5 units while the apices sat INSIDE that overlap,
  // so the roots crossed and a lower molar drew as two crossed leaves.
  //
  // Why the overlap cannot be papered over at render time: the silhouette is
  // stroked as ONE multi-subpath `d`, which is what makes the furcation visible
  // at all, and a stroke draws every subpath edge including the stretch hidden
  // inside a neighbour. There is no fill rule that hides it. So the geometry
  // itself has to partition, and that is what these two assert.
  // =========================================================================
  it("keeps every root base inside the cervix, and fills it exactly", () => {
    for (const row of ROWS) {
      for (const fdi of row.teeth) {
        const shape = toothShape(fdi);
        const centre = SHAPE_VIEW.w / 2;
        // The base line of a root path is its first point and its last-but-the-
        // close point: the outline leaves the cervix, runs to the apex and comes
        // back to it. Positions, never commands.
        const bases = shape.roots.map((d) => {
          const points = pathPoints(d);
          return { left: points[0].x, right: points[points.length - 1].x };
        });
        for (const base of bases) {
          expect(base.left).toBeGreaterThanOrEqual(centre - shape.neckHalf - 0.01);
          expect(base.right).toBeLessThanOrEqual(centre + shape.neckHalf + 0.01);
        }
        // And together they span the whole cervix, so the crown's own base line
        // and the roots' draw as one CEJ rather than as a step.
        expect(Math.min(...bases.map((b) => b.left))).toBeCloseTo(centre - shape.neckHalf, 2);
        expect(Math.max(...bases.map((b) => b.right))).toBeCloseTo(centre + shape.neckHalf, 2);
      }
    }
  });

  it("partitions the neck between roots rather than overlapping them", () => {
    for (const row of ROWS) {
      for (const fdi of row.teeth) {
        const shape = toothShape(fdi);
        const bases = shape.roots.map((d) => {
          const points = pathPoints(d);
          return { left: points[0].x, right: points[points.length - 1].x };
        });
        for (let i = 1; i < bases.length; i += 1) {
          // Touching, not overlapping: one shared boundary, no crossing outlines.
          expect(bases[i].left).toBeCloseTo(bases[i - 1].right, 2);
        }
        // Apices stay in the same left-to-right order as the bases they grow
        // from, which is the other half of "these two roots cannot cross".
        const apexXs = shape.apices.map((a) => a.x);
        for (let i = 1; i < apexXs.length; i += 1) {
          expect(apexXs[i]).toBeGreaterThan(apexXs[i - 1]);
        }
      }
    }
  });

  it("puts one apex per root, and reports them mirrored with the arch", () => {
    for (const row of ROWS) {
      for (const fdi of row.teeth) {
        const shape = toothShape(fdi);
        expect(shape.apices).toHaveLength(shape.rootCount);
        for (const apex of shape.apices) {
          if (shape.upper) expect(apex.y).toBeLessThan(shape.cervixY);
          else expect(apex.y).toBeGreaterThan(shape.cervixY);
        }
      }
    }
  });

  it("keeps the root tips inside a diagram-tight flare", () => {
    // The companion to the deciduous-versus-permanent test above, and the reason
    // the splay numbers came down: that one only fixes the ORDER of two flares, so
    // it passed just as happily when every flare was half again as wide and a molar
    // read as three prongs rather than one form. This one puts a ceiling on all of
    // them. 1.0 means the tips may spread as wide as the cervix they grow from and
    // no wider, which is the difference between a root that leans and a root that
    // has been thrown outward to make room for white space.
    for (const row of ROWS) {
      for (const fdi of row.teeth) {
        const shape = toothShape(fdi);
        const xs = shape.apices.map((a) => a.x);
        const flare = (Math.max(...xs) - Math.min(...xs)) / (shape.neckHalf * 2);
        expect({ fdi, tight: flare <= 1 }).toEqual({ fdi, tight: true });
      }
    }
  });

  // =========================================================================
  // THE DIAGRAM PASS: ROUNDED APICES, A SHARED TRUNK, AND NO SCALLOP.
  //
  // Every assertion in this block exists because the thing it pins was WRONG on
  // screen while this file was entirely green — the shape was anatomically true
  // and read as a row of thorns. These are deliberately statements about the
  // drawing rather than about anatomy, because "reads as a tooth at a metre" is
  // the requirement that the anatomy is in service of.
  // =========================================================================
  describe("the silhouette is a diagram, not an illustration", () => {
    /** The apex point of root `i`, and the two path points either side of it. */
    function apexNeighbours(shape: ReturnType<typeof toothShape>, i: number) {
      const points = pathPoints(shape.roots[i]);
      const apex = shape.apices[i];
      const at = points.findIndex(
        (p) => Math.abs(p.x - apex.x) < 0.005 && Math.abs(p.y - apex.y) < 0.005,
      );
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(points.length - 1);
      return { before: points[at - 1], apex: points[at], after: points[at + 1] };
    }

    it("rounds every root apex rather than bringing it to a corner", () => {
      // A corner is what you get when two curves meet at a point with tangents
      // that disagree, and that is exactly what the previous shape did: the
      // control point either side of the tip sat well BELOW it, so however gently
      // the flanks tapered the last unit of every root was a spike. A tip is
      // genuinely rounded when both curves arrive along the SAME line — here
      // horizontally, one control either side at the tip's own height — and the
      // radius between them is real rather than a rounding error.
      for (const row of ROWS) {
        for (const fdi of row.teeth) {
          const shape = toothShape(fdi);
          expect(shape.apexRadius).toBeGreaterThan(0);
          for (let i = 0; i < shape.rootCount; i += 1) {
            const { before, apex, after } = apexNeighbours(shape, i);
            // Collinear tangents: no crease at the tip, on either arch.
            expect(before.y).toBeCloseTo(apex.y, 3);
            expect(after.y).toBeCloseTo(apex.y, 3);
            // A radius, one either side, and the same one the shape reports.
            // Two decimals, not three: every coordinate in a `d` is rounded to
            // three on the way out, so a difference of two of them carries twice
            // that rounding and an exact-to-three assertion would fail on nothing.
            expect(apex.x - before.x).toBeCloseTo(shape.apexRadius, 2);
            expect(after.x - apex.x).toBeCloseTo(shape.apexRadius, 2);
            // And a radius worth the name: at least a third of the root's own
            // half-width, so the dome is a dome and not a chamfered point.
            const points = pathPoints(shape.roots[i]);
            const baseHalf = (points[points.length - 1].x - points[0].x) / 2;
            expect(shape.apexRadius).toBeGreaterThan(baseHalf * 0.33);
          }
        }
      }
    });

    it("holds every root at full width up a shared trunk before they divide", () => {
      // The roots used to fork AT the cervix — a gap from the first unit above the
      // neck — which is what made a molar three spikes on a base. The trunk is now
      // a straight segment, and these assert the three things that make it one:
      // it is a real fraction of the root's run, the path actually holds full base
      // width along it, and adjacent roots are coincident there rather than merely
      // touching at a single point.
      for (const row of ROWS) {
        for (const fdi of row.teeth) {
          const shape = toothShape(fdi);
          const run = Math.abs(shape.apexY - shape.cervixY);
          const trunk = Math.abs(shape.trunkY - shape.cervixY);
          expect({ fdi, long: trunk >= run * 0.45 }).toEqual({ fdi, long: true });
          // On the apex side of the cervix, and short of the apex itself: a trunk
          // that ran past the tips would be a rectangle, not a root block.
          if (shape.upper) {
            expect(shape.trunkY).toBeLessThan(shape.cervixY);
            expect(shape.trunkY).toBeGreaterThan(shape.apexY);
          } else {
            expect(shape.trunkY).toBeGreaterThan(shape.cervixY);
            expect(shape.trunkY).toBeLessThan(shape.apexY);
          }

          const flanks = shape.roots.map((d) => {
            const points = pathPoints(d);
            return { left: points[1], right: points[points.length - 2] };
          });
          for (let i = 0; i < flanks.length; i += 1) {
            const base = pathPoints(shape.roots[i]);
            // Straight-sided: the trunk's corners sit directly above the base's,
            // at exactly the height the shape reports.
            expect(flanks[i].left.x).toBeCloseTo(base[0].x, 3);
            expect(flanks[i].right.x).toBeCloseTo(base[base.length - 1].x, 3);
            expect(flanks[i].left.y).toBeCloseTo(shape.trunkY, 3);
            expect(flanks[i].right.y).toBeCloseTo(shape.trunkY, 3);
            // Coincident with the neighbour all the way up the trunk, so what
            // divides two roots is a groove above it and no gap at all below.
            if (i > 0) expect(flanks[i].left.x).toBeCloseTo(flanks[i - 1].right.x, 3);
          }
        }
      }
    });

    // =======================================================================
    // THE PROPORTION PASS: A CROWN THAT CARRIES THE GLYPH, AND LOBES THAT TAPER.
    //
    // Same story as the block above, one iteration on. Softening the spikes into
    // lobes left two things wrong that every assertion in this file was blind to,
    // because none of them ever compares the crown against the root or looks at
    // how wide a lobe is PARTWAY along itself:
    //
    //   - the roots took about 60% of each glyph's height, so the tooth read as
    //     three fingers standing on a block rather than as a tooth. Dentally's is
    //     the other way round.
    //   - the lobes ran near-PARALLEL and stopped at a dome, like mittens, because
    //     the flank's control point sat at the lobe's own full base width. A cubic
    //     whose first two controls are equal leaves its start flat, so that was not
    //     a taper that came out slightly weak — it was a guaranteed parallel run.
    //
    // Both are statements about the DRAWING, and both are measured off the emitted
    // path rather than off the constants that produced it, so re-tuning a constant
    // cannot quietly satisfy them.
    // =======================================================================

    /**
     * The width of one lobe as a function of height, read off the path.
     *
     * A root subpath is exactly nine points: base-left, trunk-left, flank-left,
     * apex-left-control, apex, apex-right-control, flank-right, trunk-right,
     * base-right. The two flanks are the mirrored halves of one outline, so
     * sampling the left cubic forward and the right cubic backward at the same
     * parameter gives the two sides of the lobe at one height.
     */
    function lobeWidths(shape: ReturnType<typeof toothShape>, i: number) {
      const p = pathPoints(shape.roots[i]);
      expect(p).toHaveLength(9);
      const cubic = (a: number, b: number, c: number, d: number, t: number) => {
        const s = 1 - t;
        return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
      };
      const samples: { height: number; width: number }[] = [];
      const STEPS = 400;
      for (let k = 0; k <= STEPS; k += 1) {
        const t = k / STEPS;
        samples.push({
          // Canonical: distance travelled from the trunk's top toward the apex,
          // so one reading serves both arches and a mirror bug cannot hide here.
          height: Math.abs(cubic(p[1].y, p[2].y, p[3].y, p[4].y, t) - p[1].y),
          width:
            cubic(p[7].x, p[6].x, p[5].x, p[4].x, t) - cubic(p[1].x, p[2].x, p[3].x, p[4].x, t),
        });
      }
      const freeRun = Math.abs(p[4].y - p[1].y);
      const at = (fraction: number) =>
        samples.reduce((best, s) =>
          Math.abs(s.height - freeRun * fraction) < Math.abs(best.height - freeRun * fraction)
            ? s
            : best,
        ).width;
      return { samples, baseWidth: p[8].x - p[0].x, freeRun, at };
    }

    it("narrows every lobe monotonically from its base to its apex", () => {
      for (const row of ROWS) {
        for (const fdi of row.teeth) {
          const shape = toothShape(fdi);
          for (let i = 0; i < shape.rootCount; i += 1) {
            const { samples, baseWidth } = lobeWidths(shape, i);
            // It leaves the trunk at exactly the base width — the taper is applied
            // ALONG the lobe and must never narrow the base, which partitions the
            // cervix and is pinned by two tests above.
            expect(samples[0].width).toBeCloseTo(baseWidth, 2);
            for (let k = 1; k < samples.length; k += 1) {
              // Never wider than it was lower down: no belly, no waist, no bulge
              // back out under the dome.
              expect({
                fdi,
                i,
                k,
                narrowing: samples[k].width <= samples[k - 1].width + 1e-6,
              }).toEqual({ fdi, i, k, narrowing: true });
            }
            expect(samples[samples.length - 1].width).toBeLessThan(baseWidth * 0.01);
          }
        }
      }
    });

    it("tapers along the lobe rather than running parallel to a mitten's end", () => {
      // THE ONE THAT HAD TO BITE, and monotonicity alone does not: the OLD shape
      // was already monotone — it ran flat and then fell off a cliff at the dome,
      // which is non-increasing and is exactly the mitten. What separates a taper
      // from a mitten is WHERE the width is lost, so these two read the width at
      // two heights up the lobe's free run and require it to have gone by then.
      //
      // Measured on the shape this replaces: 96–99% of base width a fifth of the
      // way up, and 82–90% at the halfway mark. Both thresholds sit well clear of
      // both the old readings and the new ones, so this fails on the mitten and
      // is not a restatement of today's constants.
      for (const row of ROWS) {
        for (const fdi of row.teeth) {
          const shape = toothShape(fdi);
          for (let i = 0; i < shape.rootCount; i += 1) {
            const lobe = lobeWidths(shape, i);
            const fifth = lobe.at(0.2) / lobe.baseWidth;
            const half = lobe.at(0.5) / lobe.baseWidth;
            expect({ fdi, i, fifth: fifth <= 0.9, half: half <= 0.72 }).toEqual({
              fdi,
              i,
              fifth: true,
              half: true,
            });
            // And it is a TAPER, not an amputation. This floor was 0.4 for one
            // draft and it let a mutation through: LOBE_TAPER 0.2 with 0.35 domes
            // measured 0.42 here, cleared the existing apex-radius floor by a hair,
            // and is a thorn — the exact shape the pass before last removed. Half
            // the base width at the halfway mark is the line between a root that
            // narrows and a root that has been sharpened.
            expect({ fdi, i, soft: half >= 0.5 }).toEqual({ fdi, i, soft: true });
          }
        }
      }
    });

    // =======================================================================
    // THE OUTER EDGE OF A LEANING LOBE IS ONE CLEAN LINE.
    //
    // ADDED BY THE VERIFICATION PASS, because the taper block above does not
    // reach this and neither does anything else in the file. Every width
    // assertion here is a DIFFERENCE between the two flanks, and a lobe that
    // leans carries the same lean on both, so it cancels: a flank narrowed
    // about the root's BASE rather than about its own spine draws a visible
    // dent into the outer edge — in and then back out again — while every
    // width reading, every partition assertion and every apex check stays
    // exactly as it is. Measured on the shape this pass replaced with the
    // control put back on baseCentre: the outer edge of a primary upper
    // molar's mesial root went inboard and then 0.332 units back out, six
    // times today's residue, and all thirty-five assertions passed.
    //
    // So this reads each flank on its own, walking trunk to apex, and asks
    // one question: having gone outboard, does the outline ever come back?
    // A lobe that leans, tapers and domes is monotone outward-then-inward on
    // each flank; only a mis-centred control puts a kink in it.
    //
    // NOT ZERO. A primary molar's splay is the widest in the mouth (1.12 x 1.2)
    // and its dome cannot be tucked entirely inside that lean, so a trace
    // survives at 0.37% of the base width — well under a pixel at any column
    // this chart draws. One percent separates that from the mis-centred
    // version cleanly and leaves no room for it to creep back.
    // =======================================================================
    it("keeps the outer edge of a leaning lobe one clean line, with no notch", () => {
      const cubic = (a: number, b: number, c: number, d: number, t: number) => {
        const s = 1 - t;
        return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
      };
      for (const row of ROWS) {
        for (const fdi of row.teeth) {
          const shape = toothShape(fdi);
          for (let i = 0; i < shape.rootCount; i += 1) {
            const p = pathPoints(shape.roots[i]);
            expect(p).toHaveLength(9);
            const baseWidth = p[8].x - p[0].x;
            // Both flanks, always walked from the trunk toward the apex, and
            // each measured in its OWN outward direction.
            const flanks: { name: string; xs: number[]; sign: number }[] = [
              { name: "left", xs: [], sign: -1 },
              { name: "right", xs: [], sign: 1 },
            ];
            for (let k = 0; k <= 600; k += 1) {
              const t = k / 600;
              flanks[0].xs.push(cubic(p[1].x, p[2].x, p[3].x, p[4].x, t));
              flanks[1].xs.push(cubic(p[7].x, p[6].x, p[5].x, p[4].x, t));
            }
            for (const flank of flanks) {
              const outward = flank.xs.map((x) => x * flank.sign);
              let furthestIn = outward[0];
              let excursion = 0;
              for (let k = 1; k < outward.length; k += 1) {
                furthestIn = Math.min(furthestIn, outward[k]);
                excursion = Math.max(excursion, outward[k] - furthestIn);
              }
              expect({
                fdi,
                i,
                flank: flank.name,
                clean: excursion <= baseWidth * 0.01,
              }).toEqual({ fdi, i, flank: flank.name, clean: true });
            }
          }
        }
      }
    });

    it("draws the biting edge flat, with no scallop on any tooth", () => {
      // THE ONE THAT HAD TO BITE. A scalloped edge — a peak per cusp with a valley
      // back up to the shoulder between each pair — is unimodal nowhere and flat
      // nowhere, so both halves of this catch it, and the canine's single POINTED
      // cusp (one peak, technically unimodal) is caught by the flat run alone.
      // Cusp COUNT is untouched and still asserted above: this is about what is
      // drawn, not about what is known.
      for (const row of ROWS) {
        for (const fdi of row.teeth) {
          const shape = toothShape(fdi);
          expect(shape.crown).not.toContain("Q");
          // Canonical: rising toward the biting edge on both arches, so one test
          // reads both and a mirror bug cannot hide inside it.
          const points = pathPoints(shape.crown).map((p) => ({
            x: p.x,
            y: shape.upper ? p.y : SHAPE_VIEW.h - p.y,
          }));

          // Out to the edge and back, and never back out again: one turn only.
          let turns = 0;
          let direction = 0;
          for (let i = 1; i < points.length; i += 1) {
            const step = Math.sign(Math.round((points[i].y - points[i - 1].y) * 1000));
            if (step === 0) continue;
            if (direction !== 0 && step !== direction) turns += 1;
            direction = step;
          }
          expect({ fdi, turns }).toEqual({ fdi, turns: 1 });

          // And the edge itself is ONE unbroken flat run, not a row of peaks: the
          // occlusal-most points are consecutive along the path, and they span a
          // real width rather than meeting at a single high point.
          const edgeY = Math.max(...points.map((p) => p.y));
          const onEdge = points
            .map((p, i) => ({ ...p, i }))
            .filter((p) => Math.abs(p.y - edgeY) < 0.005);
          expect(onEdge.length).toBeGreaterThan(1);
          expect(onEdge[onEdge.length - 1].i - onEdge[0].i).toBe(onEdge.length - 1);
          const xs = points.map((p) => p.x);
          const crownWidth = Math.max(...xs) - Math.min(...xs);
          const edgeWidth =
            Math.max(...onEdge.map((p) => p.x)) - Math.min(...onEdge.map((p) => p.x));
          expect(edgeWidth).toBeGreaterThan(crownWidth * 0.6);
        }
      }
    });
  });

  it("keeps every tooth inside its own viewBox", () => {
    for (const row of ROWS) {
      for (const fdi of row.teeth) {
        const points = pathPoints(toothShape(fdi).silhouette);
        for (const p of points) {
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.x).toBeLessThanOrEqual(SHAPE_VIEW.w);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeLessThanOrEqual(SHAPE_VIEW.h);
        }
      }
    }
  });
});
