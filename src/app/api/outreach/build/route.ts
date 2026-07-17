import { dentallyReadKey } from "@/lib/dentally/read";
import { requireUser, requireOwnerRole, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { getCampaign } from "@/lib/outreach/repository";
import { runOutreachBuildTick } from "@/lib/outreach/build";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorizedByCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // fail-closed in production
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * POST /api/outreach/build  { campaignId }
 *
 * Resumable, bounded segment builder. Owner-only via requireUser, OR callable with
 * the CRON_SECRET (so a scheduled sweep can keep building a large campaign over
 * several ticks). The actual scan/match/enrol/persist is the shared build machinery
 * in @/lib/outreach/build (reused by the campaigns PATCH `start-build` action and the
 * co-pilot create tool), so every entrypoint scans identically. Progress persists on
 * the campaign's build_cursor so the next call resumes.
 */
export async function POST(request: Request): Promise<Response> {
  const cron = authorizedByCron(request);
  let authedUser: AuthedUser | null = null;
  if (!cron) {
    // Dashboard caller: must be a signed-in owner with access to the campaign's client.
    const user = await requireUser();
    if (user instanceof Response) return user;
    const ownerOnly = requireOwnerRole(user);
    if (ownerOnly) return ownerOnly;
    // requireUser returns null when auth is not enforced (pilot); the campaign's
    // client access is checked once it is loaded below.
    authedUser = user;
  }

  const apiKey = dentallyReadKey();
  if (!apiKey) return Response.json({ error: "DENTALLY_API_KEY not set" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { campaignId?: unknown } | null;
  const campaignId = typeof body?.campaignId === "string" ? body.campaignId : "";
  if (!campaignId) return Response.json({ error: "campaignId required" }, { status: 400 });

  const campaign = await getCampaign(campaignId);
  if (!campaign) return Response.json({ error: "campaign not found" }, { status: 404 });

  // Enforce client access for a dashboard caller (a cron caller is trusted).
  if (authedUser) {
    const forbidden = requireClientAccess(authedUser, campaign.clientId);
    if (forbidden) return forbidden;
  }

  const result = await runOutreachBuildTick(campaign);
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
