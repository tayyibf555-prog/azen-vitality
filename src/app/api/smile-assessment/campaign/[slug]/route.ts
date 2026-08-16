import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import {
  getActiveCampaignBySlug,
  getCampaignBySlug,
  setCampaignStatus,
  setCampaignTheme,
  setCampaignFollowUp,
  FollowUpColumnsMissingError,
  FollowUpTemplateRejectedError,
  ThemeColumnMissingError,
} from "@/lib/smile-assessment/campaign-repository";
import { toPublicCampaign, type CampaignStatus } from "@/lib/smile-assessment/campaign";
import {
  FOLLOW_UP_TRIGGERS,
  describeFollowUpTemplateFailures,
  isFollowUpTrigger,
  normaliseFollowUpTemplate,
  validateFollowUpTemplate,
  type FollowUpTrigger,
} from "@/lib/smile-assessment/follow-up";
import { PALETTE_KEYS, isPaletteKey } from "@/lib/assess/palette";
import { ownsCustomTheme } from "@/lib/assess/custom-theme-repository";

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

  // FIVE INDEPENDENT FIELDS, EACH OPTIONAL, AT LEAST ONE REQUIRED.
  //
  // Pausing an assessment, re-colouring it and changing how it follows enquiries
  // up are unrelated acts, and the caller must be able to do any one without
  // restating the others: an absent `status` has to mean "leave it running", not
  // "default it to active". So presence is read off the body, not off the value —
  // which is also why `theme: null` (the deliberate "put it back to the default
  // look") and `followUpTemplate: null` ("go back to a drafted message") are
  // distinguishable from fields that were never mentioned.
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const hasStatus = has("status");
  const hasTheme = has("theme");
  const hasFollowUpEnabled = has("followUpEnabled");
  const hasFollowUpTrigger = has("followUpTrigger");
  const hasFollowUpTemplate = has("followUpTemplate");
  const hasFollowUp = hasFollowUpEnabled || hasFollowUpTrigger || hasFollowUpTemplate;
  if (!hasStatus && !hasTheme && !hasFollowUp) {
    return bad("status, theme or a follow-up field is required");
  }

  const status = body.status;
  if (hasStatus && status !== "active" && status !== "paused") {
    return bad("status must be active or paused");
  }

  // The SAME two questions the create route asks, in the same order: is it a key
  // the catalogue knows, and failing that, is it a custom theme THIS practice owns
  // (0081)? An unrecognised value must not reach a public page's style attribute,
  // and another practice's theme id must not reach this campaign.
  //
  // `theme: null` stays distinguishable from an absent theme and means "back to the
  // default look" — the reason presence is read off the body above.
  const theme = body.theme;
  if (
    hasTheme &&
    theme !== null &&
    !isPaletteKey(theme) &&
    !(typeof theme === "string" && (await ownsCustomTheme(client.id, theme)))
  ) {
    return bad(`theme must be null, one of your own colour schemes, or one of: ${PALETTE_KEYS.join(", ")}`);
  }

  // THE FOLLOW-UP SETTINGS (0082). Validated at the door, in the order an owner
  // would find useful: the switch, then when it fires, then the wording — because
  // the wording is the only one whose refusal needs a paragraph.
  //
  // THE TEMPLATE IS CHECKED HERE SO THIS CAN ANSWER 400 WITH THE WHOLE LIST, and
  // checked AGAIN inside setCampaignFollowUp because that is the one place the
  // column is written. Same doctrine as the funnel PUT and updateCampaignFlow: the
  // route reports, the repository refuses. The scan is deliberately stricter than
  // the funnel's — it also runs the SEND path's own guardrail — because a hit
  // there is terminal for the lead rather than merely unpublishable.
  const followUpEnabled = body.followUpEnabled;
  if (hasFollowUpEnabled && typeof followUpEnabled !== "boolean") {
    return bad("followUpEnabled must be true or false");
  }

  const followUpTrigger = body.followUpTrigger;
  if (hasFollowUpTrigger && !isFollowUpTrigger(followUpTrigger)) {
    return bad(`followUpTrigger must be one of: ${FOLLOW_UP_TRIGGERS.join(", ")}`);
  }

  const followUpTemplate = body.followUpTemplate;
  if (hasFollowUpTemplate && followUpTemplate !== null) {
    if (typeof followUpTemplate !== "string") {
      return bad("followUpTemplate must be a message, or null to let us write it");
    }
    const checked = validateFollowUpTemplate(followUpTemplate);
    if (!checked.ok) {
      return bad(
        `This follow-up message cannot be saved:\n${describeFollowUpTemplateFailures(checked.failures)}`,
      );
    }
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

  if (hasFollowUp) {
    try {
      await setCampaignFollowUp(campaign.id, client.id, {
        // Presence, again, all the way down: an omitted key is not sent, so the
        // repository's own `!== undefined` checks leave the stored value alone.
        ...(hasFollowUpEnabled ? { enabled: followUpEnabled as boolean } : {}),
        ...(hasFollowUpTrigger ? { trigger: followUpTrigger as FollowUpTrigger } : {}),
        ...(hasFollowUpTemplate ? { template: followUpTemplate as string | null } : {}),
      });
    } catch (e) {
      // 0082 not applied on this deployment. Named, not swallowed: here the
      // follow-up IS the request, so a toggle that silently never takes would be
      // worse than an error naming the file to run.
      if (e instanceof FollowUpColumnsMissingError) return bad(e.message, 503);
      // The repository refused the wording. Unreachable via this route (the same
      // validator ran above), and reported rather than 500'd because the sentence
      // it carries is the one the owner needs.
      if (e instanceof FollowUpTemplateRejectedError) return bad(e.message);
      throw e;
    }
  }

  return Response.json({
    ok: true,
    status: hasStatus ? status : campaign.status,
    theme: hasTheme ? theme : campaign.theme,
    // Echoed only when they were part of the request, for the same reason the
    // write is: this route never restates a field the caller did not send.
    ...(hasFollowUpEnabled ? { followUpEnabled } : {}),
    ...(hasFollowUpTrigger ? { followUpTrigger } : {}),
    ...(hasFollowUpTemplate
      ? { followUpTemplate: normaliseFollowUpTemplate(followUpTemplate) }
      : {}),
  });
}
