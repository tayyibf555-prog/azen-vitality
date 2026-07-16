import { serviceClient } from "@/lib/supabase/server";
import type { LandingPageContent } from "./content";
import type {
  LandingPage,
  LandingPageStatus,
  LandingPageVariant,
  LandingPageWithVariants,
} from "./types";
import type { VariantKey } from "./winner";

// Server-only CRUD for landing_page + landing_page_variant (service-role, RLS
// bypassed like the other post-0012 modules). The public /go page reads a LIVE
// page via getLivePageBySlug (or any-status for a token preview); the owner UI
// and API go through the guarded list/detail/mutation helpers.

/** (client_id, slug) already exists. The API maps this to 409. */
export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`The URL "${slug}" is already in use for this practice.`);
    this.name = "SlugTakenError";
  }
}

interface PageRow {
  id: string;
  client_id: string;
  site_id: string | null;
  slug: string;
  treatment: string;
  campaign_ref: string | null;
  status: string;
  winner_variant: string | null;
  auto_promote: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface VariantRow {
  id: string;
  page_id: string;
  variant_key: string;
  content: unknown;
  status: string;
  created_at: string;
}

function rowToPage(r: PageRow): LandingPage {
  const winner = r.winner_variant === "a" || r.winner_variant === "b" ? r.winner_variant : null;
  const status: LandingPageStatus =
    r.status === "live" || r.status === "archived" ? r.status : "draft";
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    slug: r.slug,
    treatment: r.treatment,
    campaignRef: r.campaign_ref,
    status,
    winnerVariant: winner,
    autoPromote: Boolean(r.auto_promote),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToVariant(r: VariantRow): LandingPageVariant {
  return {
    id: r.id,
    pageId: r.page_id,
    variantKey: r.variant_key === "b" ? "b" : "a",
    content: r.content as LandingPageContent,
    status: r.status === "retired" ? "retired" : "active",
    createdAt: r.created_at,
  };
}

export interface InsertPageInput {
  clientId: string;
  siteId: string | null;
  slug: string;
  treatment: string;
  campaignRef: string | null;
  autoPromote: boolean;
  createdBy: string | null;
  variantA: LandingPageContent;
  variantB: LandingPageContent;
}

/**
 * Insert a draft page and its two variants. If the variant insert fails after the
 * page row is created, the orphan page is best-effort deleted before rethrowing.
 */
export async function insertPageWithVariants(input: InsertPageInput): Promise<LandingPageWithVariants> {
  const db = serviceClient();
  const { data: pageData, error: pageErr } = await db
    .from("landing_page")
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      slug: input.slug,
      treatment: input.treatment,
      campaign_ref: input.campaignRef,
      status: "draft",
      auto_promote: input.autoPromote,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (pageErr) {
    if (pageErr.code === "23505") throw new SlugTakenError(input.slug);
    throw pageErr;
  }
  const page = rowToPage(pageData as PageRow);

  const { data: variantData, error: variantErr } = await db
    .from("landing_page_variant")
    .insert([
      { page_id: page.id, variant_key: "a", content: input.variantA, status: "active" },
      { page_id: page.id, variant_key: "b", content: input.variantB, status: "active" },
    ])
    .select("*");
  if (variantErr) {
    await db.from("landing_page").delete().eq("id", page.id);
    throw variantErr;
  }

  const variants = (variantData as VariantRow[]).map(rowToVariant);
  return { page, variants };
}

async function variantsForPage(pageId: string): Promise<LandingPageVariant[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("landing_page_variant")
    .select("*")
    .eq("page_id", pageId)
    .order("variant_key", { ascending: true });
  if (error) throw error;
  return (data as VariantRow[]).map(rowToVariant);
}

async function pageBySlug(clientId: string, slug: string): Promise<LandingPage | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("landing_page")
    .select("*")
    .eq("client_id", clientId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToPage(data as PageRow) : null;
}

/** A page by (client, slug) in ANY status, with its variants. Used for token preview. */
export async function getPageBySlug(
  clientId: string,
  slug: string,
): Promise<LandingPageWithVariants | null> {
  const page = await pageBySlug(clientId, slug);
  if (!page) return null;
  return { page, variants: await variantsForPage(page.id) };
}

/** A LIVE page by (client, slug) with its variants, or null. The public 404 path. */
export async function getLivePageBySlug(
  clientId: string,
  slug: string,
): Promise<LandingPageWithVariants | null> {
  const found = await getPageBySlug(clientId, slug);
  return found && found.page.status === "live" ? found : null;
}

/** A page by id (scoped to client), with its variants. */
export async function getPageById(
  id: string,
  clientId: string,
): Promise<LandingPageWithVariants | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("landing_page")
    .select("*")
    .eq("id", id)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const page = rowToPage(data as PageRow);
  return { page, variants: await variantsForPage(page.id) };
}

export async function listPages(clientId: string): Promise<LandingPage[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("landing_page")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as PageRow[]).map(rowToPage);
}

/** Set a page's lifecycle status (publish -> live, archive -> archived). */
export async function setPageStatus(
  id: string,
  clientId: string,
  status: LandingPageStatus,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("landing_page")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("client_id", clientId);
  if (error) throw error;
}

/**
 * Promote a winning variant: record it on the page and retire the other variant so
 * the public page serves the winner to everyone. The page is forced live so a
 * promotion always results in a servable page.
 */
export async function promoteWinner(
  id: string,
  clientId: string,
  winner: VariantKey,
): Promise<void> {
  const db = serviceClient();
  const now = new Date().toISOString();
  const { error: pageErr } = await db
    .from("landing_page")
    .update({ winner_variant: winner, status: "live", updated_at: now })
    .eq("id", id)
    .eq("client_id", clientId);
  if (pageErr) throw pageErr;

  const loser: VariantKey = winner === "a" ? "b" : "a";
  const { error: winErr } = await db
    .from("landing_page_variant")
    .update({ status: "active" })
    .eq("page_id", id)
    .eq("variant_key", winner);
  if (winErr) throw winErr;
  const { error: loseErr } = await db
    .from("landing_page_variant")
    .update({ status: "retired" })
    .eq("page_id", id)
    .eq("variant_key", loser);
  if (loseErr) throw loseErr;
}
