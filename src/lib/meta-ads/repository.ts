import { serviceClient } from "@/lib/supabase/server";
import type { CampaignObjective } from "./types";

// Server-only CRUD for meta_campaign (service-role, RLS bypassed like the other
// post-0012 modules: 0018 / 0032 / 0041 / 0044). The owner co-pilot assembles a
// Meta ad campaign DRAFT here from the owner's stated details plus AI-generated,
// compliance-linted ad copy. A row is a DRAFT that is READY to publish; it is NEVER
// live on Meta (publishing needs the client's Meta account connected, which is not
// built yet), so nothing here transitions to a "running" state.

export type MetaCampaignStatus = "draft" | "ready" | "published";

/** The generated, compliance-checked ad copy stored on a campaign. */
export interface MetaCampaignCopy {
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
  complianceNote: string;
}

/** A persisted Meta campaign draft (the app-side shape for the 0048 table). */
export interface MetaCampaignDraft {
  id: string;
  clientId: string;
  siteId: string | null;
  name: string;
  treatment: string;
  objective: CampaignObjective;
  status: MetaCampaignStatus;
  radiusMiles: number | null;
  dailyBudgetGbp: number | null;
  audienceNotes: string | null;
  transparentPricing: boolean;
  fromPriceGbp: number | null;
  negativeKeywords: string[];
  landingSlug: string | null;
  copy: MetaCampaignCopy;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  // Set by the publish adapter (0050) once the campaign is created on Meta in PAUSED
  // status. All null until then (the not-connected default). publishError is honest:
  // a Graph failure on publish, or a non-fatal note on success (e.g. radius fallback).
  metaCampaignRef: string | null;
  metaAdsetRef: string | null;
  metaAdRef: string | null;
  publishedAt: string | null;
  publishError: string | null;
}

interface CampaignRow {
  id: string;
  client_id: string;
  site_id: string | null;
  name: string;
  treatment: string;
  objective: string;
  status: string;
  radius_miles: number | string | null;
  daily_budget_gbp: number | string | null;
  audience_notes: string | null;
  transparent_pricing: boolean;
  from_price_gbp: number | string | null;
  negative_keywords: unknown;
  landing_slug: string | null;
  copy: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  meta_campaign_ref: string | null;
  meta_adset_ref: string | null;
  meta_ad_ref: string | null;
  published_at: string | null;
  publish_error: string | null;
}

function numOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toCopy(raw: unknown): MetaCampaignCopy {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    headline: typeof o.headline === "string" ? o.headline : "",
    primaryText: typeof o.primaryText === "string" ? o.primaryText : "",
    description: typeof o.description === "string" ? o.description : "",
    cta: typeof o.cta === "string" ? o.cta : "",
    complianceNote: typeof o.complianceNote === "string" ? o.complianceNote : "",
  };
}

function rowToCampaign(r: CampaignRow): MetaCampaignDraft {
  const objective: CampaignObjective =
    r.objective === "awareness" ||
    r.objective === "leads" ||
    r.objective === "traffic" ||
    r.objective === "engagement" ||
    r.objective === "retargeting"
      ? r.objective
      : "leads";
  const status: MetaCampaignStatus =
    r.status === "ready" || r.status === "published" ? r.status : "draft";
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    name: r.name,
    treatment: r.treatment,
    objective,
    status,
    radiusMiles: numOrNull(r.radius_miles),
    dailyBudgetGbp: numOrNull(r.daily_budget_gbp),
    audienceNotes: r.audience_notes,
    transparentPricing: Boolean(r.transparent_pricing),
    fromPriceGbp: numOrNull(r.from_price_gbp),
    negativeKeywords: Array.isArray(r.negative_keywords)
      ? (r.negative_keywords as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    landingSlug: r.landing_slug,
    copy: toCopy(r.copy),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    metaCampaignRef: r.meta_campaign_ref ?? null,
    metaAdsetRef: r.meta_adset_ref ?? null,
    metaAdRef: r.meta_ad_ref ?? null,
    publishedAt: r.published_at ?? null,
    publishError: r.publish_error ?? null,
  };
}

export interface CreateMetaCampaignInput {
  clientId: string;
  siteId: string | null;
  name: string;
  treatment: string;
  objective: CampaignObjective;
  status?: MetaCampaignStatus;
  radiusMiles: number | null;
  dailyBudgetGbp: number | null;
  audienceNotes: string | null;
  transparentPricing: boolean;
  fromPriceGbp: number | null;
  negativeKeywords: string[];
  landingSlug: string | null;
  copy: MetaCampaignCopy;
  createdBy: string | null;
}

