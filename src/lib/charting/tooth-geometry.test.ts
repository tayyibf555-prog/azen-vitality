import { describe, it, expect } from "vitest";
import { PERMANENT_LOWER, PERMANENT_UPPER } from "./fdi";
import { SURFACE_ORDER } from "./surfaces";
import { TOOTH_BOX, archMarkers, crownPath, gridRect, toothPaths } from "./tooth-geometry";

/**
 * The wrong-site safety property, measured in coordinates.
 *
 * Vitest collects only .ts, so geometry written inside tooth.tsx would be
 * geometry no test can reach: a transposed coordinate or a stray
 * flex-row-reverse would mirror the whole mouth with a green suite. This is the
 * same discipline the diary applies to its drag geometry.
 */
const ALL = [...PERMANENT_UPPER, ...PERMANENT_LOWER];

describe("toothPaths", () => {
  it("returns exactly the five surfaces, once each, with real path data", () => {
    for (const fdi of ALL) {
      const paths = toothPaths(fdi);
      expect(paths).toHaveLength(5);
      expect(paths.map((p) => p.surface).sort()).toEqual([...SURFACE_ORDER].sort());
      for (const p of paths) {
        expect(p.d.length).toBeGreaterThan(0);
        expect(p.d).toMatch(/^M/);
        expect(Number.isFinite(p.labelPoint.x)).toBe(true);
        expect(Number.isFinite(p.labelPoint.y)).toBe(true);
      }
    }
  });

  it("keeps every path inside the tooth box", () => {
    for (const fdi of ALL) {
      for (const p of toothPaths(fdi)) {
        const nums = [...p.d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
        for (let i = 0; i < nums.length; i += 2) {
          expect(nums[i]).toBeGreaterThanOrEqual(0);
          expect(nums[i]).toBeLessThanOrEqual(TOOTH_BOX.width);
          expect(nums[i + 1]).toBeGreaterThanOrEqual(0);
          expect(nums[i + 1]).toBeLessThanOrEqual(TOOTH_BOX.height);
        }
      }
    }
  });

  // The midline mirror, asserted in geometry rather than in a comment.
  it("draws mesial to the RIGHT of distal on quadrant 1 and to the LEFT on quadrant 2", () => {
    const q1 = Object.fromEntries(toothPaths(16).map((p) => [p.surface, p.labelPoint]));
    const q2 = Object.fromEntries(toothPaths(26).map((p) => [p.surface, p.labelPoint]));
    expect(q1.mesial.x).toBeGreaterThan(q1.distal.x);
    expect(q2.mesial.x).toBeLessThan(q2.distal.x);
    // And the same on the lower arch, which mirrors on the same axis.
    const q4 = Object.fromEntries(toothPaths(46).map((p) => [p.surface, p.labelPoint]));
    const q3 = Object.fromEntries(toothPaths(36).map((p) => [p.surface, p.labelPoint]));
    expect(q4.mesial.x).toBeGreaterThan(q4.distal.x);
    expect(q3.mesial.x).toBeLessThan(q3.distal.x);
  });

  it("draws buccal on the outer edge: above centre on the upper arch, below it on the lower", () => {
    const upper = toothPaths(16);
    const upperCentre = gridRect(16).y + gridRect(16).height / 2;
    const upperBuccal = upper.find((p) => p.surface === "buccal");
    expect(upperBuccal?.labelPoint.y).toBeLessThan(upperCentre);

    const lower = toothPaths(46);
    const lowerCentre = gridRect(46).y + gridRect(46).height / 2;
    const lowerBuccal = lower.find((p) => p.surface === "buccal");
    expect(lowerBuccal?.labelPoint.y).toBeGreaterThan(lowerCentre);
  });

  it("puts the occlusal label at the centre of the grid on every tooth", () => {
    for (const fdi of ALL) {
      const r = gridRect(fdi);
      const occlusal = toothPaths(fdi).find((p) => p.surface === "occlusal");
      expect(occlusal?.labelPoint.x).toBeCloseTo(r.x + r.width / 2, 6);
      expect(occlusal?.labelPoint.y).toBeCloseTo(r.y + r.height / 2, 6);
    }
  });

  it("puts the crown on the outer side of the grid, so the two rows face each other", () => {
    expect(crownPath(16).length).toBeGreaterThan(0);
    // Upper: the grid sits BELOW the crown. Lower: above it.
    expect(gridRect(16).y).toBeGreaterThan(0);
    expect(gridRect(46).y).toBe(0);
  });
});

describe("archMarkers", () => {
  // Quadrants 1 and 4 lead every row because the chart is drawn as the
  // clinician faces the patient. R on the right-hand end would mirror the mouth.
  it("marks R at the leading end and L at the trailing end of every row", () => {
    for (const dentition of ["permanent", "deciduous", "combined", "base"] as const) {
      for (const row of archMarkers(dentition).rows) {
        expect(row.leadingLabel).toBe("R");
        expect(row.trailingLabel).toBe("L");
        expect(row.teeth.length).toBeGreaterThan(0);
      }
    }
  });

  it("gives the combined chart four rows, upper outermost", () => {
    const rows = archMarkers("combined").rows;
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.arch)).toEqual(["upper", "upper", "lower", "lower"]);
    expect(rows.map((r) => r.dentition)).toEqual([
      "permanent",
      "deciduous",
      "deciduous",
      "permanent",
    ]);
  });

  it("gives a single dentition two rows", () => {
    expect(archMarkers("permanent").rows).toHaveLength(2);
    expect(archMarkers("deciduous").rows).toHaveLength(2);
    expect(archMarkers("deciduous").rows[0].teeth).toHaveLength(10);
  });
});
