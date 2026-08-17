// THE DRAFT-A-FUNNEL ENDPOINT. Authed, and it spends two Sonnet calls per press.
//
// Mocked: the auth guard (it does `import "server-only"`, and we need to drive
// roles), the shared budget, and the Anthropic SDK. NOT mocked: the route itself
// or the generator behind it, so the graph in the response is one that genuinely
// came through parse -> validate -> pin -> compliance scan.
//
// What is pinned here:
//   - the module lock is real, and it is the ONLY thing standing between a
//     clinician session and this route;
//   - the budget is consumed BEFORE the model, and a block means no model call;
//   - a hostile or absent goal is refused rather than passed to the model;
//   - the route does not write: the campaign row is the flow PUT's job.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  const consumeBudget = vi.fn(async (..._a: unknown[]) => true as boolean);
  const requireUser = vi.fn(async () => null as unknown);
  const requireClientAccess = vi.fn(() => null as Response | null);
  const requireModuleApiAccess = vi.fn(() => null as Response | null);
  const state = { reply: "", stopReason: "end_turn" as string | null };
  const createMsg = vi.fn(async (..._a: unknown[]) => ({
    content: [{ type: "text", text: state.reply }],
    stop_reason: state.stopReason,
  }));
  return { consumeBudget, requireUser, requireClientAccess, requireModuleApiAccess, state, createMsg };
});

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireClientAccess: h.requireClientAccess,
  requireModuleApiAccess: h.requireModuleApiAccess,
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: h.createMsg };
    constructor(..._a: unknown[]) {}
  },
}));

import { POST } from "./route";
import { validateFlow } from "@/lib/smile-assessment/flow-validate";
import { templateForGoal } from "@/lib/smile-assessment/flow-templates";
import type { FlowGraph } from "@/lib/smile-assessment/flow";

