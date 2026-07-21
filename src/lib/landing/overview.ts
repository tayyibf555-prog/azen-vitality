import { decideAutoPromotion, type PromotionDecision, type VariantKey } from "./winner";
import type { FunnelVariantCounters } from "@/lib/funnel/events";
import type { LandingPage, LandingPageStatus } from "./types";

// The "Landing pages" Growth section aggregator. PURE (no I/O), so it is fully
// unit-testable and holds no DB or crypto dependency: the view fetches each page's
// per-variant counters (funnelVariantSummary) and mints any draft preview token,
// then hands both in here to be shaped, decided and ranked.
//
// The winner marker is NOT re-derived here: it comes straight from the SAME shared
// decideAutoPromotion the split-test results card and the auto-promote sweep use,
// so the thresholds (MIN_VIEWS, relative lift, sparse-lead fallback) live in exactly
// one place. This file only reads that decision and decorates the rows with it.

/** One variant's counters plus the derived rates and its winner markers. */
export interface VariantStat {
  key: VariantKey;
  views: number;
  ctaClicks: number;
  leads: number;
  /** Click-through rate = ctaClicks / views (0 when there are no views). */
  ctaRate: number;
  /** Conversion (lead) rate = leads / views (0 when there are no views). */
  leadRate: number;
  /** This variant is the promoted winner (page.winnerVariant), so it is served to all. */
  promoted: boolean;
  /** This variant is the winner the shared decision calls on the live split test,
   *  or the promoted winner. Only ever true with a fair sample (decideAutoPromotion). */
  winning: boolean;
}

/** One landing page decorated with its stats, decision and preview link. */
export interface LandingPageOverview {
  page: LandingPage;
  treatmentName: string;
  /** Canonical public path of the live page. */
  path: string;
  /**
   * A link that WILL actually render for the owner: the live path for a live page,
   * the tokenised preview path for a draft, or null when a draft has no preview
   * token (no server key) or the page is archived (nothing public to preview).
   */
  previewPath: string | null;
  totalViews: number;
  totalCtaClicks: number;
  totalLeads: number;
  variants: { a: VariantStat; b: VariantStat };
  /** The shared auto-promotion decision on this page's own scoped counters. */
  decision: PromotionDecision;
  /** True once a live page has a called or promoted winner: the honest "performing well" flag. */
  performingWell: boolean;
  /** True once the page has any recorded views to talk about. */
  hasData: boolean;
}

/** Raw input for one page: its record, this page's scoped A/B counters, and any
 *  minted draft preview token (null for live/archived, or when no server key). */
export interface LandingOverviewInput {
  page: LandingPage;
  summary: { a: FunnelVariantCounters; b: FunnelVariantCounters };
  /** The minted preview token for a DRAFT, or null. Injected so this stays pure. */
  previewToken: string | null;
}

const STATUS_TIER: Record<LandingPageStatus, number> = { live: 0, draft: 1, archived: 2 };

function rate(numerator: number, views: number): number {
  return views > 0 ? numerator / views : 0;
}

function buildVariant(
  key: VariantKey,
  c: FunnelVariantCounters,
  promotedWinner: VariantKey | null,
  decision: PromotionDecision,
): VariantStat {
  const promoted = promotedWinner === key;
  // A page with a promoted winner has settled: the promoted variant is the winner.
  // Otherwise defer entirely to the shared decision (fair sample + clear lead).
  const winning = promoted || (decision.promote && decision.winner === key);
  return {
    key,
    views: c.views,
    ctaClicks: c.ctaClicks,
    leads: c.leads,
    ctaRate: rate(c.ctaClicks, c.views),
    leadRate: rate(c.leads, c.views),
    promoted,
    winning,
  };
}

function previewPathFor(page: LandingPage, path: string, previewToken: string | null): string | null {
  if (page.status === "live") return path; // a live page renders for anyone
  if (page.status === "draft") return previewToken ? `${path}?preview=${previewToken}` : null;
  return null; // archived: nothing public to preview
}

/**
 * Shape and rank every landing page for the section. Rows are sorted so the
 * best-performing pages are obvious: live pages first (performing-well ones ahead of
 * the rest, then by traffic), then drafts, then archived; within a tier the caller's
 * order (newest first from listPages) is preserved by the stable sort.
 */
export function deriveLandingOverview(args: {
  clientSlug: string;
  items: LandingOverviewInput[];
  /** Resolve a treatment key to its display name (injected from the catalogue). */
  treatmentName: (key: string) => string;
}): LandingPageOverview[] {
  const rows: LandingPageOverview[] = args.items.map(({ page, summary, previewToken }) => {
    const decision = decideAutoPromotion({ a: summary.a, b: summary.b });
    const variants = {
      a: buildVariant("a", summary.a, page.winnerVariant, decision),
      b: buildVariant("b", summary.b, page.winnerVariant, decision),
    };
    const totalViews = summary.a.views + summary.b.views;
    const path = `/go/${args.clientSlug}/${page.slug}`;
    return {
      page,
      treatmentName: args.treatmentName(page.treatment),
      path,
      previewPath: previewPathFor(page, path, previewToken),
      totalViews,
      totalCtaClicks: summary.a.ctaClicks + summary.b.ctaClicks,
      totalLeads: summary.a.leads + summary.b.leads,
      variants,
      decision,
      performingWell: page.status === "live" && (page.winnerVariant !== null || decision.promote),
      hasData: totalViews > 0,
    };
  });

  return rows.sort((a, b) => {
    const ta = STATUS_TIER[a.page.status];
    const tb = STATUS_TIER[b.page.status];
    if (ta !== tb) return ta - tb;
    if (a.page.status === "live") {
      if (a.performingWell !== b.performingWell) return a.performingWell ? -1 : 1;
      if (a.totalViews !== b.totalViews) return b.totalViews - a.totalViews;
    }
    return 0; // stable: keep the newest-first order listPages already applied
  });
}

/** Section-level totals for the header stats strip. */
export interface LandingOverviewTotals {
  pages: number;
  live: number;
  drafts: number;
  totalViews: number;
}

export function summariseLandingOverview(rows: LandingPageOverview[]): LandingOverviewTotals {
  return {
    pages: rows.length,
    live: rows.filter((r) => r.page.status === "live").length,
    drafts: rows.filter((r) => r.page.status === "draft").length,
    totalViews: rows.reduce((sum, r) => sum + r.totalViews, 0),
  };
}
