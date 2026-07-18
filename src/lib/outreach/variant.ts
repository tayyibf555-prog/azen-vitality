// Deterministic A/B variant assignment for two-angle outreach campaigns.
//
// A campaign with a second message angle (message_angle_b) is a two-message test: each
// enrolled patient is assigned ONE variant and always keeps it, so the same patient
// never receives two different angles across the cadence, and a re-run of the sweep
// resolves to the same variant every time. Assignment is a pure hash of
// (campaignId, patientId) so it needs no stored counter and is perfectly reproducible
// (and unit-testable). A campaign with no B angle is single-message: everyone is 'a'.
//
// SHA-256 gives a uniform bit distribution, so the low bit is an even ~50/50 split
// across any real cohort. This is deliberate randomisation of WHICH message a patient
// sees, not any form of optimisation or learning: the split never shifts in response to
// results.

import { createHash } from "node:crypto";

export type Variant = "a" | "b";

/**
 * The variant a patient is assigned within a campaign. Returns 'a' for every patient
 * when the campaign has no second angle (`hasVariantB` false), so a single-message
 * campaign is unchanged. When a B angle is set, hashes (campaignId, patientId) to a
 * stable, ~50/50 'a' | 'b'. Deterministic: the same pair always yields the same
 * variant, so drafting the same target again (cadence step 2, 3, or a re-run) keeps it
 * on its original message.
 */
export function assignVariant(campaignId: string, patientId: string, hasVariantB: boolean): Variant {
  if (!hasVariantB) return "a";
  const digest = createHash("sha256").update(`${campaignId}:${patientId}`).digest();
  // Low bit of a uniform 256-bit digest: an even, stable coin flip per patient.
  return (digest[0] & 1) === 0 ? "a" : "b";
}
