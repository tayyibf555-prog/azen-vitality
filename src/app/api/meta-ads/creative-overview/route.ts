import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getClient } from "@/lib/mock";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { buildOverviewPrompt, cleanCopy } from "@/lib/meta-ads/ai";
import { MOCK_AD_LIBRARY } from "@/lib/meta-ads/mock";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface Pattern {
  title: string;
  insight: string;
}
interface Overview {
  patterns: Pattern[];
  whatToTry: string[];
  cautions: string[];
}

// AI overview of the winning-ads library: the recurring patterns, what to try, and
// UK compliance cautions. Authed members only (spends a model call). Reads the
// curated library today; swap MOCK_AD_LIBRARY for the live Meta Ad Library later.
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

  const { system, user } = buildOverviewPrompt(MOCK_AD_LIBRARY, client.name);
  try {
    const anthropic = new Anthropic({ maxRetries: 1 });
    const msg = await anthropic.messages.create(
      { model: SONNET, thinking: NO_THINKING, max_tokens: 2000, system, messages: [{ role: "user", content: user }] },
      { timeout: 20000 },
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return Response.json({ ok: false, error: "could not generate overview" }, { status: 502 });
    const parsed = JSON.parse(match[0]) as Partial<Overview>;
    const overview: Overview = {
      patterns: Array.isArray(parsed.patterns)
        ? parsed.patterns
            .filter((p): p is Pattern => !!p && typeof p === "object")
            .map((p) => ({ title: cleanCopy(String(p.title ?? "")), insight: cleanCopy(String(p.insight ?? "")) }))
            .filter((p) => p.title && p.insight)
        : [],
      whatToTry: Array.isArray(parsed.whatToTry)
        ? parsed.whatToTry.map((s) => cleanCopy(String(s))).filter(Boolean)
        : [],
      cautions: Array.isArray(parsed.cautions)
        ? parsed.cautions.map((s) => cleanCopy(String(s))).filter(Boolean)
        : [],
    };
    if (overview.patterns.length === 0) return Response.json({ ok: false, error: "empty overview" }, { status: 502 });
    return Response.json({ ok: true, overview });
  } catch {
    return Response.json({ ok: false, error: "overview unavailable" }, { status: 500 });
  }
}
