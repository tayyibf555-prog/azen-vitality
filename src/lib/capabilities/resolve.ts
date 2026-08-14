import type { Role } from "@/lib/types";
import { isCapability, isLocked, type Capability } from "./keys";
import { ROLE_DEFAULTS } from "./defaults";

// ===========================================================================
// ROLE DEFAULTS + PER-PERSON OVERRIDES -> THE SET THIS PERSON ACTUALLY HOLDS.
//
// One pure function. No Date, no env, no DB, no `server-only`, so the server
// guard, the admin grid and vitest all run the identical code.
//
// THE SEMANTICS, AND WHY THEY ARE THIS WAY:
//
//   no row        ask the role. This is what makes shipping the table INERT:
//                 until somebody ticks a box, every person in the practice holds
//                 exactly what their role held yesterday.
//   granted=true  an explicit GRANT on top of the role.
//   granted=false an explicit REVOKE of something the role has.
//
// DENY BY DEFAULT ON UNKNOWNS. An override naming a capability that is not in
// the catalog is IGNORED — never granted. The nav's allow-by-default is what
// created the clinician problem (`canRoleAccessModule` returns true for a slug it
// does not recognise); this layer does not repeat it. A renamed or retired key
// therefore fails safe: the stale row stops doing anything at all.
// ===========================================================================

export interface CapabilityOverride {
  /** A capability key. Unknown strings are ignored, never granted. */
  capability: string;
  /** true = GRANT, false = REVOKE. */
  granted: boolean;
}

/**
 * The capabilities this person holds.
 *
 * Returns a FRESH set every call: mutating the result cannot reach back into
 * `ROLE_DEFAULTS` and change what the role means for every other request in the
 * process.
 */
export function resolveCapabilities(
  role: Role,
  overrides: readonly CapabilityOverride[],
): ReadonlySet<Capability> {
  const set = new Set<Capability>(ROLE_DEFAULTS[role]);
  for (const o of overrides) {
    if (!o || typeof o !== "object") continue;
    // Unknown key: ignored. Never granted, and never allowed to remove a real one
    // by accident either (a near-miss string simply does nothing).
    if (!isCapability(o.capability)) continue;
    // LOCKED: neither grantable nor revocable by an override. The escalation this
    // closes is one line long — an owner grants `security.capability.manage` to a
    // coordinator, who then grants themselves everything else. The only way to
    // hold a locked key is to be a role that holds it by default.
    if (isLocked(o.capability)) continue;
    if (o.granted) set.add(o.capability);
    else set.delete(o.capability);
  }
  return set;
}

/**
 * Whether a person's effective answer for one key came from their ROLE or from a
 * per-person override — and, if an override, which way it went.
 *
 * The grid needs this to distinguish "on because that is what a practice manager
 * is" from "on because somebody decided it for this person". Pure, so the same
 * answer is computed server-side and client-side.
 */
export type CapabilitySource = "role" | "granted" | "revoked";

export function capabilitySource(
  role: Role,
  key: Capability,
  overrides: readonly CapabilityOverride[],
): CapabilitySource {
  const byDefault = ROLE_DEFAULTS[role].has(key);
  if (isLocked(key)) return "role"; // an override on a locked key is inert, so it is not the source
  // The LAST override for the key wins, matching resolveCapabilities' loop order.
  let decided: boolean | null = null;
  for (const o of overrides) {
    if (!o || typeof o !== "object") continue;
    if (o.capability !== key) continue;
    decided = Boolean(o.granted);
  }
  if (decided === null) return "role";
  if (decided === byDefault) return "role"; // an override that agrees with the role changes nothing
  return decided ? "granted" : "revoked";
}
