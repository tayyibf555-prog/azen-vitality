import { requireUser, requireOwnerRole, requireClientAccess } from "@/lib/auth/guard";
import { getClient } from "@/lib/mock/clients";
import {
  funnelSummary,
  funnelVariantSummary,
  isFunnelSurface,
  type FunnelVariantCounters,
} from "@/lib/funnel/events";
import { getPageBySlug, promoteWinner } from "@/lib/landing/repository";
import { decideAutoPromotion } from "@/lib/landing/winner";

export const dynamic = "force-dynamic";

// OWNER-ONLY: funnel aggregation for one surface over a date range, powering the
// drop-off view (assessment/booking) and the landing-page split-test results card.
// requireUser gates on a verified session (no-op until auth is enforced, matching
// the other dashboard routes) and requireOwnerRole restricts it to the practice
// owner / agency admin. Scoped to a client the caller may read so a signed-in user
// can never read another tenant's funnel.
//
// Two response shapes, by surface:
//   assessment | booking -> { ok, surface, from, to, steps:    [{ step, count }] }
//   landing              -> { ok, surface, from, to, variants: { a, b } }  (A/B counters)

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000; // a year, so an open range can't scan forever

function bad(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user; // 401 when enforced + signed out
  const forbidden = requireOwnerRole(user);
  if (forbidden) return forbidden; // 403 for non-owner roles

  const url = new URL(request.url);
  const surface = url.searchParams.get("surface");
  if (!isFunnelSurface(surface)) {
    return bad("surface must be one of assessment, booking, landing", 400);
  }

  // Client scope: an explicit ?client slug is resolved and access-checked (an
  // enforced user can only read a client they belong to). Absent that, fall back
  // to the caller's own client, then the single-tenant pilot default. The landing
  // results card always passes ?client; the drop-off view relies on the fallback.
  let clientId: string;
  const clientSlug = url.searchParams.get("client");
  if (clientSlug) {
    const client = getClient(clientSlug);
    if (!client) return bad("unknown client", 404);
    const denied = requireClientAccess(user, client.id);
    if (denied) return denied;
    clientId = client.id;
  } else {
    clientId = user?.clientId ?? "vitality";
  }

  // Date range: default to the last 30 days; both bounds optional but clamped.
  const now = Date.now();
  const toParam = url.searchParams.get("to");
  const fromParam = url.searchParams.get("from");
  const toMs = toParam && !Number.isNaN(Date.parse(toParam)) ? Date.parse(toParam) : now;
  let fromMs =
    fromParam && !Number.isNaN(Date.parse(fromParam))
      ? Date.parse(fromParam)
      : toMs - 30 * 24 * 60 * 60 * 1000;
  if (fromMs > toMs) fromMs = toMs;
  if (toMs - fromMs > MAX_RANGE_MS) fromMs = toMs - MAX_RANGE_MS;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  try {
    if (surface === "landing") {
      // Per-variant results are inherently per-PAGE, so a specific landing slug is
      // required: without it we would tally (and auto-promote on) another page's
      // traffic. The results card always sends ?landing=<slug>.
      const landingSlug = url.searchParams.get("landing");
      if (!landingSlug) return bad("landing surface requires a ?landing=<slug>", 400);
      const variants = await funnelVariantSummary({ clientId, surface, fromIso, toIso, landingSlug });
      // Lazy auto-promotion is evaluated here (see maybeAutoPromote): there is no
      // cron slot for landing split tests yet, so the read path is where a winner
      // gets promoted. It now judges on this page's own (scoped) counters.
      // Best-effort — never fails the results read.
      await maybeAutoPromote(clientId, landingSlug, variants);
      return Response.json({ ok: true, surface, from: fromIso, to: toIso, variants });
    }

    const steps = await funnelSummary({ clientId, surface, fromIso, toIso });
    return Response.json({ ok: true, surface, from: fromIso, to: toIso, steps });
  } catch {
    return bad("could not load the funnel summary", 500);
  }
}

/**
 * Lazy auto-promotion for a landing split test.
 *
 * CONSTRAINT: there is no cron slot yet for landing split tests (the platform's
 * 24/7 sweeps are a fixed set), so the pure decideAutoPromotion decision — tested
 * in isolation — is evaluated here, on the owner's results read, instead of on a
 * schedule. When a LIVE page has auto-promote on and no winner yet, and the
 * decision says a variant has clearly won on a fair sample, promoteWinner records
 * the winner and retires the loser. It is idempotent: a page that already has a
 * winner is skipped, so repeated reads never re-promote. Wrapped so any promotion
 * error is swallowed and the results read still returns.
 */
async function maybeAutoPromote(
  clientId: string,
  landingSlug: string | null,
  variants: { a: FunnelVariantCounters; b: FunnelVariantCounters },
): Promise<void> {
  if (!landingSlug) return;
  try {
    const found = await getPageBySlug(clientId, landingSlug);
    if (!found) return;
    const { page } = found;
    if (page.status !== "live" || !page.autoPromote || page.winnerVariant) return;
    const decision = decideAutoPromotion({ a: variants.a, b: variants.b });
    if (decision.promote && decision.winner) {
      await promoteWinner(page.id, clientId, decision.winner);
    }
  } catch {
    // Best-effort: a promotion failure must never break the results read.
  }
}
