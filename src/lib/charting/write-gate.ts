// ===========================================================================
// THE GATES. Mirrors the shape of isDentallyWriteEnabled() in
// src/lib/dentally/write.ts.
//
// THREE FUNCTIONS, and conflating any two of them is the two-sources-of-truth
// failure DENTALLY.md:79 names as the worst outcome available.
//
// The write-blocked sentence is NOT here: it lives in CHART_COPY in
// src/lib/patient/tabs.ts, so the copy sweep test covers it like every other
// clinical-honesty sentence in the record.
// ===========================================================================

/**
 * FALSE, UNCONDITIONALLY, AND NO ENVIRONMENT VARIABLE CAN MOVE IT.
 *
 * Dentally publishes no create route on any charting resource: POST 404s on
 * treatments, treatment_categories, treatment_plans, treatment_plan_items and
 * treatment_appointments alike. There is nothing to enable. Every control that
 * would write to Dentally renders behind this, with a rendered explanation
 * rather than a title attribute on an unfocusable button.
 */
export function canWriteChartToDentally(): boolean {
  return false;
}

/**
 * Whether this practice plans treatment ON THIS SCREEN, into OUR table.
 *
 * DEFAULTS FALSE. The brief authorises a read-only mirror; a selection layer
 * stored in public.chart_draft is DENTALLY.md's option 2 and creates a real
 * divergence from the first day two people use different systems. That is the
 * practice manager's decision, not this code's, so the reducer, the table, the
 * repository and the route are all built, tested and switched off.
 */
export function isChartDraftEnabled(): boolean {
  return process.env.CHART_DRAFT_ENABLED === "true";
}

/**
 * Whether a draft entry may be persisted. NOT a Dentally concern at all: this
 * writes to public.chart_draft and never to Dentally, which is why it does not
 * consult canWriteChartToDentally().
 */
export function canSaveChartDraft(): boolean {
  return isChartDraftEnabled();
}
