import { getClient } from "@/lib/mock/clients";
import { DEFAULT_PAIR_ROLES, type PairRoles, type RotaConfig } from "./types";

/**
 * Default coverage + automation config. A new client with no saved rota_config row
 * falls back to this, so generate + the sweep work out of the box.
 * - one dentist, one nurse, one reception per open day per site
 * - only text shifts within a week
 * - keep two weeks of shifts generated ahead
 * - a dentist works with a nurse (the pairing the rota grid shows)
 */
export const DEFAULT_ROTA_CONFIG: RotaConfig = {
  rolesNeeded: { dentist: 1, nurse: 1, reception: 1 },
  notifyLeadDays: 7,
  generateWeeksAhead: 2,
  pairRoles: { ...DEFAULT_PAIR_ROLES },
};

/** The display name for a client's practice, for message copy. */
export function practiceName(clientId: string): string {
  return getClient(clientId)?.name ?? "the practice";
}

/**
 * Coerce an unknown (e.g. a stored jsonb blob or a request body) into a valid
 * RotaConfig, filling any missing/invalid field from the defaults. Never throws,
 * so a partial or malformed config can never break generation.
 */
export function normaliseConfig(raw: unknown): RotaConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const rolesNeeded: Record<string, number> = {};
  const rawRoles = obj.rolesNeeded;
  if (rawRoles && typeof rawRoles === "object") {
    for (const [role, count] of Object.entries(rawRoles as Record<string, unknown>)) {
      const n = typeof count === "number" ? count : Number(count);
      // Guard the truncated value too: a fractional 0 < n < 1 (e.g. 0.5) trunc's to 0,
      // which would store a meaningless "0 needed" for the role. Skip those.
      if (Number.isFinite(n) && Math.trunc(n) > 0) rolesNeeded[role] = Math.trunc(n);
    }
  }

  const notifyLeadDays = posInt(obj.notifyLeadDays, DEFAULT_ROTA_CONFIG.notifyLeadDays);
  const generateWeeksAhead = posInt(obj.generateWeeksAhead, DEFAULT_ROTA_CONFIG.generateWeeksAhead);

  return {
    rolesNeeded: Object.keys(rolesNeeded).length > 0 ? rolesNeeded : { ...DEFAULT_ROTA_CONFIG.rolesNeeded },
    notifyLeadDays,
    generateWeeksAhead,
    pairRoles: pairRoles(obj.pairRoles),
  };
}

/**
 * Coerce the stored pairing into `PairRoles | null`.
 *
 * MISSING is not the same as OFF, and the difference decides whether an existing
 * practice silently loses its pairing. A config saved before pairing existed has no
 * `pairRoles` key at all, so `undefined` falls back to the default pair; an explicit
 * `null` is a practice saying "we do not work in pairs" and is honoured.
 */
function pairRoles(v: unknown): PairRoles | null {
  if (v === null) return null;
  if (v === undefined) return { ...DEFAULT_PAIR_ROLES };
  if (typeof v !== "object") return { ...DEFAULT_PAIR_ROLES };
  const raw = v as Record<string, unknown>;
  const clinical = typeof raw.clinical === "string" ? raw.clinical.trim() : "";
  const support = typeof raw.support === "string" ? raw.support.trim() : "";
  // A half-specified pair is meaningless and a same-role pair is a typo; both fall
  // back rather than storing something that pairs nobody or pairs everybody.
  if (!clinical || !support || clinical === support) return { ...DEFAULT_PAIR_ROLES };
  return { clinical, support };
}

/** A positive integer coercion with a fallback (0, negatives, and fractions that
 *  truncate to 0 like 0.5 all fall back, so a config value can never silently
 *  become 0 and leave the rota unpopulated). */
function posInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  const truncated = Math.trunc(n);
  return Number.isFinite(n) && truncated > 0 ? truncated : fallback;
}
