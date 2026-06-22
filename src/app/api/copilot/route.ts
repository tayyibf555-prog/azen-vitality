import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { getClient, getSites } from "@/lib/mock";
import { runAgentTurn } from "@/lib/agent/run";
import { COPILOT_TOOLS, makeCopilotDispatch } from "@/lib/copilot/tools";
import { buildCopilotSystemPrompt } from "@/lib/copilot/prompt";

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
  const siteIds = client ? getSites(client.id).map((s) => s.id) : [];

  try {
    const history: MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const result = await runAgentTurn(history, {
      anthropic: new Anthropic(),
      dispatch: makeCopilotDispatch(siteIds),
      systemPrompt: buildCopilotSystemPrompt(),
      tools: COPILOT_TOOLS,
    });
    return Response.json({ ok: true, reply: result.replyText || "Sorry, I could not respond just now." });
  } catch {
    return Response.json({ ok: false, error: "copilot unavailable" }, { status: 500 });
  }
}
