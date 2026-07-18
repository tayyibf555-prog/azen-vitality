import { getClient } from "@/lib/mock";
import { requireUser, requireClientAccess, requireOwnerRole, requireSiteAccess } from "@/lib/auth/guard";
import { metaConnection } from "@/lib/meta-ads/connection";
import { getMetaCampaign, recordPublishResult } from "@/lib/meta-ads/repository";
import { publishCampaign } from "@/lib/meta-ads/publish";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Owner-only path to publish a saved campaign to Meta, creating everything in PAUSED
// status (the client activates it in Ads Manager). Mirrors the co-pilot publish tool but
// for the UI. Honest throughout: when Meta is not connected it refuses without pretending
// anything went live; on a Graph error it returns the error and the campaign stays ready.
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON" }, { status: 400 });
  }

  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;

  const campaignId = typeof body.campaignId === "string" ? body.campaignId.trim() : "";
  if (!campaignId) return Response.json({ ok: false, error: "campaignId is required" }, { status: 400 });

  const campaign = await getMetaCampaign(campaignId);
  if (!campaign) return Response.json({ ok: false, error: "No campaign matches that id." }, { status: 404 });
  // IDOR guard: only ever act on THIS client's campaigns.
  if (campaign.clientId !== client.id) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  // Site scope: an enforced user must be able to act on the campaign's site.
  if (campaign.siteId) {
    const siteDenied = requireSiteAccess(auth, campaign.siteId);
    if (siteDenied) return siteDenied;
  }

  // HONESTY GATE: no connection => refuse without publishing. Nothing goes live.
  const connection = metaConnection(client.id);
  if (!connection.connected) {
    return Response.json({
      ok: false,
      published: false,
      reason: "meta_not_connected",
      message:
        "This campaign is ready, but the practice's Meta account is not connected, so it cannot be published yet. Connect it, then try again. Nothing has gone live.",
    });
  }

  // Create on Meta in PAUSED status.
  const result = await publishCampaign(campaign, connection);
  await recordPublishResult(campaign.id, {
    ok: result.ok,
    metaCampaignRef: result.metaCampaignRef,
    metaAdsetRef: result.metaAdsetRef,
    metaAdRef: result.metaAdRef,
    error: result.error,
    note: result.note,
  });

  if (!result.ok) {
    return Response.json({
      ok: false,
      published: false,
      reason: "publish_failed",
      error: result.error,
      message: `Meta could not create the campaign: ${result.error} Nothing is live; the campaign is still ready to retry.`,
    });
  }

  return Response.json({
    ok: true,
    published: true,
    status: "paused_on_meta",
    campaignId: campaign.id,
    metaCampaignRef: result.metaCampaignRef,
    metaAdsetRef: result.metaAdsetRef,
    metaAdRef: result.metaAdRef,
    notes: result.notes,
    message:
      "Created on Meta in PAUSED status. Review and activate it in Meta Ads Manager; nothing is spending until you do.",
  });
}
