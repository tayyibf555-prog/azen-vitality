// UK dental advertising COST-PER-LEAD benchmarks, per treatment.
//
// This is a hardcoded, published-benchmark-informed reference table. It is NOT a
// promise and NOT derived from this practice's own data. It exists so the creative
// detail view can show a ROUGH, honest RANGE ("£8 to £20 per lead") rather than a
// single invented number. Every value is in GBP, per lead, on Meta (Facebook and
// Instagram) paid social.
//
// SOURCE / basis (indicative, mid-2020s UK dental Meta advertising):
//   Published agency and platform benchmarks put UK dental Facebook/Instagram
//   cost-per-lead broadly in the £8 to £70 band, scaling with treatment value and
//   buyer consideration: high-volume, low-ticket, high-intent local demand
//   (checkups, hygiene) sits at the cheap end; cosmetic and high-ticket work
//   (implants, veneers, aligners) costs more per lead because the audience is
//   smaller and the decision is slower. These figures are deliberately conservative
//   ranges, not precise quotes; real CPL depends on targeting, budget, creative and
//   season. Treat them as a sanity band, never a guarantee.
//
// British English, GBP only, no dash characters.

import { findTreatment } from "@/lib/treatments/catalog";

/** A coarse cost tier, used for ordering and sanity checks. */
export type CplTier = "low" | "mid" | "higher" | "highest";

export interface CplBenchmark {
  /** Lower bound of the typical cost per lead, GBP. */
  lowGbp: number;
  /** Upper bound of the typical cost per lead, GBP. */
  highGbp: number;
  /** Coarse tier (checkup/hygiene low, whitening mid, invisalign higher, implants highest). */
  tier: CplTier;
}

// Keyed by the treatments/catalog.ts treatment `key`. EVERY catalogue key must be
// present (a test enforces this) so a known treatment always resolves to a range.
export const CPL_BENCHMARKS: Record<string, CplBenchmark> = {
  // Low: routine, high-intent, high-volume local demand. Cheapest leads.
  checkup: { lowGbp: 8, highGbp: 20, tier: "low" },
  hygiene: { lowGbp: 8, highGbp: 22, tier: "low" },

  // Mid: considered cosmetic work at an accessible price point.
  whitening: { lowGbp: 10, highGbp: 28, tier: "mid" },
  bonding: { lowGbp: 12, highGbp: 34, tier: "mid" },
  // Root canal leads are typically pain/emergency-driven (higher intent) but the
  // category is not a big paid-social spender, so a mid band is realistic.
  root_canal: { lowGbp: 12, highGbp: 34, tier: "mid" },

  // Higher: high-ticket, slower-consideration treatments with a narrower audience.
  invisalign: { lowGbp: 18, highGbp: 46, tier: "higher" },
  veneers: { lowGbp: 20, highGbp: 55, tier: "higher" },

  // Highest: premium, high-value, longest consideration cycle.
  implant: { lowGbp: 25, highGbp: 70, tier: "highest" },
};

// Fallback for ad treatments that do not map to a catalogue key (for example
// "Smile assessment", "General dentistry", "Emergency dental care"). A neutral
// mid band so the cost-per-lead line ALWAYS renders, never blank.
export const DEFAULT_BENCHMARK: CplBenchmark = { lowGbp: 12, highGbp: 40, tier: "mid" };

/**
 * Resolve a free-text ad treatment label (for example "Teeth whitening", "Dental
 * implants", "New patient exam") to a benchmark. Uses the treatment catalogue's
 * tolerant matcher; falls back to the neutral default when the label is not a
 * known treatment. Never returns null.
 */
export function benchmarkForTreatment(treatmentLabel: string): CplBenchmark {
  const t = findTreatment(treatmentLabel);
  if (t && CPL_BENCHMARKS[t.key]) return CPL_BENCHMARKS[t.key];
  return DEFAULT_BENCHMARK;
}

export interface CostPerLeadRange {
  lowGbp: number;
  highGbp: number;
}

/** The fixed caveat line. NEVER present a cost-per-lead figure without it. */
export const COST_PER_LEAD_CAVEAT =
  "Rough estimate from UK dental advertising benchmarks. Actual results depend on targeting, budget and season.";

/**
 * Estimate a cost-per-lead RANGE for a treatment, nudged ONE STEP tighter or looser
 * by the offer-strength factor score (0 to 100):
 *
 *   - A strong offer (>= 67) tends to convert more predictably and cheaply, so the
 *     band is shifted tighter: the upper bound is pulled in towards the lower bound.
 *   - A weak offer (< 34) is less reliable, so the band is loosened: the upper bound
 *     is pushed out (leads can cost more).
 *   - A middling offer leaves the published band unchanged.
 *
 * Always returns whole GBP with low < high. This is a RANGE by construction: it is
 * never a single number and never a promise (see COST_PER_LEAD_CAVEAT).
 */
export function estimateCostPerLead(treatmentLabel: string, offerStrength: number): CostPerLeadRange {
  const base = benchmarkForTreatment(treatmentLabel);
  const clampedOffer = Math.min(100, Math.max(0, offerStrength));

  let low = base.lowGbp;
  let high = base.highGbp;

  if (clampedOffer >= 67) {
    // Strong offer: one step tighter. Pull the ceiling in towards the floor.
    high = Math.round(low + (high - low) * 0.7);
  } else if (clampedOffer < 34) {
    // Weak offer: one step looser. Push the ceiling out.
    high = Math.round(high * 1.25);
  }

  low = Math.round(low);
  high = Math.round(high);
  // Guarantee a genuine range even after rounding/adjustment.
  if (high <= low) high = low + 3;

  return { lowGbp: low, highGbp: high };
}

/** Human-readable range, for example "£8 to £15 per lead". */
export function formatCostPerLead(range: CostPerLeadRange): string {
  return `£${range.lowGbp} to £${range.highGbp} per lead`;
}
