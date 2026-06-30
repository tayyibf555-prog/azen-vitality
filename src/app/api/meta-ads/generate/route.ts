import Anthropic from "@anthropic-ai/sdk";
import { SONNET } from "@/lib/ai/models";
import { getClient } from "@/lib/mock";
import { requireUser, requireClientAccess, requireOwnerRole } from "@/lib/auth/guard";
import { buildCopyPrompt, cleanCopy } from "@/lib/meta-ads/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Generate UK-compliant Meta ad copy for a treatment/offer. Authed members of the
// client only (it spends a model call). The prompt bakes in the GDC/ASA rules, so
// the output is compliant by construction.
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

  const treatment = typeof body.treatment === "string" ? body.treatment.trim() : "";
  if (!treatment) return Response.json({ ok: false, error: "treatment is required" }, { status: 400 });
  const offer = typeof body.offer === "string" && body.offer.trim() ? body.offer.trim() : undefined;
  const angle = typeof body.angle === "string" && body.angle.trim() ? body.angle.trim() : undefined;

  const { system, user } = buildCopyPrompt({ treatment, offer, angle, practiceName: client.name });
  try {
    const anthropic = new Anthropic({ maxRetries: 1 });
    const msg = await anthropic.messages.create(
      { model: SONNET, max_tokens: 600, system, messages: [{ role: "user", content: user }] },
      { timeout: 25000 },
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return Response.json({ ok: false, error: "could not generate copy" }, { status: 502 });
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const copy = {
      headline: cleanCopy(String(parsed.headline ?? "")),
      primaryText: cleanCopy(String(parsed.primaryText ?? "")),
      description: cleanCopy(String(parsed.description ?? "")),
      cta: cleanCopy(String(parsed.cta ?? "")),
      complianceNote: cleanCopy(String(parsed.complianceNote ?? "")),
    };
    if (!copy.headline || !copy.primaryText) {
      return Response.json({ ok: false, error: "incomplete copy" }, { status: 502 });
    }
    return Response.json({ ok: true, copy });
  } catch {
    return Response.json({ ok: false, error: "copy generation unavailable" }, { status: 500 });
  }
}
