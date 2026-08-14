// ---------------------------------------------------------------------------
// REPORT C — what was actually measured on /v1/treatment_plan_items, on what
// date, over how many rows, and which claim each measurement licenses.
//
// This mirrors allocation-calibration.ts exactly: the constants describe the
// METHOD (how the clinical completed/pending signal was probed), not any one run.
// The component reads these; it does not restate them, so there is one place to
// correct when the endpoint is re-probed.
//
// EVERY NUMBER below came from READ-ONLY GETs against api.dentally.co on
// 2026-08-14, on the live 51k-patient account, with the read-only key and the
// Azen-Vitality User-Agent. Nothing in this repo re-verifies them at runtime;
// they are a dated snapshot of a supplier's API and they go stale.
//
// Pure data and pure predicates: no I/O, no clock reads.
// ---------------------------------------------------------------------------

/** The date every measurement below was taken. */
export const CALIBRATED_ON = "2026-08-14";

/** Base /v1/treatment_plan_items total (meta.total IS exposed). Grows continuously. */
export const BASE_ITEM_TOTAL = 998_894;

/** A 30-day whole-group slice, `updated_since=2026-07-15`. The scan superset. */
export const SLICE_30D_TOTAL = 28_532;

/** Rows sampled when characterising the population (the recent window). */
export const POPULATION_SAMPLE = 300;

/** Of POPULATION_SAMPLE rows, how many carried each field. */
export const COMPLETED_PRESENT = 300; // `completed` boolean, 282 true / 18 false
export const COMPLETED_AT_PRESENT = 283; // 94.3%
export const PRACTITIONER_PRESENT = 300;
export const PATIENT_PRESENT = 300;
export const UDA_BAND_PRESENT = 108; // 36% — the rest are private/non-NHS
export const PLAN_ID_PRESENT = 115; // 38.3% overall
export const SITE_ID_PRESENT = 0; // there is NO site_id on the item

/** Banded (NHS) subset, sampled over 400 window rows. */
export const BANDED_SAMPLE = 400;
export const BANDED_COUNT = 128; // 32% of window rows are banded
/** Of banded items, the share carrying a treatment_plan_id (so groupable into a course). */
export const BANDED_WITH_PLAN_ID = 0.898; // 89.8%
/** The complement: banded items with NO plan id — the reason course counts are a FLOOR. */
export const BANDED_WITHOUT_PLAN_ID = 0.102; // 10.2%

/**
 * THE PRACTITIONER-FILTER REGRESSION NOTE — the load-bearing volatility.
 *
 * On 2026-08-03 the client.ts filter table recorded `practitioner_id` on this
 * endpoint as HTTP 500. On 2026-08-14 it WORKS: a real id returned a matching
 * total (193101 → 32,810, every sampled row matching), a bogus id returned 0, and
 * it COMPOSES with `updated_since` (193101 + updated_since=2026-07-15 → 2,168,
 * 0.2s). Either Dentally fixed it or 08-03 was transient. It is treated as
 * VOLATILE: the read path re-probes it at run time and falls back to a
 * whole-group slice filtered to the site roster if it 500s again.
 */
export const PRACTITIONER_FILTER_REGRESSED_ON = "2026-08-03";
export const PRACTITIONER_FILTER_WORKING_ON = "2026-08-14";
export const PRACTITIONER_FILTER_SAMPLE_TOTAL = 32_810; // id 193101, whole history
export const PRACTITIONER_FILTER_WINDOW_TOTAL = 2_168; // id 193101 + updated_since=2026-07-15

/**
 * THE DATE-BASIS ASYMMETRY (the key gotcha, isolated in
 * nhs-clinical-activity.ts#clinicalWindowDay). Completed items window on
 * `completed_at` (== `updated_at` the same day, 198/198 sampled). Pending items
 * have NO completion date (`completed_at` on 1/18 pending banded items) so they
 * window on `created_at` — "when the work was planned / the patient was seen".
 */
export const COMPLETED_AT_EQ_UPDATED_AT = "198/198 sampled completed items";
export const PENDING_HAS_COMPLETED_AT = "1/18 sampled pending banded items";
export const PENDING_HAS_CREATED_AT = "18/18 sampled pending banded items";

// --- The ambiguity flags (§7 of the brief) — confirm before a headline figure -

export interface AmbiguityFlag {
  question: string;
  recommendation: string;
}

/**
 * The report renders these as open decisions, not resolved facts. Kept as data so
 * a test can assert the list has not quietly shrunk.
 */
