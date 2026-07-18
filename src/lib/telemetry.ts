import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { CLIENT_MODULE_SLUGS } from "@/lib/nav";
import { OVERVIEW_SURFACE } from "@/lib/telemetry-surface";

// Product usage telemetry (usage_event, migration 0055). The write seam for the
// route + the action-event call sites, and the ONE grouped read the owner Usage
// view uses. Privacy by construction: only a module-family surface, an internal
// actor (email/role off the verified session) and an action NAME are ever stored
// — never patient data, never free text, never a full URL/id (see sanitiseSurface).

// The allowlist of storable page-view surfaces: every client module slug, with the
// empty Overview slug represented as "overview". Built once. This is what keeps URL
// ids and unknown/spoofed families out of usage_event by construction.
const KNOWN_SURFACES: ReadonlySet<string> = new Set(
  CLIENT_MODULE_SLUGS.map((s) => (s === "" ? OVERVIEW_SURFACE : s)),
);

/**
 * Validate a page-view surface against the nav-slug allowlist. Returns the
 * canonical surface, or null when it is not a known module family — the route then
 * silently no-ops, so nothing outside the allowlist is ever stored.
 */
export function sanitiseSurface(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const surface = s === "" ? OVERVIEW_SURFACE : s;
  return KNOWN_SURFACES.has(surface) ? surface : null;
}

// Trusted-literal normaliser for action surfaces / names: the call sites pass short
// constants, so this is not allowlist-gated (an action can originate from a flow
// that is not a 1:1 nav slug, e.g. "landing"). It only guarantees a small, safe,
// PII-free token.
function safeToken(raw: string, max = 64): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}

export interface UsageActor {
  clientId: string;
  userEmail?: string | null;
  role?: string | null;
}

type UsageEventKind = "page_view" | "action";

// The single insert. Private; both public writers funnel through here so the row
// shape lives in exactly one place.
async function insertUsageEvent(row: {
  clientId: string;
  userEmail: string | null;
  role: string | null;
  event: UsageEventKind;
  surface: string;
  detail: string | null;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("usage_event").insert({
    client_id: row.clientId,
    user_email: row.userEmail,
    role: row.role,
    event: row.event,
    surface: row.surface,
    detail: row.detail,
  });
  if (error) throw error;
}

/**
 * Record a page view of a (pre-sanitised) surface. Fire-and-forget: it swallows
 * every error, so a telemetry failure can never break the request that triggered
 * it. The surface must already have passed sanitiseSurface.
 */
export async function recordPageView(input: {
  clientId: string;
  surface: string;
  userEmail?: string | null;
  role?: string | null;
}): Promise<void> {
  try {
    await insertUsageEvent({
      clientId: input.clientId,
      userEmail: input.userEmail ?? null,
      role: input.role ?? null,
      event: "page_view",
      surface: input.surface,
      detail: null,
    });
  } catch {
    // Telemetry must never surface an error.
  }
}

/**
 * Record an internal action event. ONE server-side seam, callable from an API route
 * with a single line: `void recordUsage("outreach", "campaign_launch", { clientId,
 * userEmail: auth?.email, role: auth?.role })`. `action` is stored as `detail` — the
 * action NAME only, never free text, a note body or an id. Fire-and-forget.
 */
export async function recordUsage(surface: string, action: string, ctx: UsageActor): Promise<void> {
  try {
    await insertUsageEvent({
      clientId: ctx.clientId,
      userEmail: ctx.userEmail ?? null,
      role: ctx.role ?? null,
      event: "action",
      surface: safeToken(surface),
      detail: safeToken(action),
    });
  } catch {
    // Telemetry must never surface an error.
  }
}

export interface UsageSurfaceCount {
  surface: string;
  views: number;
}

export interface UsageSummary {
  windowDays: number;
  totalViews: number;
  /** Page-view counts per surface, most-used first. */
  surfaces: UsageSurfaceCount[];
  /** The internal user with the most page views in the window, or null. */
  mostActiveUser: { email: string; views: number } | null;
}

// Page size kept at the PostgREST default cap so a short page is a reliable
// "no more rows" signal; the loop is anchored to an exact head-count regardless,
// so a lower server cap can never truncate the tally (mirrors funnelSummary — the
// codebase's proven fix for the old single-fetch that silently under-counted).
const SUMMARY_PAGE = 1000;
const USAGE_SCAN_CAP = 50_000;

/**
 * ONE grouped read for the owner Usage view: per-surface page-view counts and the
 * most-active internal user for a client over a window. The aggregation happens
 * here, server-side — raw rows never reach the client. Never throws: on any error
 * it returns an empty summary, so telemetry can never break the Reports page.
 */
export async function usageSummary(args: {
  clientId: string;
  sinceIso: string;
  windowDays?: number;
}): Promise<UsageSummary> {
  const windowDays = args.windowDays ?? 30;
  try {
    const db = serviceClient();

    // Exact total first (head-count, transfers no rows): the ground truth for when
    // the page loop is done, correct even if the server caps pages lower.
    const { count, error: countError } = await db
      .from("usage_event")
      .select("*", { count: "exact", head: true })
      .eq("client_id", args.clientId)
      .eq("event", "page_view")
      .gte("created_at", args.sinceIso);
    if (countError) throw countError;
    const total = Math.min(count ?? 0, USAGE_SCAN_CAP);

    const bySurface = new Map<string, number>();
    const byUser = new Map<string, number>();
    let scanned = 0;
    while (scanned < total) {
      const { data, error } = await db
        .from("usage_event")
        .select("surface, user_email")
        .eq("client_id", args.clientId)
        .eq("event", "page_view")
        .gte("created_at", args.sinceIso)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(scanned, scanned + SUMMARY_PAGE - 1);
      if (error) throw error;
      const rows = (data ?? []) as Array<{ surface: string; user_email: string | null }>;
      if (rows.length === 0) break; // safety: never loop forever on an unexpected empty page
      for (const r of rows) {
        bySurface.set(r.surface, (bySurface.get(r.surface) ?? 0) + 1);
        if (r.user_email) byUser.set(r.user_email, (byUser.get(r.user_email) ?? 0) + 1);
      }
      scanned += rows.length;
    }

    const surfaces = [...bySurface.entries()]
      .map(([surface, views]) => ({ surface, views }))
      .sort((a, b) => b.views - a.views);
    let mostActiveUser: UsageSummary["mostActiveUser"] = null;
    for (const [email, views] of byUser) {
      if (!mostActiveUser || views > mostActiveUser.views) mostActiveUser = { email, views };
    }
    return { windowDays, totalViews: scanned, surfaces, mostActiveUser };
  } catch {
    return { windowDays, totalViews: 0, surfaces: [], mostActiveUser: null };
  }
}
