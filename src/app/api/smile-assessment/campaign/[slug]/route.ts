import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  getActiveCampaignBySlug,
  getCampaignBySlug,
  setCampaignStatus,
} from "@/lib/smile-assessment/campaign-repository";
import { toPublicCampaign, type CampaignStatus } from "@/lib/smile-assessment/campaign";

export const dynamic = "force-dynamic";

// GET  — PUBLIC. The landing page fetches the campaign by (?client, slug). Returns
//        ONLY safe public fields, and 404s for missing/paused so a paused ad link
//        cannot keep capturing. No auth (the parent /api is excluded from the proxy).
// PATCH — guarded (requireUser + requireClientAccess). Pause/activate a campaign.

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const clientSlug = new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const campaign = await getActiveCampaignBySlug(client.id, slug);
  if (!campaign) return bad("Assessment not found", 404);

  return Response.json({ ok: true, campaign: toPublicCampaign(campaign) });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const { slug } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const clientSlug =
    (typeof body.clientSlug === "string" ? body.clientSlug.trim() : "") ||
    new URL(request.url).searchParams.get("client") ||
    "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const status = body.status;
  if (status !== "active" && status !== "paused") return bad("status must be active or paused");

  const campaign = await getCampaignBySlug(client.id, slug);
  if (!campaign) return bad("Assessment not found", 404);

  await setCampaignStatus(campaign.id, client.id, status as CampaignStatus);
  return Response.json({ ok: true, status });
}
