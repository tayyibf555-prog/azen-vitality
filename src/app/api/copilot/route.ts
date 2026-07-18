import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { getClient } from "@/lib/mock";
import { getViewScope } from "@/lib/site-view";
import { runAgentTurn } from "@/lib/agent/run";
import { COPILOT_TOOLS, makeCopilotDispatch } from "@/lib/copilot/tools";
import { buildCopilotSystemPrompt } from "@/lib/copilot/prompt";
import { requireUser, requireClientAccess } from "@/lib/auth/guard";
import { recordUsage } from "@/lib/telemetry";

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
  // Anthropic requires the first message to be a `user` turn. After slicing to the
  // last 20, a long conversation can leave the window starting on an `assistant`
  // turn, which the API rejects with a 400 (the co-pilot would break on exactly the
  // 11th+ exchange). Drop any leading assistant turns so history starts with the user.
  while (messages.length && messages[0].role === "assistant") messages.shift();
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
  // The co-pilot can read ANY patient record for the practice, so restrict it to
  // the owner (and agency admins). A coordinator/employee login must not get the
  // full-DB co-pilot until per-role tool scoping exists. (auth is null only when
  // enforcement is off, i.e. local/dev, where everything is already open.)
  if (auth && auth.role !== "client_owner" && auth.role !== "agency_admin") {
    return Response.json({ ok: false, error: "The co-pilot is available to the practice owner." }, { status: 403 });
  }

  // Honour the top-bar site switcher: this route is called from the browser WITH
  // the user's cookie, so the co-pilot's tools query only the selected site (the
  // default view is N15). "All sites" restores whole-group access; the system
  // prompt tells the model which scope it is answering for.
  const scope = await getViewScope(client.id);
  const siteIds = scope.siteIds;

  try {
    const actor = auth?.id ?? "owner";
    const history: MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const result = await runAgentTurn(history, {
      anthropic: new Anthropic(),
      dispatch: makeCopilotDispatch(siteIds, client?.id ?? "", actor),
      systemPrompt: buildCopilotSystemPrompt({ label: scope.label, isAllSites: scope.isAllSites }),
      tools: COPILOT_TOOLS,
      maxRounds: 6,
      // Sonnet 5's tokenizer runs ~30% larger than 4.6, so give the co-pilot's
      // "answer anything" replies headroom to avoid truncation.
      maxTokens: 1800,
    });
    void recordUsage("co-pilot", "copilot_turn", { clientId: client.id, userEmail: auth?.email, role: auth?.role });
    return Response.json({ ok: true, reply: result.replyText || "Sorry, I could not respond just now." });
  } catch {
    return Response.json({ ok: false, error: "copilot unavailable" }, { status: 500 });
  }
}
