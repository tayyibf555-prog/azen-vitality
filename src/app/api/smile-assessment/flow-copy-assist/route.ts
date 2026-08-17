import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { consumeBudget } from "@/lib/rate-budget";
import { normaliseFlow } from "@/lib/smile-assessment/flow";
import {
  assistCopy,
  parseAssistTarget,
  resolveAssistTarget,
  type AssistModelReply,
} from "@/lib/smile-assessment/flow-assist";

export const dynamic = "force-dynamic";
// One model call, and at most one regeneration when the first line fails the
// compliance scan. Both are capped below, and both are small.
export const maxDuration = 30;

// WRITE ONE FIELD FOR THE OWNER. Internal, authed: the inspector rail's "write
// this for me" beside a single copy box - a headline, a lead-in, one line of a
// content block.
//
// IT IS A SEPARATE ROUTE FROM flow-generate, and deliberately so. That one drafts
// a whole graph: 3000 max_tokens, the entire question bank in the prompt, a repair
// pass, a template floor, and a budget sized for "a few drafts an hour". This one
// writes a sentence. Sharing the route would mean one budget for two cost
// profiles - and a spree of copy tuning would then starve whole-funnel drafting,
// which is the expensive thing the cap exists to protect.
//
// IT DOES NOT SAVE, and it does not even hold the campaign's stored funnel: the
// DRAFT graph travels in the body, the line travels back, and the builder lands it
// through the ordinary edit intents. The campaign row is written only by PUT
// /api/smile-assessment/campaign/[slug]/flow, which is where the compliance scan
// that actually gates a patient-facing funnel lives.
//
// GUARDS: requireUser -> requireClientAccess -> requireModuleApiAccess, the same
// triad and the same module literal as flow-generate and the campaign routes.
// Authoring a public, patient-facing form is the coordinator's job as much as the
// owner's, so this is not requireOwnerRole.

/**
 * ~120 lines an hour per practice. Twelve times the whole-funnel cap because each
 * call is roughly a tenth of the cost (one short field, no question bank, no
 * repair pass), and because the button sits beside EVERY copy box: an owner
 * tuning a funnel will press one dozens of times in a sitting, and a cap that
 * interrupts honest work is a cap that gets removed.
 */
const BUDGET_LIMIT = 120;
const BUDGET_WINDOW_SECONDS = 3600;

/**
 * Two short calls must fit inside maxDuration, so retries are off: a slow or
 * erroring call comes back as "we could not write that one, type it yourself",
 * which leaves the owner's own words exactly where they were.
 */
const CALL_TIMEOUT_MS = 12_000;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  const result = await requireUser();
  if (result instanceof Response) return result;
  const auth: AuthedUser | null = result;

  const clientSlug = str(body.clientSlug, 60) ?? new URL(request.url).searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return bad("Unknown client", 404);

  const denied = requireClientAccess(auth, client.id);
  if (denied) return denied;
  const moduleDenied = requireModuleApiAccess(auth, "smile-assessment");
  if (moduleDenied) return moduleDenied;

  // The draft as it stands on the canvas. Coerced, never trusted: normaliseFlow
  // is all-or-nothing about SHAPE, which is all this needs - the line is written
  // against the funnel for context and lands through the ordinary edit ops, and
  // the real gate is still the save.
  const graph = normaliseFlow(body.flow);
  if (!graph) return bad("The funnel could not be read");

  const target = parseAssistTarget(body.target);
  if (!target) return bad("target must name a screen and one of its copy fields");

  // ENFORCEMENT POINT TWO OF TWO, and the reason it is here rather than only in
  // the pipeline: a rule that lives one call deep is a rule the next caller of
  // that pipeline can skip. A testimonial's quote, its attribution and the
  // practice's own name on a trust strip are refused BY NAME, in words, before a
  // single token is spent - the rail draws no button on them either, and neither
  // of those two facts is allowed to be the only one.
  const resolved = resolveAssistTarget(graph, target);
  if (!resolved.ok) return bad(resolved.reason);

  const practiceName = str(body.practiceName, 80) ?? null;

  // Consumed BEFORE the client is constructed and before a token is spent, the
  // same order flow-generate uses and for the same reason. consumeBudget fails
  // OPEN on a DB error (rate-budget.ts): it can throttle a runaway bill and
  // cannot break the feature.
  if (!(await consumeBudget(`sa-copy-assist:${client.id}`, BUDGET_LIMIT, BUDGET_WINDOW_SECONDS))) {
    return Response.json(
      {
        ok: false,
        error: "you have asked for a lot of lines in the last hour, please try again shortly",
      },
      { status: 429 },
    );
  }

  const anthropic = new Anthropic({ maxRetries: 0 });
  const callModel = async (system: string, user: string, maxTokens: number): Promise<AssistModelReply> => {
    const msg = await anthropic.messages.create(
      {
        model: SONNET,
        thinking: NO_THINKING,
        // Sized to the FIELD by the pure layer, never to a funnel: the longest box
        // here is 240 characters.
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      },
      { timeout: CALL_TIMEOUT_MS },
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    // stop_reason travels with the text: a line cut off at the cap is refused
    // before it is parsed, never half-parsed.
    return { text, stopReason: msg.stop_reason };
  };

  // assistCopy never throws and never returns wording that failed the compliance
  // scan: either a clean line, or nothing and a sentence saying so.
  const assisted = await assistCopy({ target, graph, context: { practiceName }, callModel });

  return Response.json({
    ok: true,
    text: assisted.text,
    source: assisted.source,
    reason: assisted.reason,
    message: assisted.message,
  });
}
