import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { runAgentTurn } from "@/lib/agent/run";
import { requireUser, requireClientAccess, requireModuleApiAccess, requireOwnerRole } from "@/lib/auth/guard";
import { getClient } from "@/lib/mock/clients";
import { isSystemEnabled } from "@/lib/systems/repository";
import { recordUsage } from "@/lib/telemetry";
import { buildItDeskSystemPrompt } from "@/lib/itdesk/prompt";
import { getItContact, setItContact } from "@/lib/itdesk/repository";
import { IT_DESK_TOOLS, makeItDeskDispatch } from "@/lib/itdesk/tools";
import { gateItDeskQuestion } from "@/lib/itdesk/topic-gate";
import { IT_DESK_SLUG } from "@/lib/itdesk/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ===========================================================================
// THE IT DESK'S API. Two actions:
//
//   ask          one turn of the IT desk agent
//   set-contact  the practice's named IT contact (OWNER-level, see below)
//
// AUTHORISATION on both: signed in, belongs to this practice, holds the 'it-desk'
// module — which, because the nav entry names owner + agency + practice manager,
// is the whole of the owner/manager restriction, enforced at the API layer.
//
// `set-contact` carries a SECOND, narrower guard. Who the practice escalates to
// is the one setting in this module that changes what staff are told to do: an
// altered number sends every future escalation somewhere the owner did not
// choose, which is a social-engineering shape as much as a configuration one. So
// it is owner + agency only, while reading it stays with everyone who has the
// module — the desk is no use if the manager cannot see who to ring.
//
// THE KILL SWITCH IS ON `ask` ONLY. 'it-desk' is defaultEnabled:false, so an
// absent toggle row AND an unreadable toggle table both resolve to DISABLED. The
// contact stays readable and settable while the switch is off, because it has to
// be set BEFORE the agent is switched on or its escalation has nowhere to go.
// ===========================================================================

interface Msg {
  role: "user" | "assistant";
  content: string;
}

function bad(error: string, status = 400): Response {
  return Response.json({ ok: false, error }, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await params;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const auth = await requireUser();
  if (auth instanceof Response) return auth;
  const clientSlug = typeof body.client === "string" ? body.client : "";
  const client = clientSlug ? getClient(clientSlug) : undefined;
  if (!client) return bad("unknown client");
  const clientDenied = requireClientAccess(auth, client.id);
  if (clientDenied) return clientDenied;
  // THE SLUG IS A STRING LITERAL, not the module's own constant, and that is on
  // purpose: `client-api-module-guard-coverage.test.ts` reads this file as TEXT
  // to prove the lock exists and to record WHICH module it locks. A constant
  // compiles identically and is invisible to that sweep, which would leave the
  // route guarded in the code and unguarded in the proof — the worse of the two
  // failures, because it looks fine from both sides.
  const moduleDenied = requireModuleApiAccess(auth, "it-desk");
  if (moduleDenied) return moduleDenied;

  if (action === "set-contact") {
    const ownerDenied = requireOwnerRole(auth);
    if (ownerDenied) return ownerDenied;
    const ok = await setItContact(client.id, body, auth?.id ?? "owner");
    return ok ? Response.json({ ok: true }) : bad("We could not save that", 500);
  }

  if (action !== "ask") return bad("unknown action", 404);

  // 1. THE OWNER'S KILL SWITCH, before anything is spent.
  if (!(await isSystemEnabled(client.id, IT_DESK_SLUG))) {
    return Response.json({
      ok: true,
      reply:
        "The IT desk is switched off. The practice owner can switch it on in System controls; the playbooks below stay readable either way.",
      refused: true,
      reason: "system_off",
    });
  }

  const messages = (Array.isArray(body.messages) ? (body.messages as Msg[]) : [])
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0 &&
        m.content.length < 4000,
    )
    .slice(-16);
  while (messages.length && messages[0].role === "assistant") messages.shift();
  if (messages.length === 0) return bad("no messages");

  // 2. THE SERVER-SIDE GATE. Deterministic, before the Anthropic client is
  //    constructed: a credential request or a "turn the firewall off" never
  //    reaches a model at all. The prompt repeats these rules; it does not
  //    enforce them.
  const verdict = gateItDeskQuestion({
    userTurns: messages.filter((m) => m.role === "user").map((m) => m.content),
    playbookInScope: messages.some((m) => m.role === "assistant"),
  });
  if (verdict.kind === "refuse") {
    // The RULE is part of the action token (UsageActor has no field for one),
    // because "which rule refused this" is the only thing that makes a refusal
    // count worth reading later.
    void recordUsage("it-desk", `refused.${verdict.rule}`, { clientId: client.id, userEmail: auth?.email, role: auth?.role });
    return Response.json({ ok: true, reply: verdict.message, refused: true, reason: verdict.reason });
  }

  const contact = await getItContact(client.id);

  try {
    const history: MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const result = await runAgentTurn(history, {
      anthropic: new Anthropic(),
      dispatch: makeItDeskDispatch({ clientId: client.id }),
      systemPrompt: buildItDeskSystemPrompt({
        practiceName: client.name,
        contact,
        contactUnavailable: contact === null,
      }),
      tools: IT_DESK_TOOLS,
      maxRounds: 5,
      maxTokens: 1200,
    });
    void recordUsage("it-desk", "turn", { clientId: client.id, userEmail: auth?.email, role: auth?.role });
    return Response.json({ ok: true, reply: result.replyText || "Sorry, I could not answer that just now." });
  } catch {
    return Response.json({ ok: false, error: "the IT desk is unavailable" }, { status: 500 });
  }
}
