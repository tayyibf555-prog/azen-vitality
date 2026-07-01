import { getClient } from "@/lib/mock/clients";
import type { RotaConfig } from "./types";

/**
 * Default coverage + automation config. A new client with no saved rota_config row
 * falls back to this, so generate + the sweep work out of the box.
 * - one dentist, one nurse, one reception per open day per site
 * - only text shifts within a week
 * - keep two weeks of shifts generated ahead
 */
export const DEFAULT_ROTA_CONFIG: RotaConfig = {
  rolesNeeded: { dentist: 1, nurse: 1, reception: 1 },
  notifyLeadDays: 7,
  generateWeeksAhead: 2,
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
      if (Number.isFinite(n) && n > 0) rolesNeeded[role] = Math.trunc(n);
    }
  }

  const notifyLeadDays = posInt(obj.notifyLeadDays, DEFAULT_ROTA_CONFIG.notifyLeadDays);
  const generateWeeksAhead = posInt(obj.generateWeeksAhead, DEFAULT_ROTA_CONFIG.generateWeeksAhead);

  return {
    rolesNeeded: Object.keys(rolesNeeded).length > 0 ? rolesNeeded : { ...DEFAULT_ROTA_CONFIG.rolesNeeded },
    notifyLeadDays,
    generateWeeksAhead,
  };
}

/** A positive integer coercion with a fallback (0 and negatives fall back too). */
function posInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}
