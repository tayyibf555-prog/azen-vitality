import { describe, it, expect } from "vitest";
import type { AdLibraryItem } from "@/lib/meta-ads/types";
import {
  longevityFromDays,
  verdictFromScore,
  complianceWatchOuts,
  buildAnalysisPrompt,
  parseModelAnalysis,
  assembleFromModel,
  fallbackAnalysis,
  type ModelAnalysis,
} from "./analysis";

function ad(overrides: Partial<AdLibraryItem> = {}): AdLibraryItem {
  return {
    id: "adlib-test",
    advertiser: "Test Dental",
    location: "Manchester",
    treatment: "Teeth whitening",
    format: "reel",
    objective: "Leads",
    headline: "A brighter smile before your big day",
    primaryText: "Professional whitening, gentler than shop-bought kits. Book a checkup and we will include whitening. Suitability confirmed at your visit.",
    offer: "Whitening included with a checkup",
    hookType: "Outcome-first (event-led)",
    daysRunning: 96,
    estPerformance: "strong",
    aiAnalysis: "n/a",
    complianceFlag: null,
    ...overrides,
  };
}

const validModel: ModelAnalysis = {
  overallScore: 82,
  verdict: "Strong",
  factors: { hook: 85, offerClarity: 80, credibility: 78, callToAction: 75, audienceFit: 80 },
  why: [
    "The hook 'A brighter smile' leads with the outcome",
    "The offer bundles whitening with a checkup, a low-friction reason to act",
    "It has run 96 days, a proven signal",
  ],
  watchOuts: ["Adapt the angle to your own brand"],
};

describe("longevityFromDays (deterministic thresholds)", () => {
  it("is strong at >= 90 days", () => {
    expect(longevityFromDays(90).signal).toBe("strong");
    expect(longevityFromDays(140).signal).toBe("strong");
  });
  it("is promising at 30 to 89 days", () => {
    expect(longevityFromDays(30).signal).toBe("promising");
    expect(longevityFromDays(89).signal).toBe("promising");
  });
  it("is unproven below 30 days", () => {
    expect(longevityFromDays(29).signal).toBe("unproven");
    expect(longevityFromDays(0).signal).toBe("unproven");
  });
  it("labels the running days", () => {
    expect(longevityFromDays(96).label).toBe("Running 96 days");
  });
});

describe("verdictFromScore bands", () => {
  it("maps score to the four verdict words", () => {
    expect(verdictFromScore(80)).toBe("Strong");
    expect(verdictFromScore(79)).toBe("Good");
    expect(verdictFromScore(65)).toBe("Good");
    expect(verdictFromScore(64)).toBe("Average");
    expect(verdictFromScore(45)).toBe("Average");
    expect(verdictFromScore(44)).toBe("Weak");
    expect(verdictFromScore(0)).toBe("Weak");
  });
});

describe("complianceWatchOuts (deterministic GDC/ASA flags)", () => {
  it("flags a TESTIMONIAL ad and cannot-copy under GDC/ASA", () => {
    const out = complianceWatchOuts(ad({ headline: "Hear what our patients say", primaryText: "Real patients share their stories." }));
    expect(out.length).toBeGreaterThan(0);
    expect(out.join(" ")).toMatch(/testimonial/i);
    expect(out.join(" ")).toMatch(/GDC|ASA/);
    expect(out.join(" ")).toMatch(/cannot copy/i);
  });

  it("flags a GUARANTEE", () => {
    const out = complianceWatchOuts(ad({ primaryText: "We guarantee a perfect result every time." }));
    expect(out.join(" ")).toMatch(/guarantee/i);
  });

  it("flags a PAIN-FREE claim", () => {
    const out = complianceWatchOuts(ad({ primaryText: "A completely pain-free treatment." }));
    expect(out.join(" ")).toMatch(/pain-free|pain free/i);
  });

  it("flags a SUPERLATIVE", () => {
    const out = complianceWatchOuts(ad({ headline: "The best dentist in town" }));
    expect(out.join(" ")).toMatch(/superlative|best/i);
  });

  it("raises NOTHING for clean, compliant copy", () => {
    const out = complianceWatchOuts(
      ad({ headline: "Straighten your smile", primaryText: "Clear aligners with a free consultation. Subject to a clinical assessment.", offer: "Free consultation" }),
    );
    expect(out).toEqual([]);
  });

  it("de-duplicates to one flag per category", () => {
    const out = complianceWatchOuts(ad({ headline: "Best best best", primaryText: "The best, the finest, the leading choice." }));
    // superlative appears many times but should surface once
    const superlativeFlags = out.filter((w) => /superlative/i.test(w));
    expect(superlativeFlags.length).toBe(1);
  });
});

