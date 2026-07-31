// ===========================================================================
// SEEDED EXAMPLE CAPABILITIES.
//
// MOCK DATA. The practice will supply the real answers, and the moment one real
// row is saved this whole array is out of use (suitability-source.ts switches
// wholesale, never row by row). Wherever the seed is in force, the UI SAYS SO.
//
// Seeded so the FAILURE cases are reachable, not just the happy path:
//   prac-4  Priya Raman   a hygienist: hygiene only, cannot the other nine.
//                         "Propose a hygienist for an extraction" is then a test
//                         that must fail.
//   prac-1  Dana Hale     a general dentist.
//   prac-2  Femi Osei     implant CANNOT everywhere, implant CAN at site-cc:
//                         the site-override case (the implant suite is at one
//                         site only).
//   prac-3  Jin Kim       SUPERVISED on surgical, and NO hygiene row at all, so
//                         a partial record is reachable.
//   prac-21 Marcus Bell   NO ROWS AT ALL, so "unknown" is reachable.
// ===========================================================================

import type { FamilySlug } from "@/components/client/calendar/treatment-type";
import type { Capability, CapabilityLevel } from "./suitability";

function rows(
  practitionerId: string,
  level: CapabilityLevel,
  families: readonly FamilySlug[],
  siteId: string | null = null,
): Capability[] {
  return families.map((familySlug) => ({
    practitionerId,
    siteId,
    familySlug,
    level,
    source: "seed" as const,
  }));
}

export const SUITABILITY_SEED: readonly Capability[] = [
  // A hygienist. Hygiene and nothing else.
  ...rows("prac-4", "can", ["hygiene"]),
  ...rows("prac-4", "cannot", [
    "implant",
    "ortho",
    "endodontic",
    "surgical",
    "restorative",
    "cosmetic",
    "emergency",
    "exam",
    "treatment",
  ]),

  // A general dentist.
  ...rows("prac-1", "can", ["exam", "hygiene", "restorative", "endodontic", "emergency", "treatment"]),
  ...rows("prac-1", "cannot", ["implant", "ortho", "cosmetic", "surgical"]),

  // Surgical and restorative, plus the site override for implants.
  ...rows("prac-2", "can", ["exam", "restorative", "surgical", "emergency", "treatment"]),
  ...rows("prac-2", "cannot", ["hygiene", "ortho", "endodontic", "cosmetic"]),
  ...rows("prac-2", "cannot", ["implant"]),
  ...rows("prac-2", "can", ["implant"], "site-cc"),

  // Supervised on surgical; no hygiene row at all.
  ...rows("prac-3", "can", ["exam", "restorative", "ortho", "cosmetic", "treatment"]),
  ...rows("prac-3", "supervised", ["surgical"]),
  ...rows("prac-3", "cannot", ["implant", "endodontic"]),

  // prac-21 Marcus Bell: deliberately absent, so "unknown" is exercised.
] as const;