export const AMBIGUITY_FLAGS: readonly AmbiguityFlag[] = [
  {
    question:
      'What "how many band ones" counts: items, courses (distinct treatment plan) or patients?',
    recommendation:
      "Band is per-item and one course spans several bands, so items over-count a course. This report LEADS WITH COURSES and shows items and patients alongside — it does not pick one for you.",
  },
  {
    question: "What date the PENDING half is measured on — pending items have no completion date.",
    recommendation:
      "created_at (when the work was planned / the patient was seen) — recommended — rather than updated_at (last touched). The completed half is unambiguous (completed_at).",
  },
  {
    question: "Whether private / null-band items belong in an NHS report at all.",
    recommendation:
      "Excluded from every band cell and surfaced as a single excluded-non-NHS count, never folded into a band.",
  },
];

// --- Forbidden claims (§6) — enforced on screen AND as data ------------------

export interface ForbiddenClaim {
  claim: string;
  because: string;
}

/**
 * Claims this report may NEVER make, and the measurement that forbids each. Kept
 * as data so a test can assert the list has not quietly shrunk, and rendered
 * verbatim on screen under the always-on banner.
 */
export const FORBIDDEN_CLAIMS: readonly ForbiddenClaim[] = [
  {
    claim: "this is the NHS / Compass position — what BSA has accepted or paid",
    because:
      "No Compass integration exists (Compass is the NHS wall). These are clinical-record counts read from treatment_plan_items, not what the NHS BSA has accepted, scheduled or paid.",
  },
  {
    claim: "an item's band is the FP17 course band on the claim",
    because:
      "item.uda_band is per-item (0–4); the claim's course band uses a wider encoding (values 21/22 seen) and the plan→claim join is ignored server-side, so the two are not — and cannot cheaply be — reconciled here.",
  },
  {
    claim: "a UDA value or £ per item",
    because:
      "uda_band is a band LABEL, not a UDA count. Multiplying items by a band weight would invent UDAs — that is the claim-lifecycle report's expected/awarded territory, never this one.",
  },
  {
    claim: '"pending" means an unsubmitted claim',
    because:
      '"Pending" here means clinically incomplete (completed = false on the item), not a claim that is unsubmitted or unpaid.',
  },
  {
    claim: "a wire-level per-site split",
    because:
      "the item carries no site_id (0/300 sampled). Per-site is via the practitioner ROSTER, so a clinician rostered at two sites appears under each.",
  },
  {
    claim: "the course counts are exact",
    because:
      "~10.2% of banded items carry no treatment_plan_id and cannot be grouped into a course, so every course count is a FLOOR — the true number of courses is at least this.",
  },
];

// --- The always-on, non-dismissible banner ----------------------------------

/** One run of text in the banner. `emphasis` is presentation, not content. */
export interface BannerSegment {
  text: string;
  emphasis?: "strong" | "em" | "code";
}

/**
 * The header banner. ALWAYS ON, NOT DISMISSIBLE. It is the sentence that stops
 * this screen being mistaken for the NHS/Compass position or the pay run, and it
 * names the two facts that make it a clinical-record view and nothing more: the
 * signal is the item's own `completed` flag, and the band is per-item, not the
 * FP17 course band.
 */
export const CLINICAL_BANNER_SEGMENTS: readonly BannerSegment[] = [
  { text: "Clinical completion — not the NHS position, not the pay run.", emphasis: "strong" },
  {
    text: " These counts read the ",
  },
  { text: "completed", emphasis: "code" },
  { text: " flag on each " },
  { text: "treatment_plan_item", emphasis: "code" },
  {
    text: " (probed live on 14 August 2026): completed means the clinical record marks the work done, pending means it does not. It is ",
  },
  { text: "not what the NHS BSA has accepted or paid", emphasis: "strong" },
  {
    text: " — no Compass integration exists. Band is per-ITEM (",
  },
  { text: "uda_band", emphasis: "code" },
  {
    text: " 0–4), so it is not the FP17 course band on a claim, and one course spans several bands. Courses are counted by distinct treatment plan; ",
  },
  { text: "~10% of banded items carry no plan id, so course counts are a floor", emphasis: "strong" },
  { text: "." },
];

/** The banner as one string, for asserting the wording has not drifted. */
export const CLINICAL_BANNER_TEXT = CLINICAL_BANNER_SEGMENTS.map((s) => s.text).join("");
