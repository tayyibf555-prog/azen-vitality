// ===========================================================================
// THE ENGLAND NHS DENTAL EXEMPTION CATALOGUE — the legal content of this feature.
//
// A wrong or stale exemption list on a legal declaration is worse than no feature,
// so this list is pure, tested, dated, and gated. It enumerates the categories a
// patient in ENGLAND ticks to claim free NHS dental treatment on the FP17/PR
// declaration. Scotland, Wales and Northern Ireland differ; this practice is
// Vitality Dental, N15 London, so the catalogue is ENGLAND ONLY.
//
// SOURCE + VERSION. These categories track the NHS Business Services Authority
// "Help with NHS dental costs" guidance and the FP17/PR patient declaration
// (England). `FP17_SOURCE_VERSION` is a dated snapshot: the wording, and above all
// the Universal Credit earnings threshold, are set by NHS BSA and CHANGE. Before
// this feature is switched on for a practice, the wording MUST be re-verified
// against the live NHS BSA declaration and signed off in writing — the feature
// ships gated OFF precisely so that sign-off is a decision, not a default.
// exemptions.test.ts documents this source and pins the invariants below.
//
// TWO THINGS THIS LIST DELIBERATELY GETS RIGHT, because they are where a patient is
// most likely to over-claim:
//   1. HC3 is PARTIAL help and is NOT on this list. Only HC2 (FULL help via the NHS
//      Low Income Scheme) entitles a patient to free treatment. Listing HC3 as free
//      would be a false exemption.
//   2. The "I will pay" opt-out ("paying", defined in ./types.ts) is a REQUIRED
//      choice on the form, so a blank declaration is never mis-stored as exempt.
// ===========================================================================

/** Human-readable source, asserted by the test so it cannot silently drift. */
export const FP17_SOURCE =
  "NHS Business Services Authority — Help with NHS dental costs (England), FP17/PR patient declaration";

/**
 * Dated snapshot of the wording + thresholds this catalogue was written against.
 * Re-verify against the live NHS BSA declaration and re-date this before any
 * practice switch-on. yyyy-mm-dd.
 */
export const FP17_SOURCE_VERSION = "2025-04-08";

export type Fp17ExemptionKind = "age" | "maternity" | "benefit" | "certificate" | "low-income";

export interface Fp17ExemptionCategory {
  /** Stable machine key stored on the row. Never re-key an existing category. */
  key: string;
  /** The patient-facing tick-box wording. */
  label: string;
  kind: Fp17ExemptionKind;
  /**
   * Whether claiming this relies on the patient HOLDING a certificate they may be
   * asked to show. The evidence acknowledgement on the form covers all exemptions;
   * this flag lets a staff view flag which ones hinge on a document.
   */
  requiresCertificate: boolean;
  /** A caveat surfaced to staff/patient where the category is easy to get wrong. */
  note?: string;
}

/**
 * The free-treatment claims, in the order the FP17/PR declaration lists them.
 * Every entry here is an EXEMPTION (free). The "paying" opt-out is NOT here — it is
 * a distinct choice (see Fp17DeclarationChoice / isDeclarationChoice).
 */
export const EXEMPTION_CATEGORIES: Fp17ExemptionCategory[] = [
  {
    key: "under-18",
    label: "I am under 18 years old",
    kind: "age",
    requiresCertificate: false,
  },
  {
    key: "18-full-time-education",
    label: "I am 18 years old and in full-time education",
    kind: "age",
    requiresCertificate: false,
  },
  {
    key: "pregnant",
    label:
      "I am pregnant, or was pregnant when the treatment started, and hold a valid maternity exemption certificate (MatEx)",
    kind: "maternity",
    requiresCertificate: true,
  },
  {
    key: "new-mother",
    label:
      "I have had a baby in the 12 months before the treatment started and hold a valid maternity exemption certificate (MatEx)",
    kind: "maternity",
    requiresCertificate: true,
  },
  {
    key: "income-support",
    label: "I, or my partner, get Income Support",
    kind: "benefit",
    requiresCertificate: false,
  },
  {
    key: "income-based-jsa",
    label: "I, or my partner, get income-based Jobseeker's Allowance",
    kind: "benefit",
    requiresCertificate: false,
  },
  {
    key: "income-related-esa",
    label: "I, or my partner, get income-related Employment and Support Allowance",
    kind: "benefit",
    requiresCertificate: false,
  },
  {
    key: "pension-credit-guarantee",
    label: "I, or my partner, get Pension Credit Guarantee Credit",
    kind: "benefit",
    requiresCertificate: false,
  },
  {
    key: "universal-credit",
    label:
      "I, or my partner, get Universal Credit and met the earnings threshold for help with NHS dental costs in my last assessment period",
    kind: "benefit",
    requiresCertificate: false,
    // The exact net-earnings threshold is set by NHS BSA and changes; it is left OUT
    // of the wording on purpose so a stale figure cannot appear on a legal form.
    // Confirm the current threshold with NHS BSA before switch-on.
    note: "Universal Credit only qualifies when earnings are below the NHS BSA threshold for your last assessment period. Confirm the current threshold before relying on this.",
  },
  {
    key: "nhs-tax-credit-cert",
    label: "I am named on a valid NHS Tax Credit Exemption Certificate",
    kind: "certificate",
    requiresCertificate: true,
    note: "The NHS Tax Credit Exemption Certificate is being phased out as Tax Credits move to Universal Credit.",
  },
  {
    key: "hc2",
    label: "I am named on a valid HC2 certificate (full help through the NHS Low Income Scheme)",
    kind: "low-income",
    requiresCertificate: true,
    // The load-bearing correction: HC2 is full help; HC3 is only partial help and is
    // NOT on this list. Do not add an HC3 category — it does not entitle free care.
    note: "Only HC2 gives full help. An HC3 certificate is PARTIAL help and does not entitle you to free treatment — do not claim an exemption if you hold an HC3.",
  },
];

/** The literal opt-out choice a patient makes when they are NOT claiming exemption. */
export const PAYING_KEY = "paying" as const;

/** Patient-facing wording for the "not exempt" opt-out. */
export const PAYING_LABEL =
  "I will pay for my treatment (I am not claiming free NHS dental care)";

/** The set of valid exemption keys (the free-treatment claims). */
export const EXEMPTION_KEYS = EXEMPTION_CATEGORIES.map((c) => c.key);

/** A stored exemption key type. Kept as a string union at the value layer above. */
export type Fp17ExemptionKey = (typeof EXEMPTION_CATEGORIES)[number]["key"];

const EXEMPTION_KEY_SET = new Set<string>(EXEMPTION_KEYS);

/** Is this one of the free-treatment exemption keys? (Excludes "paying".) */
export function isExemptionKey(value: unknown): value is Fp17ExemptionKey {
  return typeof value === "string" && EXEMPTION_KEY_SET.has(value);
}

/** Is this a valid declaration choice — an exemption key OR the "paying" opt-out? */
export function isDeclarationChoice(value: unknown): boolean {
  return value === PAYING_KEY || isExemptionKey(value);
}

/** Look up a category's full definition, or undefined for "paying"/unknown. */
export function exemptionCategory(key: string): Fp17ExemptionCategory | undefined {
  return EXEMPTION_CATEGORIES.find((c) => c.key === key);
}

/** The label for any declaration choice (exemption or the paying opt-out). */
export function declarationChoiceLabel(key: string): string | undefined {
  if (key === PAYING_KEY) return PAYING_LABEL;
  return exemptionCategory(key)?.label;
}
