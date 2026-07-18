import { getClient } from "@/lib/mock/clients";
import type { CampaignObjective } from "./types";
import type { MetaConnection } from "./connection";
import type { MetaCampaignDraft } from "./repository";

// The REAL Meta (Facebook / Instagram) publish adapter. It creates a campaign, ad set,
// ad creative and ad on the Meta Marketing API from one of our assembled drafts.
//
// Coded against Graph / Marketing API v25.0 (the current stable at build time,
// released 2026-02-18). The version is pinned here so a Meta breaking change is a
// one-line bump, not a hunt.
//
// TWO HARD RULES, both budget-safety:
//   1. EVERY object is created in PAUSED status. Our platform NEVER sets a campaign
//      live-spending. The client reviews it in Ads Manager and activates it there.
//   2. We NEVER invent data. No daily budget => we refuse to publish (an ad set needs a
//      real budget). No site coordinates => radius targeting is dropped for an honest
//      UK-wide fallback, recorded as a note, never a guessed lat/lng.
//
// It never throws: every failure path returns an honest MetaPublishResult with `ok:false`
// and the Graph error, so the caller records publish_error and leaves the status untouched.

/** The Graph / Marketing API version this adapter is written against. */
export const META_API_VERSION = "v25.0";

const GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

/** Hard rule: everything is created paused. */
const PAUSED = "PAUSED";

/** The outcome of a publish attempt. */
export interface MetaPublishResult {
  ok: boolean;
  metaCampaignRef: string | null;
  metaAdsetRef: string | null;
  metaAdRef: string | null;
  /** A fatal error when ok is false (nothing went live). */
  error: string | null;
  /** A single combined non-fatal honesty note on an otherwise-successful publish. */
  note: string | null;
  /** The structured honesty notes (radius fallback, negative-keyword limitation, etc.). */
  notes: string[];
  apiVersion: string;
}

/** Map our objective enum to Meta's OUTCOME_* campaign objective. */
export function mapObjective(objective: CampaignObjective): string {
  switch (objective) {
    case "awareness":
      return "OUTCOME_AWARENESS";
    case "traffic":
      return "OUTCOME_TRAFFIC";
    case "engagement":
      return "OUTCOME_ENGAGEMENT";
    case "leads":
      return "OUTCOME_LEADS";
    // "retargeting" is OUR structural pattern, not a native Meta objective. The business
    // goal is still leads, so it maps to OUTCOME_LEADS; the retargeting audience is set up
    // by the client in Ads Manager.
    case "retargeting":
      return "OUTCOME_LEADS";
    default:
      return "OUTCOME_LEADS";
  }
}

/**
 * A valid optimization_goal + billing_event for the objective. Everything is created
 * PAUSED, so these are sensible, always-valid defaults the client can refine in Ads
 * Manager. We optimise for link clicks (not offsite conversions / lead forms) because no
 * pixel or instant form is provisioned programmatically, so link clicks is the one
 * combination guaranteed to create cleanly for a website-destination ad.
 */
