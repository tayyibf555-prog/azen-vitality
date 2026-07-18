import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getClient } from "@/lib/mock";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { MOCK_AD_LIBRARY } from "@/lib/meta-ads/mock";
import { resolveAnalysis, type CallModel } from "@/lib/creative/resolve";
import { creativeAnalysisCache } from "@/lib/creative/cache";
import { isHiggsfieldConfigured } from "@/lib/higgsfield/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// AI analysis for ONE creative in the winning-ads library. Owner-only members of the
// client (it can spend a model call). Returns a cached analysis when one exists, else
// generates once and stores it; `regenerate: true` forces a fresh one. The analysis
// is assembled server-side from ONLY the ad's real attributes, with score, verdict,
// longevity signal, cost-per-lead and compliance flags computed deterministically in
// code (see lib/creative/analysis.ts). Reads the curated MOCK library today; swap for
// the live Meta Ad Library later without changing this route's shape.
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
  if (!creativeRef) return Response.json({ ok: false, error: "creativeRef is required" }, { status: 400 });
  const ad = MOCK_AD_LIBRARY.find((a) => a.id === creativeRef);
  if (!ad) return Response.json({ ok: false, error: "unknown creative" }, { status: 404 });

  const regenerate = body.regenerate === true;

  // Real model call, injected into the pure orchestrator. Empty replies are treated
  // as unusable (the orchestrator falls back to the deterministic Quick read).
  const callModel: CallModel = async (system, user) => {
    const anthropic = new Anthropic({ maxRetries: 1 });
    const msg = await anthropic.messages.create(
      { model: SONNET, thinking: NO_THINKING, max_tokens: 1200, system, messages: [{ role: "user", content: user }] },
      { timeout: 22000 },
    );
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };

  try {
    const { analysis, cached } = await resolveAnalysis({
      ad,
      clientId: client.id,
      regenerate,
      callModel,
      cache: creativeAnalysisCache,
      modelId: SONNET,
    });
    return Response.json({
      ok: true,
      analysis,
      cached,
      // The library is not yet from a live Meta connection.
      sample: true,
      // Drives the "Recreate with your branding" state in the detail view.
      imageGen: { available: isHiggsfieldConfigured() },
    });
  } catch {
    return Response.json({ ok: false, error: "analysis unavailable" }, { status: 500 });
  }
}
