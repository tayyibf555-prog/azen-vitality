import { serviceClient } from "@/lib/supabase/server";

// funnel_event (migration 0042): anonymous, PII-free drop-off telemetry for the
// public funnels (the smile-assessment quiz and the booking page). A row is one
// step a session reached. There is deliberately NO name/phone/message content
// here: a session is a client-generated random id only, and meta is capped to a
// few small scalar values (e.g. a question index).
//
// This module owns validation (shared by the route + its tests), the bounded
// insert, and the per-step summary the owner drop-off view reads.

// 'landing' was added at integration: the landing-page split-test tracker
// (src/lib/landing/track.ts) emits funnel events on this same endpoint, carrying
// its A/B `variant` AND its `landingSlug` in each event's meta, so
// funnelVariantSummary can both group by variant and scope to a single page (one
// page's split test must never count another page's traffic).
export const FUNNEL_SURFACES = ["assessment", "booking", "landing"] as const;
export type FunnelSurface = (typeof FUNNEL_SURFACES)[number];

export const MAX_EVENTS_PER_BATCH = 20;
const MAX_STEP_LEN = 64;
const MAX_META_KEYS = 8;
const MAX_META_STR_LEN = 120;
const MAX_SESSION_LEN = 100;

export function isFunnelSurface(v: unknown): v is FunnelSurface {
  return typeof v === "string" && (FUNNEL_SURFACES as readonly string[]).includes(v);
}

/** A single validated event ready to persist (client id + session added by the route). */
export interface CleanFunnelEvent {
  step: string;
  meta: Record<string, string | number | boolean>;
}

/**
 * Keep only small scalar values from a caller-supplied meta object: no nested
 * objects/arrays (which could smuggle in bulk or PII), at most MAX_META_KEYS
 * keys, strings capped. Numbers must be finite. Everything else is dropped. This
 * is the guarantee that funnel meta stays tiny and non-PII by construction.
 */
export function sanitizeMeta(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let kept = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_META_KEYS) break;
    if (typeof k !== "string" || k.length === 0 || k.length > MAX_STEP_LEN) continue;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      out[k] = v;
      kept += 1;
    } else if (typeof v === "boolean") {
      out[k] = v;
      kept += 1;
    } else if (typeof v === "string") {
      out[k] = v.slice(0, MAX_META_STR_LEN);
      kept += 1;
    }
    // objects, arrays, null, undefined -> dropped
  }
  return out;
}

/** Validate a session id: a short, printable, client-generated token. */
export function isValidSessionId(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_SESSION_LEN;
}

/**
 * Coerce a raw events array into clean events. Non-array or empty -> []; each
 * entry needs a non-empty step string (capped). Meta is sanitized. Bounded to
 * MAX_EVENTS_PER_BATCH regardless of how many were sent.
 */
export function parseFunnelEvents(raw: unknown): CleanFunnelEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: CleanFunnelEvent[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_EVENTS_PER_BATCH) break;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { step?: unknown; meta?: unknown };
    const step = typeof e.step === "string" ? e.step.trim().slice(0, MAX_STEP_LEN) : "";
    if (!step) continue;
    out.push({ step, meta: sanitizeMeta(e.meta) });
  }
  return out;
}

export interface FunnelInsertRow {
  clientId: string;
  surface: FunnelSurface;
  sessionId: string;
  step: string;
  meta: Record<string, string | number | boolean>;
}

/** Bulk-insert funnel events. Best-effort at the call site (telemetry). */
export async function insertFunnelEvents(rows: FunnelInsertRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = serviceClient();
  const { error } = await db.from("funnel_event").insert(
    rows.map((r) => ({
      client_id: r.clientId,
      surface: r.surface,
      campaign_id: null,
      session_id: r.sessionId,
      step: r.step,
      meta: r.meta,
    })),
  );
  if (error) throw error;
}

export interface FunnelStepCount {
  step: string;
  count: number;
}

// Page size for the raw-row scan below. Kept at the PostgREST default page cap so
// a short page is a reliable "no more rows" signal; the loop is anchored to an
// exact head-count regardless, so a lower server cap can never truncate the tally.
const SUMMARY_PAGE = 1000;
// Above this row total the scan is logged: it means a big range / heavy traffic,
// worth surfacing so a truer DB-side rollup can be prioritised if it recurs.
const LARGE_SCAN_WARN = 50_000;

