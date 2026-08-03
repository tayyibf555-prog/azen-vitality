// ---------------------------------------------------------------------------
// What was actually measured, on what date, over how many rows — and which claim
// each measurement licenses.
//
// Every number here came from READ-ONLY GETs against api.dentally.co on
// 2026-08-03, against the live 51k-patient account. Nothing in this repo
// re-verifies them: they are a dated snapshot of a supplier's API, and they go
// stale. The component reads these constants; it does not restate them, so there
// is exactly one place to correct when the API is re-probed.
//
// THE DISTINCTION THIS FILE ENFORCES: the constants describe the METHOD. The run
// describes the RUN. `attributedShare()` and `runChainRate()` in
// allocation-report.ts are the figures the screen shows for the period in front
// of the user; these are the figures that say how the method was validated.
//
// Pure data and pure predicates: no I/O, no clock reads.
// ---------------------------------------------------------------------------

/** The date every measurement below was taken. */
export const CALIBRATED_ON = "2026-08-03";

/** Payments examined: the 60 days to CALIBRATED_ON, all sites. */
export const SAMPLE_PAYMENTS = 2052;

/** Distinct invoices fetched while walking the chain. */
export const SAMPLE_INVOICES = 235;

/** Explanation legs walked, and how many reached invoice lines. 256/258 = 99.2%. */
export const CHAIN_HIT_LEGS = 256;
export const CHAIN_TOTAL_LEGS = 258;
export const CHAIN_HIT_RATE = CHAIN_HIT_LEGS / CHAIN_TOTAL_LEGS;

/** Of the legs that reached an invoice, how many had a clinician on every line. */
export const PRACTITIONER_COVERAGE_LEGS = 256;
export const PRACTITIONER_COVERAGE_TOTAL = 256;
export const PRACTITIONER_COVERAGE = PRACTITIONER_COVERAGE_LEGS / PRACTITIONER_COVERAGE_TOTAL;

/** Legs where the person who took the payment is not on the invoice at all. */
export const PAYMENT_VS_INVOICE_DISAGREEMENT_LEGS = 17;
export const PAYMENT_VS_INVOICE_DISAGREEMENT_TOTAL = 242;
export const PAYMENT_VS_INVOICE_DISAGREEMENT =
  PAYMENT_VS_INVOICE_DISAGREEMENT_LEGS / PAYMENT_VS_INVOICE_DISAGREEMENT_TOTAL;

/**
 * The share of money the practice received in the 60 days to CALIBRATED_ON that is
 * not allocated to anything inside Dentally. NOT an API gap — a data-entry
 * reality, and the hard ceiling on what any report can attribute.
 */
export const MONEY_UNALLOCATED_IN_DENTALLY = 0.2063;

/** Share of money sitting on invoices with more than one clinician (2.0% of legs). */
export const MONEY_ON_MULTI_PRACTITIONER_INVOICES = 0.112;

/** Sundry lines seen across the sampled invoices. Zero: an untested path. */
export const SUNDRY_LINES_SEEN = 0;

/**
 * A run may only say "attributed to the treating clinician" when its OWN chain
 * rate clears this floor. Below it, too much of the period is unresolved for the
 * clinician totals to be described that way.
 */
export const RUN_CHAIN_RATE_FLOOR = 0.95;

/**
 * The gate on the strongest claim the report is allowed to make. Requires both:
 * the method's measured line-level practitioner coverage was complete, AND this
 * run resolved at least RUN_CHAIN_RATE_FLOOR of its own legs.
 *
 * `runRate` is null when the run had no legs at all, which licenses nothing.
 */
export function mayClaimTreatingClinician(runRate: number | null): boolean {
  if (runRate === null) return false;
  return PRACTITIONER_COVERAGE >= 1 && runRate >= RUN_CHAIN_RATE_FLOOR;
}

/**
 * Claims this report may NEVER make, and the measurement that forbids each. Kept
 * as data so a test can assert the list has not quietly shrunk.
 */
export const FORBIDDEN_CLAIMS: readonly { claim: string; because: string }[] = [
  {
    claim: "this is what the dentist is owed / payable / approved",
    because: `Dentally exposes no "closed" field on a course of treatment (probed ${CALIBRATED_ON}), and ${(MONEY_UNALLOCATED_IN_DENTALLY * 100).toFixed(1)}% of the money received is not allocated in Dentally at all.`,
  },
  {
    claim: "an NHS versus private split",
    because: `invoice.nhs_amount was null on ${PRACTITIONER_COVERAGE_TOTAL}/${PRACTITIONER_COVERAGE_TOTAL} sampled invoices and item nhs_charge was 0 on 728/728 sampled lines.`,
  },
  {
    claim: "sundries are included",
    because: `${SUNDRY_LINES_SEEN}/${SAMPLE_INVOICES} sampled invoices carried a sundry line, so the path is untested; sundry lines are counted and surfaced instead.`,
  },
];

/** One run of text in the banner. `emphasis` is presentation, not content. */
export interface BannerSegment {
  text: string;
  emphasis?: "strong" | "em" | "code";
}

/**
 * The header banner. ALWAYS ON, NOT DISMISSIBLE. It is the sentence that stops
 * this screen being mistaken for the pay run, and the two things it names —
 * a fifth of the money unallocated, and no readable "closed" — are the reasons
 * this cannot become that report without a human answer first.
 */
export const CALIBRATION_BANNER_SEGMENTS: readonly BannerSegment[] = [
  { text: "Calibration preview — not the pay run.", emphasis: "strong" },
  {
    text: " Attribution was measured against live Dentally on 3 August 2026 across 2,052 payments and 235 invoices: the payment → invoice → clinician chain resolved for 99.2% of allocations, and every invoice line carried a clinician. Two things it still cannot do. ",
  },
  {
    text: "20.6% of the money the practice took in the last 60 days is not allocated to anything in Dentally itself",
    emphasis: "strong",
  },
  { text: " — no report can attribute it. And " },
  { text: 'Dentally’s API exposes no "closed" field', emphasis: "strong" },
  { text: " on a course of treatment (" },
  { text: "treatment_plans", emphasis: "code" },
  { text: " carries " },
  { text: "completed", emphasis: "code" },
  { text: ", " },
  { text: "completed_at", emphasis: "code" },
  { text: ", " },
  { text: "end_date", emphasis: "code" },
  {
    text: " and nothing else, probed 3 August 2026), while Dentally’s own reporting distinguishes completed from closed. Until that is answered, these figures are ",
  },
  { text: "money received and attributed", emphasis: "em" },
  { text: ", never " },
  { text: "money owed", emphasis: "em" },
  { text: "." },
];

/** The banner as one string, for asserting the wording has not drifted. */
export const CALIBRATION_BANNER_TEXT = CALIBRATION_BANNER_SEGMENTS.map((s) => s.text).join("");