describe("buildAnalysisPrompt (grounding)", () => {
  it("shows the model ONLY the allow-listed real attributes", () => {
    const a = ad({ advertiser: "SecretBrand", location: "SecretTown" });
    const { user } = buildAnalysisPrompt(a);
    expect(user).toContain("Teeth whitening");
    expect(user).toContain(a.headline);
    expect(user).toContain(a.offer);
    expect(user).toContain("96 days");
    // Must NOT leak advertiser, location, or the internal performance tag.
    expect(user).not.toContain("SecretBrand");
    expect(user).not.toContain("SecretTown");
    expect(user.toLowerCase()).not.toContain("estperformance");
  });

  it("instructs the model not to score longevity", () => {
    const { system } = buildAnalysisPrompt(ad());
    expect(system.toLowerCase()).toContain("do not score longevity");
  });
});

describe("parseModelAnalysis", () => {
  it("parses a valid reply (even with surrounding prose)", () => {
    const text = `Here you go: ${JSON.stringify(validModel)} hope that helps`;
    const parsed = parseModelAnalysis(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.factors.hook).toBe(85);
  });

  it("returns null when factors are missing", () => {
    expect(parseModelAnalysis(JSON.stringify({ overallScore: 80, why: ["a", "b", "c"] }))).toBeNull();
  });

  it("returns null with fewer than three why bullets", () => {
    expect(parseModelAnalysis(JSON.stringify({ ...validModel, why: ["only one"] }))).toBeNull();
  });

  it("returns null on non-JSON", () => {
    expect(parseModelAnalysis("no json here")).toBeNull();
  });
});

describe("assembleFromModel", () => {
  it("OVERRIDES the longevity factor deterministically (never the model)", () => {
    // A model that tries to score longevity is ignored; days=96 => strong => 90.
    const a = assembleFromModel(ad({ daysRunning: 96 }), validModel, "claude-sonnet-5");
    expect(a.factors.longevitySignal).toBe(90);
    expect(a.longevity.signal).toBe("strong");
  });

  it("derives verdict from the reconciled score so they cannot contradict", () => {
    const a = assembleFromModel(ad(), validModel, "claude-sonnet-5");
    expect(a.verdict).toBe(verdictFromScore(a.overallScore));
  });

  it("clamps out-of-range factor scores to 0..100", () => {
    const wild: ModelAnalysis = { ...validModel, factors: { hook: 999, offerClarity: -20, credibility: 50, callToAction: 50, audienceFit: 50 } };
    const a = assembleFromModel(ad(), wild, "claude-sonnet-5");
    expect(a.factors.hook).toBe(100);
    expect(a.factors.offerClarity).toBe(0);
  });

  it("puts mandatory compliance flags FIRST in watch-outs", () => {
    const a = assembleFromModel(ad({ headline: "Hear what our patients say" }), validModel, "claude-sonnet-5");
    expect(a.watchOuts[0]).toMatch(/testimonial/i);
  });

  it("computes a cost-per-lead range with the mandatory caveat", () => {
    const a = assembleFromModel(ad(), validModel, "claude-sonnet-5");
    expect(a.costPerLead.lowGbp).toBeLessThan(a.costPerLead.highGbp);
    expect(a.costPerLead.caveat).toMatch(/Rough estimate/i);
    expect(a.source).toBe("ai");
  });
});

describe("fallbackAnalysis (Quick read)", () => {
  it("is clearly labelled as a deterministic fallback", () => {
    const a = fallbackAnalysis(ad());
    expect(a.source).toBe("fallback");
    expect(a.model).toBe("deterministic");
  });

  it("produces 3 to 5 grounded why-bullets that reference the ad", () => {
    const a = fallbackAnalysis(ad({ daysRunning: 96 }));
    expect(a.why.length).toBeGreaterThanOrEqual(3);
    expect(a.why.length).toBeLessThanOrEqual(5);
    // At least one bullet references a concrete attribute (days or the offer text).
    expect(a.why.join(" ")).toMatch(/96 days|Whitening included/);
  });

  it("still computes deterministic longevity, verdict and cost-per-lead", () => {
    const a = fallbackAnalysis(ad({ daysRunning: 10 }));
    expect(a.factors.longevitySignal).toBe(35); // unproven
    expect(a.verdict).toBe(verdictFromScore(a.overallScore));
    expect(a.costPerLead.caveat).toMatch(/Rough estimate/i);
  });

  it("still carries mandatory compliance flags in a fallback", () => {
    const a = fallbackAnalysis(ad({ headline: "The best pain-free dentist" }));
    expect(a.watchOuts.join(" ")).toMatch(/pain-free|superlative|best/i);
  });
});
