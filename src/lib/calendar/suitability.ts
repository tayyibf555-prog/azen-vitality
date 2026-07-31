// ===========================================================================
// WHICH CLINICIANS CAN DO WHICH TREATMENTS.
//
// PURE. It takes an array of capability rows and does not know where they came
// from. That is the whole seam: when the practice supplies its real answers, only
// suitability-source.ts changes and none of this does.
//
// UNKNOWN IS NOT SUITABLE. A practitioner with no row for a family resolves to
// "unknown", and unknown is EXCLUDED from every proposal. Never coerced to "can".
// Same asymmetry as grey-means-off: a false exclusion costs a phone call, a false
// inclusion books a hygienist for an implant.
// ===========================================================================

import type { FamilySlug } from "@/components/client/calendar/treatment-type";

export type CapabilityLevel = "can" | "cannot" | "supervised";
export type CapabilitySource = "seed" | "practice";

export interface Capability {
  practitionerId: string;
  /** null = every site. A site row overrides the null-site row for that site. */
  siteId: string | null;
  familySlug: FamilySlug;
  level: CapabilityLevel;
  source: CapabilitySource;
  note?: string | null;
}

/** What we know, including the honest fourth answer. */
export type CapabilityAnswer = CapabilityLevel | "unknown";

/**
 * Precedence: (practitioner, EXACT site, family) beats (practitioner, null site,
 * family) beats "unknown".
 *
 * The site override exists because clinicians move between sites on a rota but
 * equipment does not: an implant suite exists at one site, so the same clinician
 * genuinely can do implants there and cannot elsewhere.
 */
export function capabilityFor(
  caps: readonly Capability[],
  practitionerId: string,
  siteId: string | null,
  familySlug: FamilySlug,
): CapabilityAnswer {
  let general: CapabilityLevel | null = null;
  for (const c of caps) {
    if (c.practitionerId !== practitionerId || c.familySlug !== familySlug) continue;
    if (siteId !== null && c.siteId === siteId) return c.level; // exact site wins outright
    if (c.siteId === null) general = c.level;
  }
  return general ?? "unknown";
}

/** Only 'can' and 'supervised' may ever be proposed. */
export function isSuitable(answer: CapabilityAnswer): answer is "can" | "supervised" {
  return answer === "can" || answer === "supervised";
}

/**
 * Why a clinician was not offered, in words a receptionist can act on.
 *
 * "unknown" gets its own sentence rather than being folded into "cannot",
 * because the two call for different actions: one is a fact about the clinician,
 * the other is a gap in the practice's own data.
 */
export function capabilityReason(answer: CapabilityAnswer, treatment: string): string {
  switch (answer) {
    case "can":
    case "supervised":
      return "";
    case "cannot":
      return `They do not do ${treatment}.`;
    default:
      return "We do not have a record of who can do this treatment.";
  }
}
