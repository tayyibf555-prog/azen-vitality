import { describe, it, expect } from "vitest";
import { TREATMENTS } from "@/lib/treatments/catalog";
import {
  CPL_BENCHMARKS,
  DEFAULT_BENCHMARK,
  benchmarkForTreatment,
  estimateCostPerLead,
  formatCostPerLead,
} from "./benchmarks";

const mid = (b: { lowGbp: number; highGbp: number }) => (b.lowGbp + b.highGbp) / 2;

describe("CPL_BENCHMARKS table sanity", () => {
  it("covers EVERY treatment catalogue key", () => {
    for (const t of TREATMENTS) {
      expect(CPL_BENCHMARKS[t.key], `missing benchmark for "${t.key}"`).toBeDefined();
    }
  });

  it("every range is ordered low < high and positive", () => {
    for (const [key, b] of Object.entries(CPL_BENCHMARKS)) {
      expect(b.lowGbp, `${key} low`).toBeGreaterThan(0);
      expect(b.highGbp, `${key} high`).toBeGreaterThan(b.lowGbp);
    }
    expect(DEFAULT_BENCHMARK.highGbp).toBeGreaterThan(DEFAULT_BENCHMARK.lowGbp);
  });

  it("orders cost by treatment value: checkup < whitening < invisalign < implant", () => {
    expect(mid(CPL_BENCHMARKS.checkup)).toBeLessThan(mid(CPL_BENCHMARKS.whitening));
    expect(mid(CPL_BENCHMARKS.whitening)).toBeLessThan(mid(CPL_BENCHMARKS.invisalign));
    expect(mid(CPL_BENCHMARKS.invisalign)).toBeLessThan(mid(CPL_BENCHMARKS.implant));
  });

  it("checkup and hygiene are the cheapest (low tier), implant the dearest", () => {
    expect(CPL_BENCHMARKS.checkup.tier).toBe("low");
    expect(CPL_BENCHMARKS.hygiene.tier).toBe("low");
    expect(CPL_BENCHMARKS.implant.tier).toBe("highest");
  });
});

describe("benchmarkForTreatment", () => {
  it("maps free-text ad treatment labels to the right catalogue benchmark", () => {
    expect(benchmarkForTreatment("Teeth whitening")).toBe(CPL_BENCHMARKS.whitening);
    expect(benchmarkForTreatment("Dental implants")).toBe(CPL_BENCHMARKS.implant);
    expect(benchmarkForTreatment("Invisalign")).toBe(CPL_BENCHMARKS.invisalign);
    expect(benchmarkForTreatment("New patient exam")).toBe(CPL_BENCHMARKS.checkup);
  });

  it("falls back to the neutral default for unknown treatments", () => {
    expect(benchmarkForTreatment("Smile assessment")).toBe(DEFAULT_BENCHMARK);
    expect(benchmarkForTreatment("Emergency dental care")).toBe(DEFAULT_BENCHMARK);
  });
});

describe("estimateCostPerLead (offer-strength adjustment)", () => {
  it("leaves the band unchanged for a middling offer", () => {
    const r = estimateCostPerLead("Teeth whitening", 50);
    expect(r).toEqual({ lowGbp: CPL_BENCHMARKS.whitening.lowGbp, highGbp: CPL_BENCHMARKS.whitening.highGbp });
  });

  it("tightens (pulls the ceiling in) for a strong offer", () => {
    const base = CPL_BENCHMARKS.whitening;
    const r = estimateCostPerLead("Teeth whitening", 85);
    expect(r.highGbp).toBeLessThan(base.highGbp);
    expect(r.lowGbp).toBeLessThan(r.highGbp);
  });

  it("loosens (pushes the ceiling out) for a weak offer", () => {
    const base = CPL_BENCHMARKS.whitening;
    const r = estimateCostPerLead("Teeth whitening", 20);
    expect(r.highGbp).toBeGreaterThan(base.highGbp);
    expect(r.lowGbp).toBeLessThan(r.highGbp);
  });

  it("always returns a genuine range (low < high) across the offer scale", () => {
    for (const treatment of ["Teeth whitening", "Dental implants", "New patient exam", "Smile assessment"]) {
      for (const offer of [0, 33, 34, 66, 67, 100]) {
        const r = estimateCostPerLead(treatment, offer);
        expect(r.lowGbp).toBeLessThan(r.highGbp);
      }
    }
  });

  it("clamps out-of-range offer scores without crashing", () => {
    expect(estimateCostPerLead("Teeth whitening", -50).lowGbp).toBeGreaterThan(0);
    expect(estimateCostPerLead("Teeth whitening", 999).highGbp).toBeGreaterThan(0);
  });
});

describe("formatCostPerLead", () => {
  it("renders a GBP range string", () => {
    expect(formatCostPerLead({ lowGbp: 8, highGbp: 15 })).toBe("£8 to £15 per lead");
  });
});
