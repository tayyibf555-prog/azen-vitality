import { getClient } from "@/lib/mock";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { MOCK_AD_LIBRARY } from "@/lib/meta-ads/mock";
import { generateBrandedCreative, higgsfieldConfigured } from "@/lib/creative/higgsfield";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// "Generate branded image" for a creative, via the Higgsfield seam. Owner-only.
//
// SHIPS DORMANT: the Higgsfield client is a typed seam that throws until the real
// endpoint is wired (see lib/creative/higgsfield.ts). This route stays honest about
// that: key absent -> 400 "not configured"; key present but seam unwired -> 503 with
// a clear message. The UI reflects the same state (it only shows the generate button
// when the key is present, and surfaces the message on failure).

// Placeholder brand palette (the platform blues) until the practice's real brand
// colours are captured. Passed to Higgsfield so a generated image stays on-brand.
const BRAND_COLOURS = ["#16559a", "#4a97d4"];

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

  const creativeRef = typeof body.creativeRef === "string" ? body.creativeRef : "";
  const ad = MOCK_AD_LIBRARY.find((a) => a.id === creativeRef);
  if (!ad) return Response.json({ ok: false, error: "unknown creative" }, { status: 404 });

  // Quiet, honest state when the integration is not configured.
  if (!higgsfieldConfigured()) {
    return Response.json(
      { ok: false, error: "Image generation activates when the Higgsfield key is added." },
      { status: 400 },
    );
  }

  const prompt = [
    `On-brand dental marketing image for ${ad.treatment}.`,
    `Angle: ${ad.hookType}.`,
    "Clean, professional, warm and reassuring. No text or logos in the image.",
  ].join(" ");

  try {
    const result = await generateBrandedCreative({
      prompt,
      brand: { name: client.name, colours: BRAND_COLOURS },
      format: ad.format,
    });
    return Response.json({ ok: true, image: result });
  } catch (err) {
    // Dormant seam (or a real failure): surface the message honestly.
    const message = err instanceof Error ? err.message : "Image generation is unavailable right now.";
    return Response.json({ ok: false, error: message }, { status: 503 });
  }
}
