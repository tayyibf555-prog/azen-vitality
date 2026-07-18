import "server-only";
import { getPageBySlug, promoteWinner } from "@/lib/landing/repository";
import { decideAutoPromotion, type VariantKey } from "@/lib/landing/winner";
import type { FunnelVariantCounters } from "@/lib/funnel/events";

// The SINGLE auto-promotion decision+action for a landing split test, shared by
// both the read path (GET /api/funnel-event/summary, when the owner opens the
// results card) and the scheduled sweep (GET/POST /api/landing-pages/promote-sweep).
// Both call THIS function with the same per-page counters, so the promotion criteria
// are identical by construction — the thresholds live only in decideAutoPromotion
// (winner.ts) and are never re-derived here.
//
// Eligibility gate (unchanged from the original inline read-path version): a page is
// only promoted when it is LIVE, has auto-promote on, and has no winner yet — which
// also makes it idempotent, since a page that already has a winner is skipped.
// Best-effort: any error is swallowed so a promotion failure can never break the
// caller (a results read, or the rest of a sweep).

export type AutoPromoteResult =
  | { promoted: true; winner: VariantKey; reason: string }
  | { promoted: false; reason: string };

/**
 * Evaluate and, when the criteria are met, promote the winner for one landing page
 * (identified by its funnel `landingSlug`, which equals the page slug). `variants`
 * are this page's own scoped counters. Returns what happened, so a sweep can tally;
 * the read path ignores the return.
 */
export async function maybeAutoPromote(
  clientId: string,
  landingSlug: string | null,
  variants: { a: FunnelVariantCounters; b: FunnelVariantCounters },
): Promise<AutoPromoteResult> {
  if (!landingSlug) return { promoted: false, reason: "no landing slug" };
  try {
    const found = await getPageBySlug(clientId, landingSlug);
    if (!found) return { promoted: false, reason: "page not found" };
    const { page } = found;
    if (page.status !== "live" || !page.autoPromote || page.winnerVariant) {
      return { promoted: false, reason: "not eligible" };
    }
    const decision = decideAutoPromotion({ a: variants.a, b: variants.b });
    if (decision.promote && decision.winner) {
      await promoteWinner(page.id, clientId, decision.winner);
      return { promoted: true, winner: decision.winner, reason: decision.reason };
    }
    return { promoted: false, reason: decision.reason };
  } catch {
    // Best-effort: a promotion failure must never break the caller.
    return { promoted: false, reason: "error" };
  }
}
