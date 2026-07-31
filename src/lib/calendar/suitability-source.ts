import "server-only";

// ===========================================================================
// THE SEAM between the seeded example capabilities and the practice's real ones.
//
// THIS IS THE ONLY FILE THAT CHANGES when the owner supplies the real data. The
// matching logic (suitability.ts, propose.ts) is pure, takes an array, and never
// learns where the array came from.
// ===========================================================================

import { selectTreatmentCapability } from "./repository";
import { SUITABILITY_SEED } from "./suitability-seed";
import type { Capability } from "./suitability";

export interface LoadedCapabilities {
  caps: readonly Capability[];
  /** True when the SEED is in force. The UI must say so wherever it is. */
  seeded: boolean;
}

/**
 * The capability rows in force for a client.
 *
 * ALL OR NOTHING, deliberately NOT a row-by-row merge. A half-filled real table
 * silently backfilled with mock rows is exactly the quiet lie this platform
 * forbids: nobody looking at a proposal could tell which clinicians the practice
 * had actually vouched for. The moment ONE real row is saved, the seed is out
 * entirely, and any clinician the practice has not yet answered for resolves to
 * "unknown" - which is excluded, with a reason, rather than guessed.
 */
export async function loadCapabilities(clientId: string): Promise<LoadedCapabilities> {
  const rows = await selectTreatmentCapability(clientId);
  if (rows.length > 0) return { caps: rows, seeded: false };
  return { caps: SUITABILITY_SEED, seeded: true };
}

/** The banner the proposal panel shows whenever the seed is in force. */
export const SEEDED_CAPABILITIES_NOTICE =
  "Using seeded example capabilities. Ask the practice to confirm who can do what.";
