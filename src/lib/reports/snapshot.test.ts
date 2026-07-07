import { describe, it, expect } from "vitest";
import { buildSnapshot } from "./snapshot";
import { ROI_SUMMARY } from "@/lib/roi/mock";
import { READINESS } from "@/lib/compliance/mock";

describe("buildSnapshot is deterministic and consistent with the sources", () => {
  it("the monthly snapshot mirrors the 30-day ROI totals", () => {
    const m = buildSnapshot("month");
    expect(m.period).toBe("month");
    expect(m.spendGbp).toBe(Math.round(ROI_SUMMARY.spendGbp));
    expect(m.newPatients).toBe(ROI_SUMMARY.newPatients);
    expect(m.revenueGbp).toBe(Math.round(ROI_SUMMARY.revenueGbp));
    expect(m.returnX).toBeCloseTo(ROI_SUMMARY.returnX, 1);
  });

  it("the weekly snapshot is a scaled-down version of the monthly one", () => {
    const w = buildSnapshot("week");
    const m = buildSnapshot("month");
    expect(w.period).toBe("week");
    expect(w.spendGbp).toBeLessThan(m.spendGbp);
    expect(w.newPatients).toBeLessThan(m.newPatients);
    expect(w.revenueGbp).toBeLessThan(m.revenueGbp);
    // Ratios are scale-invariant, so return on spend is unchanged.
    expect(w.returnX).toBe(m.returnX);
  });

  it("is deterministic: same period in, equal object out", () => {
    expect(buildSnapshot("week")).toEqual(buildSnapshot("week"));
    expect(buildSnapshot("month")).toEqual(buildSnapshot("month"));
  });

  it("carries the compliance position straight from READINESS", () => {
    const m = buildSnapshot("month");
    expect(m.complianceScore).toBe(READINESS.overallScore);
    expect(m.auditsOverdue).toBe(READINESS.auditsOverdue);
  });

  it("only the monthly review carries a trend direction", () => {
    expect(buildSnapshot("week").trendDirection).toBeNull();
    expect(buildSnapshot("month").trendDirection).not.toBeNull();
  });

  it("names a top and a weakest paid channel by return on spend", () => {
    const m = buildSnapshot("month");
    expect(m.topChannel).not.toBeNull();
    expect(m.weakestChannel).not.toBeNull();
    // The best channel cannot have a lower return than the weakest one.
    if (m.topChannel && m.weakestChannel) {
      expect(m.topChannel.roiX).toBeGreaterThanOrEqual(m.weakestChannel.roiX);
    }
  });

  it("defaults to the full practice (share 1) and matches an explicit share of 1", () => {
    expect(buildSnapshot("month")).toEqual(buildSnapshot("month", 1));
    expect(buildSnapshot("week")).toEqual(buildSnapshot("week", 1));
  });

  it("scales the acquisition figures by the share but not compliance", () => {
    const full = buildSnapshot("month");
    const half = buildSnapshot("month", 0.5);
    expect(half.spendGbp).toBeLessThan(full.spendGbp);
    expect(half.newPatients).toBeLessThan(full.newPatients);
    expect(half.revenueGbp).toBeLessThan(full.revenueGbp);
    // Compliance is point-in-time and must NOT be scaled.
    expect(half.complianceScore).toBe(full.complianceScore);
    expect(half.auditsOverdue).toBe(full.auditsOverdue);
    // Return on spend is scale-invariant.
    expect(half.returnX).toBe(full.returnX);
  });
});
