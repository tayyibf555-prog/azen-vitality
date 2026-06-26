import { serviceClient } from "@/lib/supabase/server";
import type { Campaign, CampaignStatus } from "./campaign";

// Server-only CRUD for smile_assessment_campaign (service-role; the public landing
// reads via a safe-field GET, the internal management UI is requireUser-scoped).

// Thrown when a (client, slug) already exists — the API maps this to 409 so the
// owner can pick a different URL.
export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`The URL "${slug}" is already in use for this practice.`);
    this.name = "SlugTakenError";
  }
}

interface CampaignRow {
  id: string;
  client_id: string;
  site_id: string;
  slug: string;
  name: string;
  goal: string;
  goal_note: string | null;
  ideal_customer: string | null;
  target_budget: string;
  headline: string | null;
  intro: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToCampaign(r: CampaignRow): Campaign {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    slug: r.slug,
    name: r.name,
    goal: r.goal,
    goalNote: r.goal_note,
    idealCustomer: r.ideal_customer,
    targetBudget: r.target_budget,
    headline: r.headline,
    intro: r.intro,
    status: (r.status as CampaignStatus) ?? "active",
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface InsertCampaignInput {
  clientId: string;
  siteId: string;
  slug: string;
  name: string;
  goal: string;
  goalNote?: string | null;
  idealCustomer?: string | null;
  targetBudget: string;
  headline?: string | null;
  intro?: string | null;
  createdBy?: string | null;
}

export async function insertCampaign(input: InsertCampaignInput): Promise<Campaign> {
  const db = serviceClient();
  const { data, error } = await db
    .from("smile_assessment_campaign")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      slug: input.slug,
      name: input.name,
      goal: input.goal,
      goal_note: input.goalNote ?? null,
      ideal_customer: input.idealCustomer ?? null,
      target_budget: input.targetBudget,
      headline: input.headline ?? null,
      intro: input.intro ?? null,
      created_by: input.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") throw new SlugTakenError(input.slug); // unique (client_id, slug)
    throw error;
  }
  return rowToCampaign(data as CampaignRow);
}

/** A campaign by (client, slug), any status. Used by submit attribution. */
export async function getCampaignBySlug(clientId: string, slug: string): Promise<Campaign | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("smile_assessment_campaign")
    .select("*")
    .eq("client_id", clientId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCampaign(data as CampaignRow) : null;
}

/** Active campaign by (client, slug). The public landing 404s on null/paused. */
export async function getActiveCampaignBySlug(clientId: string, slug: string): Promise<Campaign | null> {
  const c = await getCampaignBySlug(clientId, slug);
  return c && c.status === "active" ? c : null;
}

export async function listCampaigns(clientId: string): Promise<Campaign[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("smile_assessment_campaign")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as CampaignRow[]).map(rowToCampaign);
}

export async function setCampaignStatus(id: string, clientId: string, status: CampaignStatus): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("smile_assessment_campaign")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("client_id", clientId); // scope the write to the caller's client
  if (error) throw error;
}

/** Response counts per campaign id, for the internal management list. */
export async function countResponsesByCampaign(campaignIds: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (campaignIds.length === 0) return out;
  const db = serviceClient();
  const { data, error } = await db
    .from("smile_assessment_response")
    .select("campaign_id")
    .in("campaign_id", campaignIds);
  if (error) throw error;
  for (const row of (data as { campaign_id: string | null }[]) ?? []) {
    if (row.campaign_id) out[row.campaign_id] = (out[row.campaign_id] ?? 0) + 1;
  }
  return out;
}
