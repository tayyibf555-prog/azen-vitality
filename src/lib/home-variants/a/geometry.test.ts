import { describe, expect, it } from "vitest";
import { donutArcs, sharePercent } from "@/lib/home-variants/a/geometry";

const C = 360;

describe("donutArcs", () => {
  it("lays the arcs head to tail", () => {
    const arcs = donutArcs(
      [
        { key: "completed", value: 2 },
        { key: "cancelled", value: 1 },
        { key: "dna", value: 1 },
      ],
      4,
      C,
    );
    expect(arcs).toEqual([
      { key: "completed", length: 180, offset: -0 },
      { key: "cancelled", length: 90, offset: -180 },
      { key: "dna", length: 90, offset: -270 },
    ]);
  });

  it("leaves the unfinished part of the day as bare track", () => {
    const arcs = donutArcs([{ key: "completed", value: 1 }], 4, C);
    expect(arcs[0].length).toBe(90);
  });

  it("draws nothing at all when the total is zero", () => {
    const arcs = donutArcs([{ key: "completed", value: 3 }], 0, C);
    expect(arcs).toEqual([{ key: "completed", length: 0, offset: -0 }]);
  });

  it("cannot overrun the ring when the slices sum past the total", () => {
    const arcs = donutArcs(
      [
        { key: "a", value: 8 },
        { key: "b", value: 8 },
      ],
      10,
      C,
    );
    const drawn = arcs.reduce((sum, arc) => sum + arc.length, 0);
    expect(drawn).toBeLessThanOrEqual(C);
    expect(arcs[1].length).toBe(C - arcs[0].length);
  });

  it("skips a negative or non-finite slice without moving the cursor", () => {
    const arcs = donutArcs(
      [
        { key: "a", value: -5 },
        { key: "b", value: Number.NaN },
        { key: "c", value: 1 },
      ],
      2,
      C,
    );
    expect(arcs[0].length).toBe(0);
    expect(arcs[1].length).toBe(0);
    expect(arcs[2]).toEqual({ key: "c", length: 180, offset: -0 });
  });

  it("handles a non-finite total as undrawable rather than as NaN geometry", () => {
    const arcs = donutArcs([{ key: "a", value: 1 }], Number.NaN, C);
    expect(arcs[0].length).toBe(0);
  });
});

describe("sharePercent", () => {
  it("rounds to a whole percentage", () => {
    expect(sharePercent(1, 3)).toBe(33);
    expect(sharePercent(2, 3)).toBe(67);
    expect(sharePercent(4, 4)).toBe(100);
  });

  it("never prints a real count as nought per cent", () => {
    expect(sharePercent(1, 400)).toBe(1);
  });

  it("is nought for nothing, and for an empty total", () => {
    expect(sharePercent(0, 400)).toBe(0);
    expect(sharePercent(3, 0)).toBe(0);
  });

  it("clamps a value larger than the total", () => {
    expect(sharePercent(5, 4)).toBe(100);
  });
});
