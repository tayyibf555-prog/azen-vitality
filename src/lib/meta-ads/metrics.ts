import type { MetaConnection } from "./connection";
import { META_API_VERSION } from "./publish";

// Pull performance figures for published campaigns from the Meta Marketing API Insights
// endpoint. Coded against Graph / Marketing API v25.0 (same pin as the publish adapter).
//
// This is READ-ONLY: it never spends, never changes a campaign, never contacts a patient.
// So it is gated ONLY on the Meta connection, not on any send kill switch. When the
// account is not connected there are no published campaigns and this is never called.

const GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

/**
 * The insights "actions" array carries every tracked action; a lead can arrive under
 * several action_type strings depending on how the client captures it (on-Meta instant
 * form, pixel lead event, grouped lead). We sum the value of any action whose type is a
 * known lead type. Documented types: offsite_conversion.fb_pixel_lead,
 * onsite_conversion.lead_grouped, leadgen_grouped, onsite_conversion.lead, and the bare
 * "lead". Anything else is ignored (we never over-count leads).
 */
export const LEAD_ACTION_TYPES = new Set<string>([
  "lead",
  "leadgen_grouped",
  "onsite_conversion.lead_grouped",
  "onsite_conversion.lead",
  "offsite_conversion.fb_pixel_lead",
]);

/** Parsed insights for one campaign (all money GBP). null means "no data captured". */
export interface ParsedInsight {
  spendGbp: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
  raw: unknown;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

interface InsightAction {
  action_type?: unknown;
  value?: unknown;
}

/** Sum the values of lead-type actions in an insights row's actions array. */
export function sumLeadActions(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions as InsightAction[]) {
    if (typeof a?.action_type === "string" && LEAD_ACTION_TYPES.has(a.action_type)) {
      const v = toNumberOrNull(a.value);
      if (v !== null) total += v;
    }
  }
  return total;
}

/**
 * Parse a raw Graph insights response ({ data: [ row ] }) into our numbers. When the
 * response has no rows (a brand-new campaign with no delivery yet) every figure is null,
 * which the UI reads as "awaiting data". When a row exists, leads is derived from the
 * actions array (0 when there are none).
 */
export function parseInsights(json: unknown): ParsedInsight {
  const rows = (json as { data?: unknown } | null)?.data;
  const row = Array.isArray(rows) && rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
  if (!row) {
    return { spendGbp: null, impressions: null, clicks: null, leads: null, raw: json };
  }
  return {
    spendGbp: toNumberOrNull(row.spend),
    impressions: toNumberOrNull(row.impressions),
    clicks: toNumberOrNull(row.clicks),
    leads: sumLeadActions(row.actions),
    raw: row,
  };
}

/**
 * Fetch lifetime insights for one published campaign. Throws on a Graph error so the
 * sweep can skip that campaign and carry on. `date_preset=maximum` gives the cumulative
 * lifetime figures, which is what an hourly snapshot wants.
 */
export async function fetchCampaignInsights(
  metaCampaignRef: string,
  connection: MetaConnection,
): Promise<ParsedInsight> {
  if (!connection.connected || !connection.accessToken) {
    throw new Error("Meta account is not connected");
  }
  const params = new URLSearchParams({
    fields: "spend,impressions,clicks,actions",
    date_preset: "maximum",
    access_token: connection.accessToken,
  });
  const res = await fetch(`${GRAPH_BASE}/${metaCampaignRef}/insights?${params.toString()}`, {
    method: "GET",
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || (json as { error?: unknown } | null)?.error) {
    const err = (json as { error?: { message?: string } } | null)?.error;
    throw new Error(err?.message ? `Meta: ${err.message}` : `Meta insights request failed (HTTP ${res.status})`);
  }
  return parseInsights(json);
}
