import { cronUnauthorized } from "@/lib/cron";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { listPages } from "@/lib/landing/repository";
import { funnelVariantSummary } from "@/lib/funnel/events";
import { maybeAutoPromote } from "@/lib/landing/promote";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
// The cron lease MUST outlive maxDuration (a shorter lease expires mid-run and lets
// the next tick double-work). Passed as an inline numeric literal so the repo-wide
// static check (sweep-leases.area-b.test.ts) can verify lease > maxDuration.

// Scheduled landing-page split-test auto-promotion.
//
// GAP THIS CLOSES: auto-promotion previously only fired when an owner OPENED the
// split-test results card (GET /api/funnel-event/summary). With auto-promote on but
// nobody viewing, a settled winner was never promoted. This sweep runs the IDENTICAL
// decision on a cadence: for every LIVE page with auto-promote on and no winner yet,
// it computes the page's own last-30-days counters and calls the SAME shared
// maybeAutoPromote the read path uses (so thresholds are never re-derived).
//
// Idempotent: a page that already has a winner is filtered out before the summary is
// computed, and maybeAutoPromote re-checks eligibility on fresh state before writing,
// so a second run (or a race with the read path) never re-promotes.
//
// Auth: the shared CRON_SECRET Bearer check (fail-closed in production). Lock: the
// shared cron lease, so two overlapping runs never double-work. Single-tenant pilot,
// so it scans the one client, matching the outreach sweep.

const CLIENT_ID = "vitality";
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // last 30 days, matching the read path

export async function POST(request: Request): Promise<Response> {
  const unauthorized = cronUnauthorized(request);
  if (unauthorized) return unauthorized;

  // Lease 70s > maxDuration 60s (the maxDuration + 10 convention). Inline literals
  // so the static lease check can see them.
  if (!(await acquireCronLock("sweep-landing-promote", 70))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const now = Date.now();
    const fromIso = new Date(now - WINDOW_MS).toISOString();
    const toIso = new Date(now).toISOString();

    // Only LIVE pages with auto-promote on and no winner yet are candidates. This is
    // the exact eligibility predicate the read path applies (maybeAutoPromote also
    // re-checks it on fresh state), so already-promoted / manual / archived pages are
    // skipped and never have a summary computed for them.
    const pages = await listPages(CLIENT_ID);
    const candidates = pages.filter((p) => p.status === "live" && p.autoPromote && !p.winnerVariant);

    let promoted = 0;
    const results: Array<{ slug: string; promoted: boolean; winner?: string; reason: string }> = [];
    for (const page of candidates) {
      const variants = await funnelVariantSummary({
        clientId: CLIENT_ID,
        surface: "landing",
        fromIso,
        toIso,
        landingSlug: page.slug,
      });
      const outcome = await maybeAutoPromote(CLIENT_ID, page.slug, variants);
      if (outcome.promoted) {
        promoted += 1;
        results.push({ slug: page.slug, promoted: true, winner: outcome.winner, reason: outcome.reason });
      } else {
        results.push({ slug: page.slug, promoted: false, reason: outcome.reason });
      }
    }

    return Response.json({ ok: true, scanned: candidates.length, promoted, results });
  } catch {
    return Response.json({ ok: false, error: "landing promote sweep failed" }, { status: 500 });
  } finally {
    await releaseCronLock("sweep-landing-promote");
  }
}

// Cron triggers with GET; reuse the same handler (matches the other app sweeps).
export const GET = POST;