export function mapOptimisation(objective: CampaignObjective): {
  optimizationGoal: string;
  billingEvent: string;
} {
  switch (objective) {
    case "awareness":
      return { optimizationGoal: "REACH", billingEvent: "IMPRESSIONS" };
    case "engagement":
      return { optimizationGoal: "POST_ENGAGEMENT", billingEvent: "IMPRESSIONS" };
    case "leads":
    case "traffic":
    case "retargeting":
    default:
      return { optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS" };
  }
}

/**
 * Map our free-text call to action to a valid Meta call_to_action_type. Only obvious
 * phrases are mapped; everything else falls back to LEARN_MORE (always valid). The client
 * can change the CTA in Ads Manager. We never emit an enum Meta would reject.
 */
export function mapCallToAction(cta: string): string {
  const c = (cta || "").toLowerCase();
  if (/\bcall\b|phone|ring us/.test(c)) return "CALL_NOW";
  if (/quote/.test(c)) return "GET_QUOTE";
  if (/sign ?up|register|subscribe|join/.test(c)) return "SIGN_UP";
  if (/contact|message|enquir|get in touch/.test(c)) return "CONTACT_US";
  if (/apply/.test(c)) return "APPLY_NOW";
  return "LEARN_MORE";
}

/** Daily budget in Meta's minor units (pence for GBP). */
export function dailyBudgetMinorUnits(dailyBudgetGbp: number): number {
  return Math.round(dailyBudgetGbp * 100);
}

/** The landing destination for the ad's creative, on PUBLIC_BASE_URL. */
export function landingUrlFor(campaign: Pick<MetaCampaignDraft, "clientId" | "landingSlug">): {
  url: string;
  hasLanding: boolean;
} {
  const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const slug = getClient(campaign.clientId)?.slug ?? campaign.clientId;
  if (campaign.landingSlug) {
    return { url: `${base}/go/${slug}/${campaign.landingSlug}`, hasLanding: true };
  }
  return { url: base, hasLanding: false };
}

/**
 * Ad set geo targeting. Our sites carry NO coordinates (see src/lib/mock/clients.ts: a
 * Site has name/dentallyId/timezone/openingHours, no lat/lng), so radius targeting cannot
 * be applied. We fall back to UK-wide (countries: ["GB"]) and, when the owner asked for a
 * radius, record an honest note. We NEVER guess coordinates.
 */
export function buildTargeting(radiusMiles: number | null): {
  targeting: { geo_locations: { countries: string[] } };
  radiusNote: string | null;
} {
  const targeting = { geo_locations: { countries: ["GB"] } };
  const radiusNote =
    radiusMiles && radiusMiles > 0
      ? `Radius targeting (${radiusMiles} miles) was NOT applied: the practice site has no coordinates configured, so the ad set was created with UK-wide targeting. Add site coordinates (lat/lng) to enable radius targeting, then adjust the audience in Ads Manager.`
      : null;
  return { targeting, radiusNote };
}

/** The ad set name, with an honest suffix recording excluded keywords (Meta has no
 *  negative keywords, so they cannot be enforced; we surface them instead of dropping). */
export function adsetName(baseName: string, negativeKeywords: string[]): string {
  const clean = baseName.trim() || "Ad set";
  if (negativeKeywords.length === 0) return `${clean} ad set`.slice(0, 400);
  const suffix = ` [excludes: ${negativeKeywords.join(", ")}]`;
  return `${clean} ad set${suffix}`.slice(0, 400);
}

interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
}

function graphErrorMessage(status: number, body: unknown): string {
  const err = (body as { error?: GraphError } | null)?.error;
  if (err && typeof err.message === "string" && err.message) {
    return `Meta: ${err.message}${typeof err.code === "number" ? ` (code ${err.code})` : ""}`;
  }
  return `Meta request failed (HTTP ${status})`;
}

/**
 * POST to a Graph node. Nested objects/arrays are JSON-encoded per Marketing API
 * conventions; the access token is sent in the body (never the query string). Throws on
 * any Graph error so the publish flow can convert it to an honest result.
 */
