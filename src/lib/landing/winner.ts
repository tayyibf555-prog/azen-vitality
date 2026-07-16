// Auto-promotion decision for a two-variant split test. Pure function, no I/O, so
// it is fully unit-testable and can be reused wherever counters are available (the
// manual promote action, and the scheduled auto-promote wiring that lands at
// integration - see the report).
//
// Rule (from the brief): promote a winner only when BOTH variants have a fair
// sample (>= MIN_VIEWS views each) AND the leader's conversion rate beats the
// other by at least MIN_RELATIVE_LIFT relative. Conversion rate is the LEAD rate
// (leads / views) once there are enough leads to be meaningful, otherwise it falls
// back to the CTA-click rate (a denser, earlier signal) so a promotion is not
// stalled forever by sparse leads.

export type VariantKey = "a" | "b";

export interface VariantCounters {
  views: number;
  ctaClicks: number;
  leads: number;
}

export interface PromotionInputs {
  a: VariantCounters;
  b: VariantCounters;
}

export interface PromotionDecision {
  /** True when a winner should be promoted now. */
  promote: boolean;
  /** The winning variant when promote is true, else null. */
  winner: VariantKey | null;
  /** Which signal the decision used. */
  metric: "lead-rate" | "cta-rate";
  /** Plain-English reason, safe to surface in the UI. */
  reason: string;
}

// Both variants need a fair sample before any call is made.
export const MIN_VIEWS = 100;
// The leader must beat the other by at least this much, relative (25%).
export const MIN_RELATIVE_LIFT = 0.25;
// Below this combined lead count, leads are "sparse" and we judge on CTA rate.
export const SPARSE_LEADS_THRESHOLD = 10;

function rate(numerator: number, views: number): number {
  return views > 0 ? numerator / views : 0;
}

/**
 * Decide whether to auto-promote a winner. Deterministic and side-effect free.
 * Returns promote:false with a reason whenever the sample is too small, the race
 * is too close, or the leader's rate is zero.
 */
export function decideAutoPromotion({ a, b }: PromotionInputs): PromotionDecision {
  // 1. Fair-sample gate: both variants need enough views.
  if (a.views < MIN_VIEWS || b.views < MIN_VIEWS) {
    return {
      promote: false,
      winner: null,
      metric: "lead-rate",
      reason: `Both variants need at least ${MIN_VIEWS} views before a winner can be called.`,
    };
  }

  // 2. Choose the signal: lead rate when leads are plentiful, else CTA rate.
  const totalLeads = a.leads + b.leads;
  const useLeads = totalLeads >= SPARSE_LEADS_THRESHOLD;
  const metric: PromotionDecision["metric"] = useLeads ? "lead-rate" : "cta-rate";
  const aRate = useLeads ? rate(a.leads, a.views) : rate(a.ctaClicks, a.views);
  const bRate = useLeads ? rate(b.leads, b.views) : rate(b.ctaClicks, b.views);

  const leaderRate = Math.max(aRate, bRate);
  const otherRate = Math.min(aRate, bRate);
  const winner: VariantKey = aRate >= bRate ? "a" : "b";

  // 3. A zero-rate leader is no winner (nothing is converting on either side).
  if (leaderRate <= 0) {
    return {
      promote: false,
      winner: null,
      metric,
      reason: "Neither variant has converted yet, so there is no winner to promote.",
    };
  }

  // 4. Relative-lift gate: leader must beat the other by >= 25% relative.
  //    Guard the divide-by-zero case (other is zero) as a clear win.
  const relativeLift = otherRate <= 0 ? Infinity : (leaderRate - otherRate) / otherRate;
  if (relativeLift < MIN_RELATIVE_LIFT) {
    return {
      promote: false,
      winner: null,
      metric,
      reason: "The two variants are performing too closely to call a winner yet.",
    };
  }

  const pct = relativeLift === Infinity ? "clearly" : `${Math.round(relativeLift * 100)}% higher`;
  const signal = useLeads ? "lead rate" : "click-through rate";
  return {
    promote: true,
    winner,
    metric,
    reason: `Variant ${winner.toUpperCase()} is winning on ${signal} (${pct}) with a fair sample on both.`,
  };
}
