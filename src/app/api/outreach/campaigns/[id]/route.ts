import { getClient } from "@/lib/mock/clients";
import { requireUser, requireOwnerRole, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { dentallyReadKey } from "@/lib/dentally/read";
import {
  getCampaign,
  updateCampaign,
  listTargetsByCampaign,
  campaignStatusCounts,
} from "@/lib/outreach/repository";
import { runOutreachBuildTick } from "@/lib/outreach/build";
import { isSystemEnabled } from "@/lib/systems/repository";
import { recordUsage } from "@/lib/telemetry";
import type { OutreachCampaign } from "@/lib/outreach/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PREVIEW_TARGET_LIMIT = 100;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * Mask the middle digits of a phone so the UI shows enough for RECOGNITION but never
 * the full number: keep the first 3 and last 2 characters, dot out the rest. Local
 * (not exported) because a route module may only export route handlers + config.
 */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const p = phone.trim();
  if (p.length <= 5) return p;
  return `${p.slice(0, 3)}${"•".repeat(p.length - 5)}${p.slice(-2)}`;
}

/**
 * Owner-gate + resolve the campaign, checking the caller may access its client. On any
 * failure returns a Response; on success returns { auth, campaign }.
 */
async function loadGuarded(
  id: string,
): Promise<Response | { auth: AuthedUser | null; campaign: OutreachCampaign }> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  const ownerOnly = requireOwnerRole(user);
  if (ownerOnly) return ownerOnly;

  const campaign = await getCampaign(id);
  if (!campaign) return bad("campaign not found", 404);
  const denied = requireClientAccess(user, campaign.clientId);
  if (denied) return denied;
  return { auth: user, campaign };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await loadGuarded(id);
  if (guard instanceof Response) return guard;
  const { campaign } = guard;

  const [targets, counts] = await Promise.all([
    listTargetsByCampaign(campaign.id, { limit: PREVIEW_TARGET_LIMIT }),
    campaignStatusCounts(campaign.id),
  ]);

  return Response.json({
    ok: true,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      siteId: campaign.siteId,
      status: campaign.status,
      filters: campaign.filters,
      practitionerId: campaign.practitionerId,
      practitionerName: campaign.practitionerName,
      messageAngle: campaign.messageAngle,
      dailyCap: campaign.dailyCap,
      buildCursor: campaign.buildCursor,
      counts: campaign.counts,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
    },
    statusCounts: counts,
    // The headline is the honest matched/enrolled total, not just the previewed slice.
    matched: counts.built,
    previewLimit: PREVIEW_TARGET_LIMIT,
    targets: targets.map((t) => ({
      id: t.id,
      name: t.name,
      phoneMasked: maskPhone(t.phone),
      matchedReason: t.matchedReason,
      status: t.status,
    })),
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const guard = await loadGuarded(id);
  if (guard instanceof Response) return guard;
  const { auth, campaign } = guard;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const action = typeof body.action === "string" ? body.action : "";

  switch (action) {
    case "start-build": {
      // Delegate to the shared build machinery (one bounded tick). The client
      // re-invokes until `done`, mirroring the resumable cron builder.
      if (!dentallyReadKey()) return Response.json({ ok: false, error: "DENTALLY_API_KEY not set" }, { status: 503 });
      const result = await runOutreachBuildTick(campaign);
      return Response.json(result, { status: result.ok ? 200 : 500 });
    }

    case "launch": {
      // Launch is only valid from a fully built campaign, and is REFUSED while the
      // outreach system is switched off (its default). The send path is separately
      // fail-closed on the same switch; refusing here gives the owner a clear reason
      // and a place to turn it on rather than a silently inert 'running' campaign.
      if (campaign.status !== "ready") {
        return bad(
          `This campaign is ${campaign.status}, so it cannot be launched. Only a fully built (ready) campaign can go live.`,
          409,
        );
      }
      // A campaign must have a message angle (what the invite is about) before it can
      // send. It is optional at draft (a list preview), enforced here at launch.
      if (!campaign.messageAngle || !campaign.messageAngle.trim()) {
        return bad(
          "This campaign has no message angle yet, so it cannot be launched. Set what the invite is about, then launch.",
          409,
        );
      }
      if (!(await isSystemEnabled(campaign.clientId, "outreach"))) {
        return Response.json(
          {
            ok: false,
            error: "outreach_off",
            message:
              "Segment outreach is switched off, so nothing can be launched yet. Turn it on in Operations, System controls, then launch.",
          },
          { status: 409 },
        );
      }
      await updateCampaign(campaign.id, { status: "running" });
      void recordUsage("outreach", "campaign_launch", {
        clientId: campaign.clientId,
        userEmail: auth?.email ?? null,
        role: auth?.role ?? null,
      });
      return Response.json({ ok: true, status: "running" });
    }

    case "pause": {
      if (campaign.status !== "running") {
        return bad(`Only a running campaign can be paused (this one is ${campaign.status}).`, 409);
      }
      await updateCampaign(campaign.id, { status: "paused" });
      return Response.json({ ok: true, status: "paused" });
    }

    case "resume": {
      if (campaign.status !== "paused") {
        return bad(`Only a paused campaign can be resumed (this one is ${campaign.status}).`, 409);
      }
      // Resuming re-enters 'running'; the sweep still honours the kill switch, so a
      // resume while outreach is off queues nothing until it is switched back on.
      await updateCampaign(campaign.id, { status: "running" });
      return Response.json({ ok: true, status: "running" });
    }

    default:
      return bad("action must be one of: start-build, launch, pause, resume");
  }
}
