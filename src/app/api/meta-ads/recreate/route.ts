import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getClient } from "@/lib/mock";
import {
  requireUser,
  requireClientAccess,
  requireModuleApiAccess,
  requireOwnerRole,
} from "@/lib/auth/guard";
import { consumeBudget } from "@/lib/rate-budget";
import { isSystemEnabledStrict } from "@/lib/systems/repository";
import { scanBannedText } from "@/lib/landing/compliance";
import { getWinningAdById } from "@/lib/meta-ads/winning-repository";
import { createMetaCampaign } from "@/lib/meta-ads/repository";
import {
  recreateAdCopy,
  resolveRecreateTreatment,
  buildBrandImagePrompt,
  type RecreateFailure,
} from "@/lib/meta-ads/recreate";
import {
  generateCreative,
  isImageGenConfigured,
  NOT_CONFIGURED_MESSAGE,
  type ImageGenResult,
} from "@/lib/meta-ads/image-gen";

export const dynamic = "force-dynamic";
// Two model calls (generate, then at most one repair) plus an image generation.
export const maxDuration = 120;

// ===========================================================================
// RECREATE A WINNING AD FOR VITALITY.
//
// The winning-ads library holds 120 real competitor ads scraped from the public
// Meta Ad Library. This route takes ONE of them by id and produces an ORIGINAL
// Vitality ad inspired by its STRUCTURE only, plus (optionally) an original
// creative, and lands the pair as a DRAFT in the campaign builder.
//
// ---------------------------------------------------------------------------
// WHAT IT WILL NOT DO, and why each is structural rather than a promise.
// ---------------------------------------------------------------------------
//
// IT NEVER PUBLISHES. Publishing lives in its own route, behind the practice's
// Meta account. This file does not import that module, writes the 'draft' status
// and no other, and writes none of the Meta reference columns. A draft is the
// ceiling, and the route's own test asserts that by scanning this file, so the
// tokens themselves are deliberately absent from the prose here too.
//
// IT NEVER REPRODUCES THE COMPETITOR. Two independent deterministic gates run
// inside `recreateAdCopy` on every candidate: the shared UK compliance scan
// (`scanBannedText`, the same one the landing pages must pass) and the echo guard
// (no shared figure, ranking, review claim, brand token or 6-word run). The
// seeded library really does contain "Save up to 70%", "the lowest in the UK,
// guaranteed", "Top 1% of Invisalign providers in Europe" and "Never feel any
// pain during your dental treatment"; none of it can reach a Vitality draft. On a
// failure the flow repairs ONCE and then BLOCKS, with the reasons. It never
// falls back to fabricated copy: an honest refusal is the safe outcome.
//
// IT NEVER TRUSTS THE SOURCE TEXT. The competitor's copy is third-party scraped
// prose, so `buildRecreatePrompt` sanitises it internally (controls, zero-width
// characters, role markers, instruction-shaped sentences, hard caps) before it
// can reach the model. The prompt template cannot be handed raw text.
//
// IT NEVER USES THE COMPETITOR'S IMAGE. The creative prompt is built from OUR
// original copy plus Vitality's own brand direction, and it is compliance-scanned
// once more before it is sent to any provider.
//
// IT NEVER FABRICATES A CREATIVE. With no image key the copy draft is still
// written and the creative comes back `not_configured` with the honest message
// naming the env var. No provider is called and nothing crashes.
//
// GUARDS: signed in, this practice, the meta-ads module, owner role, the meta-ads
// kill switch read STRICTLY (a switch we cannot read is OFF, because this route
// spends money), and two per-practice budgets: one for the copy, a tighter one
// for the image, each consumed before the thing it pays for is constructed.
// ===========================================================================

/** Copy budget: two Sonnet calls a go, so 40 an hour is a long afternoon of work. */
const COPY_BUDGET_LIMIT = 40;
/** Images cost an order of magnitude more, so they get their own, tighter cap. */
const IMAGE_BUDGET_LIMIT = 20;
const BUDGET_WINDOW_SECONDS = 3600;

