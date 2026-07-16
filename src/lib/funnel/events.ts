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
// its A/B `variant` in each event's meta so funnelVariantSummary can group by it.
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

/**
 * Per-step counts for one client + surface over a date range, for the owner
 * drop-off view. Counts rows (a later workstream may switch to distinct sessions
 * per step for a truer funnel; the raw rows carry session_id for that).
 */
export async function funnelSummary(args: {
  clientId: string;
  surface: FunnelSurface;
  fromIso: string;
  toIso: string;
}): Promise<FunnelStepCount[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("funnel_event")
    .select("step")
    .eq("client_id", args.clientId)
    .eq("surface", args.surface)
    .gte("created_at", args.fromIso)
    .lte("created_at", args.toIso)
    .limit(50_000);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ step: string }>) {
    counts.set(row.step, (counts.get(row.step) ?? 0) + 1);
  }
  return [...counts.entries()].map(([step, count]) => ({ step, count })).sort((a, b) => b.count - a.count);
}

export interface FunnelVariantCounters {
  views: number;
  ctaClicks: number;
  leads: number;
}

/**
 * Per-variant counters for an A/B split test on one surface (today: landing
 * pages), grouped by the `variant` label carried in each event's meta. Maps the
 * landing steps onto the counters the promotion decision reads:
 *   step "viewed"      -> views
 *   step "cta_clicked" -> ctaClicks
 *   step "lead"        -> leads   (no landing step emits this yet; reserved so a
 *                                  later "converted" signal slots in with no schema change)
 * Only 'a' and 'b' variants are counted; any other value is ignored. Shares the
 * same (client, surface, created_at) index and bounded scan as funnelSummary.
 */
export async function funnelVariantSummary(args: {
  clientId: string;
  surface: FunnelSurface;
  fromIso: string;
  toIso: string;
}): Promise<{ a: FunnelVariantCounters; b: FunnelVariantCounters }> {
  const db = serviceClient();
  const { data, error } = await db
    .from("funnel_event")
    .select("step, meta")
    .eq("client_id", args.clientId)
    .eq("surface", args.surface)
    .gte("created_at", args.fromIso)
    .lte("created_at", args.toIso)
    .limit(50_000);
  if (error) throw error;
  const blank = (): FunnelVariantCounters => ({ views: 0, ctaClicks: 0, leads: 0 });
  const out: { a: FunnelVariantCounters; b: FunnelVariantCounters } = { a: blank(), b: blank() };
  for (const row of (data ?? []) as Array<{ step: string; meta: Record<string, unknown> | null }>) {
    const variant = row.meta && typeof row.meta.variant === "string" ? row.meta.variant : null;
    if (variant !== "a" && variant !== "b") continue;
    const bucket = out[variant];
    if (row.step === "viewed") bucket.views += 1;
    else if (row.step === "cta_clicked") bucket.ctaClicks += 1;
    else if (row.step === "lead") bucket.leads += 1;
  }
  return out;
}