/** Insert a Meta campaign draft and return the stored row. */
export async function createMetaCampaign(input: CreateMetaCampaignInput): Promise<MetaCampaignDraft> {
  const db = serviceClient();
  const { data, error } = await db
    .from("meta_campaign")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      name: input.name,
      treatment: input.treatment,
      objective: input.objective,
      status: input.status ?? "draft",
      radius_miles: input.radiusMiles,
      daily_budget_gbp: input.dailyBudgetGbp,
      audience_notes: input.audienceNotes,
      transparent_pricing: input.transparentPricing,
      from_price_gbp: input.fromPriceGbp,
      negative_keywords: input.negativeKeywords,
      landing_slug: input.landingSlug,
      copy: input.copy,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToCampaign(data as CampaignRow);
}

/** A campaign by id (no client scope here; callers enforce the IDOR check). */
export async function getMetaCampaign(id: string): Promise<MetaCampaignDraft | null> {
  const db = serviceClient();
  const { data, error } = await db.from("meta_campaign").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToCampaign(data as CampaignRow) : null;
}

/** A client's Meta campaigns, newest first, for a future management list view. */
export async function listMetaCampaigns(clientId: string): Promise<MetaCampaignDraft[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("meta_campaign")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as CampaignRow[]).map(rowToCampaign);
}

/**
 * The campaigns that are live on Meta (created in PAUSED status): status 'published'
 * with a stored campaign ref. This is exactly the set the insights sweep pulls figures
 * for. Optionally scoped to one client. Empty until something actually publishes.
 */
export async function listPublishedMetaCampaigns(clientId?: string): Promise<MetaCampaignDraft[]> {
  const db = serviceClient();
  let q = db
    .from("meta_campaign")
    .select("*")
    .eq("status", "published")
    .not("meta_campaign_ref", "is", null);
  if (clientId) q = q.eq("client_id", clientId);
  const { data, error } = await q.order("published_at", { ascending: false });
  if (error) throw error;
  return (data as CampaignRow[]).map(rowToCampaign);
}

/**
 * The outcome of a publish attempt, written back onto the campaign row. On success the
 * three Meta refs and publishedAt are set and status becomes 'published' (meaning:
 * created on Meta, PAUSED). On failure the status is left as it was (never 'published')
 * and publishError carries the honest Graph error; any refs that WERE created before the
 * failure are still stored so the objects are not orphaned invisibly. `note` is a
 * non-fatal honesty note on an otherwise-successful publish (e.g. radius fallback).
 */
export interface PublishResultWrite {
  ok: boolean;
  metaCampaignRef?: string | null;
  metaAdsetRef?: string | null;
  metaAdRef?: string | null;
  error?: string | null;
  note?: string | null;
}

/** Persist a publish attempt's outcome. Returns the updated campaign. */
export async function recordPublishResult(
  id: string,
  result: PublishResultWrite,
): Promise<MetaCampaignDraft | null> {
  const db = serviceClient();
  const nowIso = new Date().toISOString();
  // Only advance to 'published' on success. On failure the status is deliberately left
  // untouched (it stays 'ready'/'draft') so a Graph blip never marks a campaign live.
  const patch: Record<string, unknown> = {
    meta_campaign_ref: result.metaCampaignRef ?? null,
    meta_adset_ref: result.metaAdsetRef ?? null,
    meta_ad_ref: result.metaAdRef ?? null,
    updated_at: nowIso,
  };
  if (result.ok) {
    patch.status = "published";
    patch.published_at = nowIso;
    patch.publish_error = result.note ?? null;
  } else {
    patch.published_at = null;
    patch.publish_error = result.error ?? "publish failed";
  }
  const { data, error } = await db
    .from("meta_campaign")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCampaign(data as CampaignRow) : null;
}

/** One captured insights snapshot for a published campaign (all money GBP). */
export interface MetaCampaignInsight {
  campaignId: string;
  spendGbp: number | null;
  impressions: number | null;
  clicks: number | null;
  leads: number | null;
  raw?: unknown;
}

/** Insert one insights snapshot (the hourly sweep writes these). */
export async function insertMetaCampaignInsight(insight: MetaCampaignInsight): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("meta_campaign_insight").insert({
    campaign_id: insight.campaignId,
    spend_gbp: insight.spendGbp,
    impressions: insight.impressions,
    clicks: insight.clicks,
    leads: insight.leads,
    raw: insight.raw ?? null,
  });
  if (error) throw error;
}

/** The single, most-recent insights snapshot for a campaign, or null if none yet. */
export async function latestInsightForCampaign(
  campaignId: string,
): Promise<MetaCampaignInsight | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("meta_campaign_insight")
    .select("campaign_id, spend_gbp, impressions, clicks, leads")
    .eq("campaign_id", campaignId)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as {
    campaign_id: string;
    spend_gbp: number | string | null;
    impressions: number | string | null;
    clicks: number | string | null;
    leads: number | string | null;
  };
  return {
    campaignId: r.campaign_id,
    spendGbp: numOrNull(r.spend_gbp),
    impressions: numOrNull(r.impressions),
    clicks: numOrNull(r.clicks),
    leads: numOrNull(r.leads),
  };
}