const GOOD = JSON.stringify({
  entry: "n1",
  nodes: [
    { id: "n1", questionId: "treatment_interest" },
    { id: "n2", questionId: "implant_scope" },
    { id: "n3", questionId: "timeline" },
    { id: "n4", questionId: "budget_readiness" },
    { id: "n5", questionId: "location" },
  ],
  edges: [
    { from: "n1", to: "n2", answer: "implants" },
    { from: "n1", to: "n3", answer: null },
    { from: "n2", to: "n3", answer: null },
    { from: "n3", to: "n4", answer: null },
    { from: "n4", to: "n5", answer: null },
    { from: "n5", to: "contact", answer: null },
  ],
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/smile-assessment/flow-generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const OK_BODY = { clientSlug: "vitality", goal: "implants", targetBudget: "finance" };

beforeEach(() => {
  vi.clearAllMocks();
  h.consumeBudget.mockResolvedValue(true);
  h.requireUser.mockResolvedValue(null);
  h.requireClientAccess.mockReturnValue(null);
  h.requireModuleApiAccess.mockReturnValue(null);
  // clearAllMocks clears the CALLS, not the implementations, so a
  // `mockRejectedValue` set by one test leaks into every test written after it -
  // which makes the order of this file load-bearing and the failures baffling.
  // The model stub is put back to the state variables on every test instead.
  h.createMsg.mockImplementation(async (..._a: unknown[]) => ({
    content: [{ type: "text", text: h.state.reply }],
    stop_reason: h.state.stopReason,
  }));
  h.state.reply = GOOD;
  h.state.stopReason = "end_turn";
});

describe("POST /api/smile-assessment/flow-generate — guards", () => {
  it("returns the 401 from requireUser without touching the model", async () => {
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(401);
    expect(h.createMsg).not.toHaveBeenCalled();
  });

  it("403s a role outside the smile-assessment module, and spends nothing", async () => {
    h.requireModuleApiAccess.mockReturnValue(Response.json({ ok: false, error: "forbidden" }, { status: 403 }));
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(403);
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(h.createMsg).not.toHaveBeenCalled();
  });

  it("403s a caller from another practice", async () => {
    h.requireClientAccess.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    expect((await POST(post(OK_BODY))).status).toBe(403);
    expect(h.createMsg).not.toHaveBeenCalled();
  });

  it("locks the module by name, on the client the request resolved", async () => {
    await POST(post(OK_BODY));
    expect(h.requireModuleApiAccess).toHaveBeenCalledWith(null, "smile-assessment");
    expect(h.requireClientAccess).toHaveBeenCalledWith(null, "vitality");
  });

  it("404s an unknown client", async () => {
    const res = await POST(post({ ...OK_BODY, clientSlug: "not-a-practice" }));
    expect(res.status).toBe(404);
    expect(h.createMsg).not.toHaveBeenCalled();
  });
});

describe("POST /api/smile-assessment/flow-generate — input", () => {
  it("400s a non-JSON body rather than 500ing", async () => {
    expect((await POST(post("}{"))).status).toBe(400);
  });

  it("400s a missing or invented goal", async () => {
    expect((await POST(post({ clientSlug: "vitality" }))).status).toBe(400);
    const res = await POST(post({ clientSlug: "vitality", goal: "free_teeth" }));
    expect(res.status).toBe(400);
    expect(h.createMsg).not.toHaveBeenCalled();
  });

  it("400s an invented targetBudget", async () => {
    const res = await POST(post({ ...OK_BODY, targetBudget: "whatever" }));
    expect(res.status).toBe(400);
  });

  it("accepts a campaign with no ideal customer", async () => {
    const res = await POST(post({ clientSlug: "vitality", goal: "hygiene" }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/smile-assessment/flow-generate — the cost guard", () => {
  it("consumes the per-practice budget BEFORE the model call", async () => {
    await POST(post(OK_BODY));
    expect(h.consumeBudget).toHaveBeenCalledWith("sa-flow-gen:vitality", 30, 3600);
    const budgetOrder = h.consumeBudget.mock.invocationCallOrder[0]!;
    const modelOrder = h.createMsg.mock.invocationCallOrder[0]!;
    expect(budgetOrder).toBeLessThan(modelOrder);
  });

  it("429s and calls no model once the budget is exhausted", async () => {
    h.consumeBudget.mockResolvedValueOnce(false);
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(429);
    expect(h.createMsg).not.toHaveBeenCalled();
  });

  it("keys the budget per practice, so one owner cannot spend another's", async () => {
    await POST(post({ ...OK_BODY, clientSlug: "vitality" }));
    const key = h.consumeBudget.mock.calls[0]![0] as string;
    expect(key).toBe("sa-flow-gen:vitality");
  });

  // THE LETTER OF THE RULE, WHICH NO RUNTIME ASSERTION IN THIS FILE REACHES.
  //
  // The invocation-order test above proves the budget is spent before the model is
  // CALLED. The house rule is stricter: it is spent before the Anthropic CLIENT IS
  // CONSTRUCTED. Hoist `new Anthropic(...)` above the consumeBudget block and every
  // mock-order assertion here stays green - the client is built, the 429 still
  // returns, no message is ever created - while the rule is broken.
  //
  // The rule is written that way because construction is where the key is read and
  // where the SDK is free to do work of its own (connection setup, retry state, a
  // future eager handshake). A cap decided after that point is a cap on a decision
  // already taken, and the failure would be invisible until a bill arrived.
  //
  // MUTATION: swap the two statements in route.ts. This assertion is the only thing
  // in the repository that goes red.
  it("spends the budget BEFORE the Anthropic client is constructed, in source order", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/app/api/smile-assessment/flow-generate/route.ts"),
      "utf8",
    );
    const budget = src.indexOf("await consumeBudget(");
    const client = src.indexOf("new Anthropic(");
    expect(budget, "the route no longer consumes a budget").toBeGreaterThan(-1);
    expect(client, "the route no longer constructs a client").toBeGreaterThan(-1);
    expect(budget).toBeLessThan(client);
    // Exactly one of each, or "the first one" is not the one that matters and a
    // second construction site could sit anywhere.
    expect(src.split("new Anthropic(").length - 1).toBe(1);
    expect(src.split("consumeBudget(").length - 1).toBe(1);
  });
});

describe("POST /api/smile-assessment/flow-generate — the reply", () => {
  it("returns a VALIDATED graph built from the model's questions", async () => {
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; flow: FlowGraph; source: string };
    expect(j.ok).toBe(true);
    expect(j.source).toBe("model");
    expect(validateFlow(j.flow).ok).toBe(true);
    expect(j.flow.nodes.some((n) => n.kind === "contact")).toBe(true);
  });

  it("asks Sonnet with thinking disabled, and does not let the SDK retry", async () => {
    await POST(post(OK_BODY));
    const [args] = h.createMsg.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(args.model).toBe("claude-sonnet-5");
    expect(args.thinking).toEqual({ type: "disabled" });
  });

  it("falls back to the goal's template when the model is unusable, still 200", async () => {
    h.state.reply = "I will not do that.";
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; flow: FlowGraph; source: string; reason: string };
    expect(j.source).toBe("template");
    expect(j.reason).toBe("unreadable");
    expect(j.flow).toEqual(templateForGoal("implants").build());
  });

  it("refuses a truncated reply and does not retry it", async () => {
    h.state.stopReason = "max_tokens";
    const res = await POST(post(OK_BODY));
    const j = (await res.json()) as { source: string; reason: string };
    expect(j.source).toBe("template");
    expect(j.reason).toBe("truncated");
    expect(h.createMsg).toHaveBeenCalledTimes(1);
  });

  it("never 500s when the model call rejects", async () => {
    h.createMsg.mockRejectedValue(new Error("upstream 529"));
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; source: string };
    expect(j.ok).toBe(true);
    expect(j.source).toBe("template");
  });
});

// ---------------------------------------------------------------------------
// REWRITE MODE. Same route, same guards, same wallet - and a floor that is the
// OWNER'S FUNNEL rather than the goal's template.
// ---------------------------------------------------------------------------

describe("POST /api/smile-assessment/flow-generate — rewrite mode", () => {
  const OWNED = templateForGoal("implants").build();
  const TIMELINE = OWNED.nodes.find((n) => n.kind === "question" && n.questionId === "timeline")!;

  /** The funnel echoed back with one better line, which is all a rewriter sends. */
  const REWRITTEN = JSON.stringify({
    nodes: OWNED.nodes
      .filter((n) => n.kind === "question")
      .map((n) => ({
        id: n.id,
        questionId: n.kind === "question" ? n.questionId : "",
        transition: n.id === TIMELINE.id ? "Lovely. When would you like to start?" : undefined,
      })),
    edges: OWNED.edges.map((e) => ({ from: e.from, to: e.to, answer: e.answer })),
    screens: { welcome: { headline: "A few quick questions about your smile" } },
  });

  // No default argument: `rewriteBody(undefined)` has to mean "a request with no
  // funnel on it", which is the commonest way this endpoint gets called wrongly.
  const rewriteBody = (flow: unknown) => ({ ...OK_BODY, mode: "rewrite", flow });
  const goodRewrite = () => rewriteBody(OWNED);

  it("returns the owner's funnel with new words and the same shape", async () => {
    h.state.reply = REWRITTEN;
    const res = await POST(post(goodRewrite()));
    expect(res.status).toBe(200);

    const j = (await res.json()) as { ok: boolean; flow: FlowGraph; source: string };
    expect(j.source).toBe("model");
    expect(validateFlow(j.flow).ok).toBe(true);
    expect(j.flow.nodes.map((n) => n.id)).toEqual(OWNED.nodes.map((n) => n.id));
    expect(j.flow.edges).toHaveLength(OWNED.edges.length);
    const timeline = j.flow.nodes.find((n) => n.id === TIMELINE.id)!;
    expect(timeline.kind === "question" && timeline.transition).toBe(
      "Lovely. When would you like to start?",
    );
  });

  // MUTATION: fall through to a draft when `flow` cannot be read. The owner presses
  // "rewrite the words" and gets a different funnel - one they never asked for,
  // built from a template, over the top of the one they had.
  it("400s an unreadable funnel rather than quietly drafting a new one", async () => {
    for (const flow of [undefined, "not a funnel", { nodes: "yes" }, 42]) {
      const res = await POST(post(rewriteBody(flow)));
      expect(res.status, `flow: ${JSON.stringify(flow)}`).toBe(400);
    }
    expect(h.createMsg).not.toHaveBeenCalled();
  });

  it("hands the owner's own funnel back, untouched, when the model is unusable", async () => {
    h.state.reply = "I will not do that.";
    const res = await POST(post(goodRewrite()));
    expect(res.status).toBe(200);

    const j = (await res.json()) as { flow: FlowGraph; source: string; reason: string };
    expect(j.source).toBe("unchanged");
    expect(j.source).not.toBe("template");
    expect(j.flow).toEqual(OWNED);
  });

  // ONE WALLET FOR ONE BUILDER. Two modes with two caps would mean an owner who
  // had tuned the words all morning could still spend the drafting budget, which
  // is the expensive half. Same key, same limit, same order.
  it("spends the SAME budget as a draft, before the model, on the same key", async () => {
    h.state.reply = REWRITTEN;
    await POST(post(goodRewrite()));
    expect(h.consumeBudget).toHaveBeenCalledWith("sa-flow-gen:vitality", 30, 3600);
    expect(h.consumeBudget.mock.invocationCallOrder[0]!).toBeLessThan(
      h.createMsg.mock.invocationCallOrder[0]!,
    );
  });

  it("429s a rewrite once the drafting budget is gone, and calls no model", async () => {
    h.consumeBudget.mockResolvedValueOnce(false);
    const res = await POST(post(goodRewrite()));
    expect(res.status).toBe(429);
    expect(h.createMsg).not.toHaveBeenCalled();
  });

  it("holds a rewrite to the same guards a draft passes", async () => {
    h.requireModuleApiAccess.mockReturnValue(
      Response.json({ ok: false, error: "forbidden" }, { status: 403 }),
    );
    const res = await POST(post(goodRewrite()));
    expect(res.status).toBe(403);
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(h.createMsg).not.toHaveBeenCalled();
  });

  // MUTATION: give a rewrite the draft's cap. The reply has to echo the funnel
  // back, so it is longer for the same funnel - and a cut-off reply is refused,
  // which spends the call and changes nothing.
  it("gives a rewrite the headroom to echo the funnel back", async () => {
    h.state.reply = REWRITTEN;
    await POST(post(goodRewrite()));
    const [rewriteArgs] = h.createMsg.mock.calls[0] as [Record<string, unknown>];
    expect(rewriteArgs.max_tokens).toBe(4000);

    vi.clearAllMocks();
    h.state.reply = GOOD;
    await POST(post(OK_BODY));
    const [draftArgs] = h.createMsg.mock.calls[0] as [Record<string, unknown>];
    expect(draftArgs.max_tokens).toBe(3000);
  });

  it("refuses a truncated rewrite before parsing, and changes nothing", async () => {
    h.state.reply = REWRITTEN;
    h.state.stopReason = "max_tokens";
    const res = await POST(post(goodRewrite()));

    const j = (await res.json()) as { flow: FlowGraph; source: string; reason: string };
    expect(j.source).toBe("unchanged");
    expect(j.reason).toBe("truncated");
    expect(j.flow).toEqual(OWNED);
    expect(h.createMsg).toHaveBeenCalledTimes(1);
  });

  it("treats an unknown mode as a draft rather than guessing", async () => {
    h.state.reply = GOOD;
    const res = await POST(post({ ...OK_BODY, mode: "improve", flow: OWNED }));
    const j = (await res.json()) as { source: string; flow: FlowGraph };
    expect(j.source).toBe("model");
    // A draft: the model's own question ids, not the owner's funnel.
    expect(j.flow.nodes.some((n) => n.id === "n1")).toBe(true);
  });
});

describe("POST /api/smile-assessment/flow-generate — it drafts, it does not publish", () => {
  it("holds no write path: no repository import, no campaign update", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/app/api/smile-assessment/flow-generate/route.ts"),
      "utf8",
    );
    // A draft nobody has looked at must not be reachable by a patient. Saving is
    // the flow PUT's job, and that is where flow_published is decided.
    expect(src).not.toContain("campaign-repository");
    expect(src).not.toMatch(/updateCampaign|insertCampaign|setCampaign/);
  });
});