async function graphPost(
  node: string,
  params: Record<string, unknown>,
  accessToken: string,
): Promise<{ id: string }> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  body.set("access_token", accessToken);

  const res = await fetch(`${GRAPH_BASE}/${node}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || (json as { error?: unknown } | null)?.error) {
    throw new Error(graphErrorMessage(res.status, json));
  }
  const id = (json as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !id) {
    throw new Error("Meta returned no object id");
  }
  return { id };
}

function fail(
  error: string,
  partial: Partial<Pick<MetaPublishResult, "metaCampaignRef" | "metaAdsetRef" | "metaAdRef">> = {},
): MetaPublishResult {
  return {
    ok: false,
    metaCampaignRef: partial.metaCampaignRef ?? null,
    metaAdsetRef: partial.metaAdsetRef ?? null,
    metaAdRef: partial.metaAdRef ?? null,
    error,
    note: null,
    notes: [],
    apiVersion: META_API_VERSION,
  };
}

/**
 * Publish a campaign to Meta, creating everything in PAUSED status. Returns an honest
 * result; never throws. On success the three refs are set and `note` carries any
 * non-fatal honesty note (radius fallback, negative-keyword limitation, missing landing).
 */
export async function publishCampaign(
  campaign: MetaCampaignDraft,
  connection: MetaConnection,
): Promise<MetaPublishResult> {
  // Defensive re-check: the caller gates on this too, but the adapter must never call
  // Meta without a real, complete connection.
  if (!connection.connected || !connection.accessToken || !connection.adAccountId || !connection.pageId) {
    return fail("The practice's Meta account is not connected, so nothing was published.");
  }
  // Never invent a budget: an ad set needs a real daily budget > 0.
  if (!campaign.dailyBudgetGbp || campaign.dailyBudgetGbp <= 0) {
    return fail("Set a daily budget on the campaign before publishing; an ad set needs a real budget.");
  }

  const { accessToken, adAccountId, pageId } = connection;
  const notes: string[] = [];

  // Honest geo handling (radius fallback) and negative-keyword surfacing.
  const { targeting, radiusNote } = buildTargeting(campaign.radiusMiles);
  if (radiusNote) notes.push(radiusNote);
  if (campaign.negativeKeywords.length > 0) {
    notes.push(
      `Meta has no negative-keyword targeting, so the ${campaign.negativeKeywords.length} excluded term(s) were recorded on the ad set name for reference only and are NOT enforced by Meta: ${campaign.negativeKeywords.join(", ")}.`,
    );
  }
  const { url: landingUrl, hasLanding } = landingUrlFor(campaign);
  if (!hasLanding) {
    notes.push(
      "No landing page was attached, so the ad points at the site root. Attach a landing page for a stronger, on-brand destination.",
    );
  }

  const { optimizationGoal, billingEvent } = mapOptimisation(campaign.objective);

  let metaCampaignRef: string | null = null;
  let metaAdsetRef: string | null = null;
  try {
    // 1. Campaign (PAUSED). Dental health ads are not a special ad category, so [].
    const created = await graphPost(
      `${adAccountId}/campaigns`,
      {
        name: campaign.name,
        objective: mapObjective(campaign.objective),
        status: PAUSED,
        special_ad_categories: [],
      },
      accessToken,
    );
    metaCampaignRef = created.id;

    // 2. Ad set (PAUSED): real daily budget in pence, valid optimisation for the
    //    objective, UK-wide geo fallback, excluded keywords surfaced in the name.
    const adset = await graphPost(
      `${adAccountId}/adsets`,
      {
        name: adsetName(campaign.name, campaign.negativeKeywords),
        campaign_id: metaCampaignRef,
        daily_budget: dailyBudgetMinorUnits(campaign.dailyBudgetGbp),
        billing_event: billingEvent,
        optimization_goal: optimizationGoal,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        targeting,
        status: PAUSED,
      },
      accessToken,
    );
    metaAdsetRef = adset.id;

    // 3. Ad creative: our compliance-linted copy + the landing URL, posting as the Page.
    const creative = await graphPost(
      `${adAccountId}/adcreatives`,
      {
        name: `${campaign.name} creative`.slice(0, 100),
        object_story_spec: {
          page_id: pageId,
          link_data: {
            message: campaign.copy.primaryText,
            link: landingUrl,
            name: campaign.copy.headline,
            description: campaign.copy.description,
            call_to_action: {
              type: mapCallToAction(campaign.copy.cta),
              value: { link: landingUrl },
            },
          },
        },
      },
      accessToken,
    );

    // 4. Ad (PAUSED), binding the creative to the ad set.
    const ad = await graphPost(
      `${adAccountId}/ads`,
      {
        name: `${campaign.name} ad`.slice(0, 400),
        adset_id: metaAdsetRef,
        creative: { creative_id: creative.id },
        status: PAUSED,
      },
      accessToken,
    );

    const note = notes.length > 0 ? notes.join(" ") : null;
    return {
      ok: true,
      metaCampaignRef,
      metaAdsetRef,
      metaAdRef: ad.id,
      error: null,
      note,
      notes,
      apiVersion: META_API_VERSION,
    };
  } catch (err) {
    // Honest failure: keep any refs already created (so the objects are not orphaned
    // invisibly), report the Graph error. The caller leaves the status untouched.
    const message = err instanceof Error ? err.message : "Meta publish failed";
    return fail(message, { metaCampaignRef, metaAdsetRef });
  }
}