/**
 * Per-step counts for one client + surface over a date range, for the owner
 * drop-off view. Counts rows (a later workstream may switch to distinct sessions
 * per step for a truer funnel; the raw rows carry session_id for that).
 *
 * Steps are an OPEN set (landing emits arbitrary `section_<name>` scroll markers),
 * so the buckets cannot be enumerated for a single grouped count without a DB view
 * or RPC (a migration this workstream must not add). Instead of the old single
 * 50k-capped fetch (which silently under-counted past the cap), we take the exact
 * total from a head-count and page through the `step` column until every row is
 * tallied: correct at any scale, ordered by a stable unique key so offset paging
 * never skips or double-counts.
 */
export async function funnelSummary(args: {
  clientId: string;
  surface: FunnelSurface;
  fromIso: string;
  toIso: string;
}): Promise<FunnelStepCount[]> {
  const db = serviceClient();

  // Exact total first (head-count, no rows transferred): the ground truth for when
  // the page loop is done, so it is correct even if the server caps pages lower.
  const { count, error: countError } = await db
    .from("funnel_event")
    .select("*", { count: "exact", head: true })
    .eq("client_id", args.clientId)
    .eq("surface", args.surface)
    .gte("created_at", args.fromIso)
    .lte("created_at", args.toIso);
  if (countError) throw countError;
  const total = count ?? 0;

  const counts = new Map<string, number>();
  let scanned = 0;
  while (scanned < total) {
    const { data, error } = await db
      .from("funnel_event")
      .select("step")
      .eq("client_id", args.clientId)
      .eq("surface", args.surface)
      .gte("created_at", args.fromIso)
      .lte("created_at", args.toIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(scanned, scanned + SUMMARY_PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ step: string }>;
    if (rows.length === 0) break; // safety: never loop forever on an unexpected empty page
    for (const row of rows) counts.set(row.step, (counts.get(row.step) ?? 0) + 1);
    scanned += rows.length;
  }

  if (total >= LARGE_SCAN_WARN) {
    console.warn(
      `[funnelSummary] large scan: ${total} rows for client=${args.clientId} surface=${args.surface} ${args.fromIso}..${args.toIso}`,
    );
  }

  return [...counts.entries()].map(([step, count]) => ({ step, count })).sort((a, b) => b.count - a.count);
}

export interface FunnelVariantCounters {
  views: number;
  ctaClicks: number;
  leads: number;
}

/**
 * Per-variant counters for the A/B split test on ONE landing page, grouped by the
 * `variant` label and SCOPED to the page's `landingSlug` (both carried in each
 * event's meta). Scoping to landingSlug is essential: a client can run several
 * landing pages at once, and the promotion decision must judge a page on its own
 * traffic, never the whole surface. Maps the landing steps onto the counters the
 * promotion decision reads:
 *   step "viewed"      -> views
 *   step "cta_clicked" -> ctaClicks
 *   step "lead"        -> leads   (no landing step emits this yet; reserved so a
 *                                  later "converted" signal slots in with no schema change)
 *
 * DB-SIDE AGGREGATION: the buckets are a FIXED grid (2 variants x 3 steps), so each
 * cell is a single exact head-count (no rows transferred, no 50k cap). Correct at
 * any scale, unlike the old fetch-and-tally which silently under-counted past 50k.
 */
export async function funnelVariantSummary(args: {
  clientId: string;
  surface: FunnelSurface;
  fromIso: string;
  toIso: string;
  /** The specific landing page to scope to (its meta.landingSlug). Required. */
  landingSlug: string;
}): Promise<{ a: FunnelVariantCounters; b: FunnelVariantCounters }> {
  const db = serviceClient();

  const countFor = async (variant: "a" | "b", step: string): Promise<number> => {
    const { count, error } = await db
      .from("funnel_event")
      .select("*", { count: "exact", head: true })
      .eq("client_id", args.clientId)
      .eq("surface", args.surface)
      .eq("meta->>landingSlug", args.landingSlug)
      .eq("meta->>variant", variant)
      .eq("step", step)
      .gte("created_at", args.fromIso)
      .lte("created_at", args.toIso);
    if (error) throw error;
    return count ?? 0;
  };

  const [aViews, aCta, aLeads, bViews, bCta, bLeads] = await Promise.all([
    countFor("a", "viewed"),
    countFor("a", "cta_clicked"),
    countFor("a", "lead"),
    countFor("b", "viewed"),
    countFor("b", "cta_clicked"),
    countFor("b", "lead"),
  ]);

  return {
    a: { views: aViews, ctaClicks: aCta, leads: aLeads },
    b: { views: bViews, ctaClicks: bCta, leads: bLeads },
  };
}
