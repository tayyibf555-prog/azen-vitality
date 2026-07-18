import { randomUUID } from "node:crypto";
import { getClient } from "@/lib/mock";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { MOCK_AD_LIBRARY } from "@/lib/meta-ads/mock";
import { findTreatment } from "@/lib/treatments/catalog";
import { scanBannedText } from "@/lib/landing/compliance";
import { buildRecreatePrompt, PLACEHOLDER_BRAND_COLOURS } from "@/lib/creative/recreate";
import { generateImage, isHiggsfieldConfigured, aspectRatioForFormat } from "@/lib/higgsfield/client";
import {
  insertRender,
  markRenderComplete,
  markRenderFailed,
  listRenders,
  type CreativeRender,
} from "@/lib/creative/renders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// "Recreate this ad with your branding" for a library creative, via the Higgsfield
// image client. Owner-only members of the client (it can spend a generation).
//
// The prompt is built from the practice's REAL facts (name, real locations, the real
// treatment and, only when the owner opts in, the real catalogue "from" price). It is
// run through the SAME banned-text lint the landing pages use, so a non-compliant
// claim can never be baked into an image request. Every attempt is recorded as a
// creative_render row (migration 0053) for an honest per-practice history.
//
// SHIPS DORMANT: when HIGGSFIELD_API_KEY is absent the route records a not_configured
// row and returns the honest "add the key to enable" message. It never fabricates an
// image and surfaces real failures honestly. Reads the curated MOCK ad library today;
// swap for the live Meta Ad Library later without changing this route's shape.

const NOT_CONFIGURED_MESSAGE =
  "Recreating an ad with your branding activates when the HIGGSFIELD_API_KEY is added. The prompt has been prepared from your real practice details and is ready to run once the key is in place.";

/** Shared owner-only guard chain. Returns the client + auth, or a Response to return. */
async function guard(
  clientSlug: string,
): Promise<Response | { client: NonNullable<ReturnType<typeof getClient>>; createdBy: string | null }> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const client = getClient(clientSlug);
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const roleDenied = requireOwnerRole(auth);
  if (roleDenied) return roleDenied;
  return { client, createdBy: auth?.id ?? null };
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Response.json({ ok: false, error: "Request body must be valid JSON" }, { status: 400 });
  }

  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const gate = await guard(clientSlug);
  if (gate instanceof Response) return gate;
  const { client, createdBy } = gate;

  const creativeRef = typeof body.creativeRef === "string" ? body.creativeRef : "";
  const ad = MOCK_AD_LIBRARY.find((a) => a.id === creativeRef);
  if (!ad) return Response.json({ ok: false, error: "unknown creative" }, { status: 404 });

  const angleNotes =
    typeof body.angleNotes === "string" ? body.angleNotes.slice(0, 400) : undefined;
  const includeFromPrice = body.includeFromPrice === true;

  // Resolve the REAL treatment + catalogue price; fall back to the ad's label with no
  // price when the treatment is not in our catalogue (we never show a price we cannot
  // verify).
  const treatment = findTreatment(ad.treatment);
  const treatmentName = treatment?.name ?? ad.treatment;
  const fromPriceGBP = treatment?.priceFrom ?? null;

  const prompt = buildRecreatePrompt({
    practiceName: client.name,
    brandColours: PLACEHOLDER_BRAND_COLOURS,
    locationsLine: client.facts?.locationsLine ?? null,
    treatmentName,
    fromPriceGBP,
    angle: ad.hookType,
    angleNotes,
    format: ad.format,
    includeFromPrice,
  });

  // Hard compliance gate: the FINAL prompt (template + any owner angle notes) must
  // carry no banned claim, or it is refused before anything is generated or stored.
  const hits = scanBannedText(prompt);
  if (hits.length > 0) {
    return Response.json(
      {
        ok: false,
        error: `This request was blocked by the compliance check: it contains "${hits[0].matched}". Adjust the angle notes and try again.`,
        failures: hits,
      },
      { status: 400 },
    );
  }

  const base: CreativeRender = {
    id: randomUUID(),
    clientId: client.id,
    sourceRef: creativeRef,
    prompt,
    status: "pending",
    imageUrl: null,
    error: null,
    createdBy,
    createdAt: new Date().toISOString(),
  };

  // Dormant: record an honest not_configured row and return the honest message.
  if (!isHiggsfieldConfigured()) {
    const render: CreativeRender = { ...base, status: "not_configured" };
    await insertRender(render);
    return Response.json({
      ok: false,
      status: "not_configured",
      message: NOT_CONFIGURED_MESSAGE,
      render,
    });
  }

  await insertRender(base);
  const result = await generateImage(prompt, { aspectRatio: aspectRatioForFormat(ad.format) });

  if (result.status === "complete") {
    await markRenderComplete(base.id, result.imageUrl);
    return Response.json({
      ok: true,
      status: "complete",
      render: { ...base, status: "complete", imageUrl: result.imageUrl },
    });
  }

  if (result.status === "not_configured") {
    // Defensive: configured() was true above, but never fabricate on a race.
    return Response.json({
      ok: false,
      status: "not_configured",
      message: NOT_CONFIGURED_MESSAGE,
      render: { ...base, status: "not_configured" },
    });
  }

  await markRenderFailed(base.id, result.error);
  return Response.json(
    { ok: false, status: "failed", error: result.error, render: { ...base, status: "failed", error: result.error } },
    { status: 503 },
  );
}

// Past renders for a practice, newest first. Owner-only, scoped to the client.
export async function GET(request: Request): Promise<Response> {
  const clientSlug = new URL(request.url).searchParams.get("clientSlug") ?? "";
  const gate = await guard(clientSlug);
  if (gate instanceof Response) return gate;
  const { client } = gate;

  const renders = await listRenders(client.id);
  return Response.json({ ok: true, renders });
}
