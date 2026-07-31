import { describe, expect, it } from "vitest";
import { axisTickLabel, barFraction, niceAxis } from "./chart";

describe("niceAxis", () => {
  it("never puts the axis below the largest value, which would clip the bar", () => {
    for (const v of [1, 99, 863630, 1_000_001, 7_777_777]) {
      expect(niceAxis(v).max).toBeGreaterThanOrEqual(v);
    }
  });

  it("reproduces Dentally's own axis for the observed figure", () => {
    // £8,636.30 invoiced. Dentally draws 0, 2k, 4k, 6k, 8k, 10k.
    const axis = niceAxis(863630);
    expect(axis.ticks.map(axisTickLabel)).toEqual(["0", "2k", "4k", "6k", "8k", "10k"]);
  });

  it("lands on round steps rather than arbitrary ones", () => {
    const axis = niceAxis(370000);
    // 1, 2, 2.5 or 5 times a power of ten, never 74000-style steps.
    const mantissa = axis.step / 10 ** Math.floor(Math.log10(axis.step));
    expect([1, 2, 2.5, 5, 10]).toContain(Math.round(mantissa * 10) / 10);
  });

  it("starts at zero and ends exactly on max, with no floating point drift", () => {
    const axis = niceAxis(249_999);
    expect(axis.ticks[0]).toBe(0);
    expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max);
    expect(axis.ticks.every(Number.isInteger)).toBe(true);
  });

  it("survives a 2.5-style step without drifting off the top tick", () => {
    // 2.5 steps are where repeated addition accumulates error.
    const axis = niceAxis(2_400_000);
    expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.max);
  });

  it("returns a usable axis for zero rather than dividing by zero later", () => {
    const axis = niceAxis(0);
    expect(axis.max).toBeGreaterThan(0);
    expect(axis.ticks.length).toBeGreaterThan(1);
  });

  it("returns a usable axis for a negative or unparseable maximum", () => {
    expect(niceAxis(-500).max).toBeGreaterThan(0);
    expect(niceAxis(Number.NaN).max).toBeGreaterThan(0);
  });

  it("gives roughly the requested number of intervals", () => {
    const axis = niceAxis(863630, 5);
    expect(axis.ticks.length - 1).toBeGreaterThanOrEqual(3);
    expect(axis.ticks.length - 1).toBeLessThanOrEqual(8);
  });
});

describe("axisTickLabel", () => {
  it("prints zero plainly", () => {
    expect(axisTickLabel(0)).toBe("0");
  });

  it("prints sub-thousands in pounds without abbreviating", () => {
    expect(axisTickLabel(50_000)).toBe("500");
  });

  it("abbreviates whole thousands", () => {
    expect(axisTickLabel(200_000)).toBe("2k");
    expect(axisTickLabel(1_000_000)).toBe("10k");
  });

  it("keeps one decimal when dropping it would misstate the tick", () => {
    expect(axisTickLabel(250_000)).toBe("2.5k");
  });

  it("does not print a pointless 2.0k", () => {
    expect(axisTickLabel(200_000)).not.toContain(".");
  });
});

describe("barFraction", () => {
  it("is the value's share of the axis", () => {
    expect(barFraction(500, 1000)).toBeCloseTo(0.5, 6);
  });

  it("clamps a negative value to nothing rather than drawing it upside down", () => {
    expect(barFraction(-500, 1000)).toBe(0);
  });

  it("never exceeds the axis even if the maximum is stale", () => {
    expect(barFraction(5000, 1000)).toBe(1);
  });

  it("is zero for a zero or invalid axis rather than NaN or Infinity", () => {
    expect(barFraction(500, 0)).toBe(0);
    expect(barFraction(500, Number.NaN)).toBe(0);
  });
});
