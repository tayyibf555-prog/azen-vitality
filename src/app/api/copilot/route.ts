import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { getClient, getSites } from "@/lib/mock";
import { runAgentTurn } from "@/lib/agent/run";
import { COPILOT_TOOLS, makeCopilotDispatch } from "@/lib/copilot/tools";
import { buildCopilotSystemPrompt } from "@/lib/copilot/prompt";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export async function POST(request: Request): Promise<Response> {
  let body: { messages?: Msg[]; client?: string };
  try {
    body = (await request.json()) as { messages?: Msg[]; client?: string };
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const messages = (body.messages ?? [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0)
    .slice(-20);
  if (messages.length === 0) return Response.json({ ok: false, error: "no messages" }, { status: 400 });

  // Resolve the practice's sites so the co-pilot's tools query the right data.
  const client = body.client ? getClient(body.client) : null;

  // Authz: a verified user with access to this client (enforced once the
  // service-role key is set). The co-pilot exposes full patient data, so this
  // is the gate that stops anonymous exfiltration.
  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  // Never run un-scoped: an unknown/omitted client would query zero sites and
  // quietly burn tokens, so reject it before reaching Claude.
  if (!client) return Response.json({ ok: false, error: "unknown client" }, { status: 400 });
  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;

  const siteIds = client ? getSites(client.id).map((s) => s.id) : [];

  try {
    const history: MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const result = await runAgentTurn(history, {
      anthropic: new Anthropic(),
      dispatch: makeCopilotDispatch(siteIds, client?.id ?? ""),
      systemPrompt: buildCopilotSystemPrompt(),
      tools: COPILOT_TOOLS,
    });
    return Response.json({ ok: true, reply: result.replyText || "Sorry, I could not respond just now." });
  } catch {
    return Response.json({ ok: false, error: "copilot unavailable" }, { status: 500 });
  }
}
