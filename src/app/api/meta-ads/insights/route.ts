import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { metaConnection } from "@/lib/meta-ads/connection";
import { listPublishedMetaCampaigns, insertMetaCampaignInsight } from "@/lib/meta-ads/repository";
import { fetchCampaignInsights } from "@/lib/meta-ads/metrics";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Hourly Meta insights sweep. For every PUBLISHED campaign (created on Meta, paused) it
// pulls the latest lifetime figures (spend, impressions, clicks, leads) into
// meta_campaign_insight. It is READ-ONLY: no spend, no send, no patient contact, so it is
// gated ONLY on the Meta connection, never on a kill switch.
//
// Ships DORMANT: metaConnection() is not-connected until the client's Meta account links,
// so today this is an honest no-op that captures nothing. Register it on pg_cron with
// supabase/ops/register-meta-insights-cron.sql on activation day.

// Single-client pilot; every Meta campaign belongs to Vitality (matches the outreach sweep).
const CLIENT_ID = "vitality";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // fail-closed in production
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  // HONEST NO-OP when not connected: no Meta account, nothing published, nothing to pull.
  const connection = metaConnection(CLIENT_ID);
  if (!connection.connected) {
    return Response.json({ ok: true, connected: false, skipped: "meta_not_connected", captured: 0 });
  }

  // Never overlap another insights run (pg_cron can double-fire). The lease outlives
  // maxDuration so a slow run cannot be lapped; a crashed run self-heals when it expires.
  if (!(await acquireCronLock("sweep-meta-insights", 310))) {
    return Response.json({ ok: true, skipped: "another run in progress" });
  }

  try {
    const campaigns = await listPublishedMetaCampaigns(CLIENT_ID);
    let captured = 0;
    let failed = 0;
    for (const campaign of campaigns) {
      if (!campaign.metaCampaignRef) continue;
      // Isolate each campaign: one campaign's Graph error must not abort the others.
      try {
        const insight = await fetchCampaignInsights(campaign.metaCampaignRef, connection);
        await insertMetaCampaignInsight({
          campaignId: campaign.id,
          spendGbp: insight.spendGbp,
          impressions: insight.impressions,
          clicks: insight.clicks,
          leads: insight.leads,
          raw: insight.raw,
        });
        captured += 1;
      } catch (err) {
        failed += 1;
        console.error(`[meta-insights] pull failed for campaign ${campaign.id}; skipping`, err);
      }
    }
    return Response.json({ ok: true, connected: true, campaigns: campaigns.length, captured, failed });
  } finally {
    await releaseCronLock("sweep-meta-insights");
  }
}

// pg_cron / Vercel Cron triggers with GET; reuse the same handler.
// EVERY Dentally read inside this handler is BACKGROUND work against the practice's
// shared 3,600/hour budget (src/lib/dentally/budget.ts): it is starved first, at 60%
// consumption, so a bulk sweep can never be the reason a practice manager's screen or
// a patient's booking calendar goes blank. A refusal aborts this run; the next tick
// retries. Pinned by src/lib/dentally/budget-priority-coverage.test.ts.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("background", () => handleWithDentallyPriority(request));
}

export const GET = POST;
