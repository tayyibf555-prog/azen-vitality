import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  getActiveCampaignBySlug,
  getCampaignBySlug,
  setCampaignStatus,
  setCampaignTheme,
  ThemeColumnMissingError,
} from "@/lib/smile-assessment/campaign-repository";
import { toPublicCampaign, type CampaignStatus } from "@/lib/smile-assessment/campaign";
import { PALETTE_KEYS, isPaletteKey } from "@/lib/assess/palette";

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
  // Smile Assessment is outside CLINICIAN_SLUGS: these are marketing campaigns and the
  // enquiry scores behind them. (The patient-facing next/submit/token routes are
  // separate and deliberately unauthenticated.)
  const moduleDenied = requireModuleApiAccess(auth, "smile-assessment");
  if (moduleDenied) return moduleDenied;

  // TWO INDEPENDENT FIELDS, EACH OPTIONAL, AT LEAST ONE REQUIRED.
  //
  // Pausing an assessment and re-colouring it are unrelated acts, and the caller
  // must be able to do either without restating the other: an absent `status`
  // has to mean "leave it running", not "default it to active". So presence is
  // read off the body, not off the value — which is also why `theme: null` (the
  // deliberate "put it back to the default look") is distinguishable from a
  // theme that was never mentioned.
  const hasStatus = Object.prototype.hasOwnProperty.call(body, "status");
  const hasTheme = Object.prototype.hasOwnProperty.call(body, "theme");
  if (!hasStatus && !hasTheme) return bad("status or theme is required");

  const status = body.status;
  if (hasStatus && status !== "active" && status !== "paused") {
    return bad("status must be active or paused");
  }

  // Same closed-list check as the create route, for the same reason: an
  // unrecognised key must not reach a public page's style attribute.
  const theme = body.theme;
  if (hasTheme && theme !== null && !isPaletteKey(theme)) {
    return bad(`theme must be null or one of: ${PALETTE_KEYS.join(", ")}`);
  }

  const campaign = await getCampaignBySlug(client.id, slug);
  if (!campaign) return bad("Assessment not found", 404);

  if (hasStatus) await setCampaignStatus(campaign.id, client.id, status as CampaignStatus);
  if (hasTheme) {
    try {
      await setCampaignTheme(campaign.id, client.id, theme as string | null);
    } catch (e) {
      // 0079 not applied on this deployment. Named, not swallowed: here the
      // colour IS the request (campaign-repository.ts, setCampaignTheme).
      if (e instanceof ThemeColumnMissingError) return bad(e.message, 503);
      throw e;
    }
  }

  return Response.json({
    ok: true,
    status: hasStatus ? status : campaign.status,
    theme: hasTheme ? theme : campaign.theme,
  });
}
