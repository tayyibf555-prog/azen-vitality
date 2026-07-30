// ---------------------------------------------------------------------------
// The annual NHS contract target, per site.
//
// This is the one figure the UDA progress line depends on and the ONE figure the
// Dentally API cannot give us. A practice's contracted UDA for the year is set
// in its NHS contract, not in its practice management system, so it has to be
// configured. Until it is, the progress line says it is unavailable. It does not
// guess, and it does not fall back to a "typical" target: a percentage measured
// against a made-up denominator is exactly the kind of number that reads as fact
// and gets acted on, and the consequence of acting on it is an NHS clawback.
//
// Configured through the environment as a comma separated list of
// `<site id>=<annual UDA>`, e.g.
//
//   NHS_UDA_ANNUAL_TARGETS="site-cc=24000,site-rv=15500,site-ng=9800"
//
// Pure functions: the parser takes the raw string, so it is testable without
// touching the environment, and only the thin reader below looks at process.env.
// ---------------------------------------------------------------------------

/** Annual contracted UDA per internal site id. An unconfigured site is absent. */
export type UdaTargetsBySite = Readonly<Record<string, number>>;

/**
 * Parse the configured targets. Anything malformed is skipped rather than
 * coerced: a target of NaN, zero or a negative is not a target, and silently
 * turning one into 0 would make every practice look infinitely behind.
 */
export function parseUdaTargets(raw: string | undefined | null): UdaTargetsBySite {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  const out: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const siteId = part.slice(0, eq).trim();
    const value = Number(part.slice(eq + 1).trim());
    if (siteId.length === 0) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    out[siteId] = value;
  }
  return out;
}

/**
 * The combined annual target for a scope, or null when it cannot be stated.
 *
 * All-or-nothing on purpose. A group figure built from three configured sites
 * out of four understates the target, which flatters the progress line in the
 * one direction that matters. If any site in scope has no configured target,
 * the whole scope is unavailable.
 */
export function udaTargetForScope(
  targets: UdaTargetsBySite,
  siteIds: readonly string[],
): number | null {
  if (siteIds.length === 0) return null;
  let total = 0;
  for (const siteId of siteIds) {
    const target = targets[siteId];
    if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) return null;
    total += target;
  }
  return total;
}

/** Plain British English for why the progress line is blank. */
export const UDA_TARGET_UNAVAILABLE =
  "Contract progress unavailable: the annual UDA target is not configured. It is set in the NHS contract, not in Dentally, so it has to be entered here before pace can be shown.";

/** The configured targets, read once from the environment. */
export function configuredUdaTargets(): UdaTargetsBySite {
  return parseUdaTargets(process.env.NHS_UDA_ANNUAL_TARGETS);
}
