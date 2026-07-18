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