/** Meta feed default. Portrait/landscape map through `gptImageSize` in image-gen. */
const DEFAULT_ASPECT_RATIO = "1:1";

/** The creative outcome as the UI sees it. Mirrors ImageGenResult plus our own skips. */
type CreativeReply =
  | { status: "complete"; provider: string; imageUrl: string }
  | { status: "not_configured"; provider: string | null; message: string }
  | { status: "failed"; provider: string | null; error: string }
  | { status: "skipped"; provider: null; message: string };

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON" }, { status: 400 });
  }

  // --- guards --------------------------------------------------------------
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const clientDenied = requireClientAccess(auth, client.id);
  if (clientDenied) return clientDenied;
  const moduleDenied = requireModuleApiAccess(auth, "meta-ads");
  if (moduleDenied) return moduleDenied;
  const ownerDenied = requireOwnerRole(auth);
  if (ownerDenied) return ownerDenied;

  // --- the kill switch, read strictly --------------------------------------
  // Meta Ads is a default-ON system, but this is its one SPENDING surface. A
  // toggle read that fails must not authorise a model call and an image bill, so
  // this uses the fail-CLOSED reader rather than the fail-open one.
  if (!(await isSystemEnabledStrict(client.id, "meta-ads"))) {
    return Response.json(
      {
        ok: false,
        status: "system_off",
        error: "Meta Ads is switched off for this practice, so nothing was generated.",
      },
      { status: 403 },
    );
  }

  // --- the source ad -------------------------------------------------------
  const adId = typeof body.adId === "string" ? body.adId.trim() : "";
  if (!adId) return Response.json({ ok: false, error: "adId is required" }, { status: 400 });
  let sourceAd;
  try {
    sourceAd = await getWinningAdById(adId);
  } catch (err) {
    console.error("[meta-ads/recreate] library read failed", err);
    return Response.json({ ok: false, error: "the ad library could not be read" }, { status: 502 });
  }
  if (!sourceAd) return Response.json({ ok: false, error: "unknown ad" }, { status: 404 });

  const treatmentKey = typeof body.treatmentKey === "string" ? body.treatmentKey : null;
  const treatment = resolveRecreateTreatment(sourceAd.keyword, treatmentKey);
  const wantImage = body.withImage !== false;

  // --- budget, then the copy ----------------------------------------------
  // Consumed before the Anthropic client is CONSTRUCTED, not merely before the
  // call: this button sits on 120 cards and gets pressed in bursts.
  if (!(await consumeBudget(`meta-recreate:${client.id}`, COPY_BUDGET_LIMIT, BUDGET_WINDOW_SECONDS))) {
    return Response.json(
      {
        ok: false,
        status: "rate_limited",
        error: "You have recreated a lot of ads in the past hour. Please try again shortly.",
      },
      { status: 429 },
    );
  }

  const anthropic = new Anthropic({ maxRetries: 1 });
  const callModel = async (system: string, user: string): Promise<string> => {
    const msg = await anthropic.messages.create(
      {
        model: SONNET,
        thinking: NO_THINKING,
        max_tokens: 700,
        system,
        messages: [{ role: "user", content: user }],
      },
      { timeout: 25_000 },
    );
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };

  const result = await recreateAdCopy({
    sourceAd,
    treatment,
    practiceName: client.name,
    callModel,
  });

  if (!result.ok && result.reason === "compliance") {
    return Response.json(
      {
        ok: false,
        status: "compliance_refused",
        message:
          "This ad could not be recreated compliantly. The version written kept reaching for the competitor's own claims, so nothing was saved.",
        failures: result.failures satisfies RecreateFailure[],
      },
      { status: 422 },
    );
  }
  if (!result.ok) {
    return Response.json(
      {
        ok: false,
        status: "model_unavailable",
        error: "The copywriter is unavailable just now. Nothing was saved. Please try again.",
      },
      { status: 503 },
    );
  }
  const copy = result.copy;

  // --- the creative --------------------------------------------------------
  // Built from OUR original copy and Vitality's brand direction, never from the
  // competitor's image, and scanned once more before any provider sees it.
  let creative: CreativeReply = {
    status: "skipped",
    provider: null,
    message: "No creative was requested, so only the ad copy was written.",
  };

  if (wantImage) {
    const imagePrompt = buildBrandImagePrompt({
      treatment,
      practiceName: client.name,
      locationsLine: client.facts?.locationsLine ?? null,
    });
    const promptHits = scanBannedText(imagePrompt);
    if (promptHits.length > 0) {
      creative = {
        status: "failed",
        provider: null,
        error: `The creative brief was blocked by the compliance check ("${promptHits[0].matched}"), so no image was generated. Your ad copy was still saved.`,
      };
    } else if (!isImageGenConfigured()) {
      // The honest dormant state: no provider is called at all.
      creative = { status: "not_configured", provider: null, message: NOT_CONFIGURED_MESSAGE };
    } else if (
      !(await consumeBudget(`meta-recreate-image:${client.id}`, IMAGE_BUDGET_LIMIT, BUDGET_WINDOW_SECONDS))
    ) {
      creative = {
        status: "failed",
        provider: null,
        error: "You have generated a lot of images in the past hour, so this one was skipped. Your ad copy was still saved.",
      };
    } else {
      const gen: ImageGenResult = await generateCreative({
        prompt: imagePrompt,
        aspectRatio: DEFAULT_ASPECT_RATIO,
      });
      creative =
        gen.status === "complete"
          ? { status: "complete", provider: gen.provider, imageUrl: gen.imageUrl }
          : gen.status === "not_configured"
            ? { status: "not_configured", provider: gen.provider, message: gen.message }
            : { status: "failed", provider: gen.provider, error: gen.error };
    }
  }

  const creativeImageUrl = creative.status === "complete" ? creative.imageUrl : null;

  // --- land it as a DRAFT --------------------------------------------------
  // status is 'draft', full stop. Nothing here can set 'ready' or 'published',
  // and no Meta reference is written.
  const draftInput = {
    clientId: client.id,
    siteId: null,
    name: `Recreated ad: ${treatment.name}`,
    treatment: treatment.name,
    objective: "leads" as const,
    status: "draft" as const,
    radiusMiles: null,
    dailyBudgetGbp: null,
    audienceNotes: null,
    transparentPricing: false,
    fromPriceGbp: null,
    negativeKeywords: [],
    landingSlug: null,
    copy,
    createdBy: auth?.id ?? null,
  };

  let campaign;
  let creativeNote: string | null = null;
  try {
    // The creative column ships in migration 0089. Omitting the key entirely when
    // there is no image keeps the insert byte-identical to a pre-0089 one.
    campaign = await createMetaCampaign(
      creativeImageUrl ? { ...draftInput, creativeImageUrl } : draftInput,
    );
  } catch (err) {
    if (!creativeImageUrl) {
      console.error("[meta-ads/recreate] draft insert failed", err);
      return Response.json({ ok: false, error: "the draft could not be saved" }, { status: 500 });
    }
    // Most likely cause: migration 0089 has not been applied on this database, so
    // the column does not exist. Save the copy rather than lose the whole run, and
    // say plainly that the image was not attached.
    console.error("[meta-ads/recreate] draft insert with creative failed; retrying without", err);
    try {
      campaign = await createMetaCampaign(draftInput);
      creativeNote =
        "The image was generated but could not be attached to the draft. Apply migration 0089 to store creatives.";
    } catch (err2) {
      console.error("[meta-ads/recreate] draft insert failed", err2);
      return Response.json({ ok: false, error: "the draft could not be saved" }, { status: 500 });
    }
  }

  return Response.json({
    ok: true,
    status: "draft_saved",
    campaign,
    copy,
    creative,
    creativeNote,
    treatment: { key: treatment.key, name: treatment.name },
    source: { adId: sourceAd.id, generatedFrom: result.source },
  });
}
