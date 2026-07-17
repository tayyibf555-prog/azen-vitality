import { requireUser, requireOwnerRole, requireClientAccess } from "@/lib/auth/guard";
import { getCampaign } from "@/lib/outreach/repository";

export const dynamic = "force-dynamic";

/**
 * GET /api/outreach/campaigns/[id]/progress
 *
 * A tiny, cheap poll source for the build UI: it reads only the campaign row's cached
 * counts + build_cursor (no target scan), so the "New campaign" flow can show pages
 * walked and matched count while the resumable build ticks. Owner-gated like the rest.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const ownerOnly = requireOwnerRole(user);
  if (ownerOnly) return ownerOnly;

  const { id } = await params;
  const campaign = await getCampaign(id);
  if (!campaign) return Response.json({ ok: false, error: "campaign not found" }, { status: 404 });
  const denied = requireClientAccess(user, campaign.clientId);
  if (denied) return denied;

  const cursor = campaign.buildCursor;
  return Response.json({
    ok: true,
    status: campaign.status,
    done: cursor?.done ?? false,
    // Pages walked so far (1-based cursor page minus the current unfinished one) and
    // the running match/scan tallies, straight off the cached counters.
    pagesWalked: cursor ? Math.max(0, cursor.page - 1) : 0,
    scanned: cursor?.scanned ?? campaign.counts?.scanned ?? 0,
    matched: cursor?.matched ?? campaign.counts?.matched ?? 0,
    enrolled: campaign.counts?.enrolled ?? 0,
    counts: campaign.counts ?? {},
    cursor,
  });
}
