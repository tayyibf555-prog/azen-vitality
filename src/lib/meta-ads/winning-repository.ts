import { serviceClient } from "@/lib/supabase/server";
import type { WinningAd } from "./ingest";

// Server-only CRUD for winning_ads (migration 0088), on the service-role client
// (RLS bypassed, same posture as repository.ts / 0048). This is niche-level
// reference data, not per-client and not patient data, so there is no client scope
// here — every practice reads the same library.

/** A stored library row (the ingest shape plus the DB-assigned id/timestamps). */
export interface StoredWinningAd extends WinningAd {
  id: string;
  createdAt: string;
  updatedAt: string;
}

interface WinningAdRow {
  id: string;
  niche: string;
  keyword: string;
  dedup_key: string;
  collation_id: string | null;
  ad_archive_id: string | null;
  collation_count: number | string | null;
  variant_count: number | string | null;
  page_name: string | null;
  page_id: string | null;
  title: string | null;
  body_text: string | null;
  cta_text: string | null;
  cta_type: string | null;
  link_url: string | null;
  display_format: string | null;
  publisher_platform: unknown;
  image_url: string | null;
  currency: string | null;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
  runtime_days: number | string | null;
  categories: unknown;
  ad_library_url: string | null;
  winning_score: number | string | null;
  created_at: string;
  updated_at: string;
}

function toInt(v: number | string | null | undefined, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Map a stored row back to the app shape. */
export function rowToWinningAd(r: WinningAdRow): StoredWinningAd {
  return {
    id: r.id,
    niche: r.niche,
    keyword: r.keyword,
    dedupKey: r.dedup_key,
    collationId: r.collation_id,
    adArchiveId: r.ad_archive_id,
    collationCount: r.collation_count === null || r.collation_count === undefined ? null : toInt(r.collation_count),
    variantCount: toInt(r.variant_count, 1),
    pageName: r.page_name,
    pageId: r.page_id,
    title: r.title,
    bodyText: r.body_text,
    ctaText: r.cta_text,
    ctaType: r.cta_type,
    linkUrl: r.link_url,
    displayFormat: r.display_format,
    publisherPlatform: toStringArray(r.publisher_platform),
    imageUrl: r.image_url,
    currency: r.currency,
    startDate: r.start_date,
    endDate: r.end_date,
    isActive: Boolean(r.is_active),
    runtimeDays: toInt(r.runtime_days),
    categories: toStringArray(r.categories),
    adLibraryUrl: r.ad_library_url,
    winningScore: toInt(r.winning_score),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Map an ingest result to the DB insert/upsert shape (camel -> snake). */
export function winningAdToInsert(a: WinningAd): Record<string, unknown> {
  return {
    niche: a.niche,
    keyword: a.keyword,
    dedup_key: a.dedupKey,
    collation_id: a.collationId,
    ad_archive_id: a.adArchiveId,
    collation_count: a.collationCount,
    variant_count: a.variantCount,
    page_name: a.pageName,
    page_id: a.pageId,
    title: a.title,
    body_text: a.bodyText,
    cta_text: a.ctaText,
    cta_type: a.ctaType,
    link_url: a.linkUrl,
    display_format: a.displayFormat,
    publisher_platform: a.publisherPlatform,
    image_url: a.imageUrl,
    currency: a.currency,
    start_date: a.startDate,
    end_date: a.endDate,
    is_active: a.isActive,
    runtime_days: a.runtimeDays,
    categories: a.categories,
    ad_library_url: a.adLibraryUrl,
    winning_score: a.winningScore,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Idempotently upsert a batch of library entries, keyed on (niche, dedup_key). An
 * ad already in the library is UPDATED in place (fresh runtime/variants/score/URLs),
 * never duplicated, so the weekly refresh and the seed are both re-runnable. Returns
 * the number of rows written.
 */
export async function upsertWinningAds(ads: WinningAd[]): Promise<number> {
  if (ads.length === 0) return 0;
  const db = serviceClient();
  const rows = ads.map(winningAdToInsert);
  const { data, error } = await db
    .from("winning_ads")
    .upsert(rows, { onConflict: "niche,dedup_key" })
    .select("id");
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

export interface ListWinningAdsOptions {
  niche?: string;
  /** Filter to one treatment keyword (implants, clear-aligners, ...). */
  keyword?: string;
  /** Max rows, best-first. Defaults to 60, hard-capped at 200. */
  limit?: number;
}

/** One stored library entry by its id, or null when it is not found. */
export async function getWinningAdById(id: string): Promise<StoredWinningAd | null> {
  const db = serviceClient();
  const { data, error } = await db.from("winning_ads").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToWinningAd(data as WinningAdRow) : null;
}

/** The library, best-first (winning_score desc), optionally filtered by keyword. */
export async function listWinningAds(opts: ListWinningAdsOptions = {}): Promise<StoredWinningAd[]> {
  const db = serviceClient();
  const niche = opts.niche ?? "uk-dental";
  const limit = Math.min(Math.max(1, opts.limit ?? 60), 200);
  let q = db.from("winning_ads").select("*").eq("niche", niche);
  if (opts.keyword) q = q.eq("keyword", opts.keyword);
  const { data, error } = await q
    .order("winning_score", { ascending: false })
    .order("runtime_days", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as WinningAdRow[]).map(rowToWinningAd);
}
