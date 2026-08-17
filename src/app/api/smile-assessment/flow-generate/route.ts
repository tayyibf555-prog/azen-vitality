import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { getClient } from "@/lib/mock/clients";
import { requireUser, requireClientAccess, requireModuleApiAccess } from "@/lib/auth/guard";
import type { AuthedUser } from "@/lib/auth/session";
import { consumeBudget } from "@/lib/rate-budget";
import { BUDGET_KEYS, GOAL_KEYS } from "@/lib/smile-assessment/campaign";
import { normaliseFlow, type FlowGraph } from "@/lib/smile-assessment/flow";
import {
  generateFlow,
  type FlowGenerateMode,
  type FlowModelReply,
} from "@/lib/smile-assessment/flow-generate";

export const dynamic = "force-dynamic";
// Up to two model calls (the attempt and its one repair pass), each capped below.
export const maxDuration = 60;

// WRITE A FUNNEL FOR THE BUILDER. Internal, authed: an owner or the practice
// coordinator describes the campaign and gets back a validated FlowGraph to edit
// on the canvas.
//
// TWO MODES, ONE ROUTE, ONE BUDGET. `draft` writes a funnel that does not exist
// yet (the gallery's "Let AI write one"); `rewrite` takes the funnel on the canvas
// and returns it with better words (the builder's "Rewrite the words"). They share
// this route because they share everything that makes a route: the same guards,
// the same two Sonnet calls, the same repair-once shape, and the same reason for a
// cap - a button in a builder that a frustrated owner will press repeatedly. A
// second route would have meant a second cap to reason about for one wallet.
//
// IT DOES NOT SAVE, in either mode. The reply is a draft, and a draft the owner
// never looked at is not something a patient should be able to reach. The campaign
// row is written by PUT /api/smile-assessment/campaign/[slug]/flow when they
// choose to keep it, which is also where flow_published is decided. So this route
// holds no write path at all: nothing here can put a graph in front of a patient.
//
// GUARDS: requireUser -> requireClientAccess -> requireModuleApiAccess. The last
// one names "smile-assessment" as a literal, matching the sibling campaign routes
// (campaign/route.ts:66,101) and the onboarding form builder, which is the exact
// same act: authoring a public, patient-facing form. Deliberately NOT
// requireOwnerRole: smile-assessment carries no `roles` array (nav.ts), so the
// practice coordinator legitimately holds the module and owns this job.

/** ~30 drafts an hour per practice: generous for a builder, useless for a bill. */
const BUDGET_LIMIT = 30;
const BUDGET_WINDOW_SECONDS = 3600;

/** A graph of eight questions with a line of copy each, with real headroom. */
const MAX_TOKENS = 3000;
/**
 * A REWRITE HAS TO ECHO THE FUNNEL BACK, so its reply is longer than a draft's for
 * the same funnel: every node id and questionId travels with the new wording, and
 * a funnel the owner has grown is bigger than one the model just invented.
 *
 * The failure mode of getting this too low is SAFE but wasteful - a reply cut off
 * at the cap is refused before parsing and the owner is told nothing changed, so
 * they lose a call rather than a funnel. Worth revisiting against real funnels
 * once there are some: this is sized for the templates plus room to grow, not
 * measured against the 60-node ceiling normaliseFlow allows.
 */
const REWRITE_MAX_TOKENS = 4000;
/**
 * Two calls at 25s must fit inside maxDuration, so retries are off: a slow or
 * erroring call falls through to the goal's template (which is what generateFlow
 * does with an unusable reply) rather than silently tripling the spend.
 */
const CALL_TIMEOUT_MS = 25_000;

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

  const goal = str(body.goal, 40);
  if (!goal || !GOAL_KEYS.includes(goal)) return bad(`goal must be one of: ${GOAL_KEYS.join(", ")}`);

  const targetBudget = str(body.targetBudget, 40) ?? "any";
  if (!BUDGET_KEYS.includes(targetBudget)) {
    return bad(`targetBudget must be one of: ${BUDGET_KEYS.join(", ")}`);
  }
  const idealCustomer = str(body.idealCustomer, 280) ?? null;
  const practiceName = str(body.practiceName, 80) ?? null;

  // REWRITE CARRIES THE FUNNEL IN THE BODY, and it is coerced rather than trusted:
  // normaliseFlow is all-or-nothing about shape, which is all this needs, because
  // the rewrite reads copy out of the reply and lays it onto THIS graph - so
  // whatever comes back has this funnel's structure or is refused outright
  // (sameFlowStructure). Refusing an unreadable one here, rather than quietly
  // drafting a new funnel instead, is the difference between "we could not rewrite
  // it" and silently replacing the owner's work.
  const mode: FlowGenerateMode = body.mode === "rewrite" ? "rewrite" : "draft";
  let graph: FlowGraph | undefined;
  if (mode === "rewrite") {
    const parsed = normaliseFlow(body.flow);
    if (!parsed) return bad("The funnel on the canvas could not be read, so nothing was rewritten");
    graph = parsed;
  }

  // A DELIBERATE, DOCUMENTED DEPARTURE. Every other AI route behind a session in
  // this codebase carries no budget: the session IS the cost control, because a
  // signed-in colleague is not an attacker. This one is a BUTTON, in a builder,
  // that a frustrated owner will press repeatedly while a draft is not quite what
  // they wanted, and each press is two Sonnet calls with the whole question bank
  // in the prompt. The cap is per practice, generous, consumed BEFORE the model
  // is touched, and consumeBudget fails OPEN on a DB error (rate-budget.ts:25),
  // so it can throttle a runaway bill and cannot break the feature.
  if (!(await consumeBudget(`sa-flow-gen:${client.id}`, BUDGET_LIMIT, BUDGET_WINDOW_SECONDS))) {
    return Response.json(
      { ok: false, error: "you have drafted a lot of funnels in the last hour, please try again shortly" },
      { status: 429 },
    );
  }

  const anthropic = new Anthropic({ maxRetries: 0 });
  const callModel = async (system: string, user: string): Promise<FlowModelReply> => {
    const msg = await anthropic.messages.create(
      {
        model: SONNET,
        thinking: NO_THINKING,
        max_tokens: mode === "rewrite" ? REWRITE_MAX_TOKENS : MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
      },
      { timeout: CALL_TIMEOUT_MS },
    );
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    // stop_reason travels with the text: a reply cut off at MAX_TOKENS is refused
    // before it is parsed (flow-generate.ts), never half-parsed.
    return { text, stopReason: msg.stop_reason };
  };

  // generateFlow never throws and never returns an unvalidated graph: on a draft
  // an unusable model, a broken reply and a bad network all end on the goal's
  // hand-written template, and on a rewrite they all end on the funnel that came
  // in, byte for byte, with `source: "unchanged"` saying so.
  const generated = await generateFlow({
    goal,
    idealCustomer,
    targetBudget,
    practiceName,
    mode,
    graph,
    callModel,
  });

  return Response.json({
    ok: true,
    flow: generated.graph,
    source: generated.source,
    reason: generated.reason,
    failures: generated.failures,
  });
}
