// THE WRITE-ONE-FIELD ENDPOINT. Authed, and it sits behind a button on EVERY copy
// box in the funnel builder - which is what makes its cost guard a different
// argument from the whole-funnel one, and why it has a key of its own.
//
// Mocked: the auth guard (it does `import "server-only"`, and we need to drive
// roles), the shared budget, and the Anthropic SDK. NOT mocked: the route or the
// pipeline behind it, so a line in the response is one that genuinely came through
// resolve -> parse -> compliance scan.
//
// What is pinned here:
//   - the module lock is real, and it is the only thing between a clinician
//     session and this route;
//   - the budget is its OWN key, consumed BEFORE the model, and a block means no
//     model call;
//   - a testimonial's words are refused BY THE SERVER, spending nothing - the
//     rail's missing button is not the rule;
//   - the model is Sonnet with thinking off and a cap sized to the FIELD;
//   - wording that fails the compliance scan is never returned;
//   - the route does not write: saving is the flow PUT's job.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => {
  const consumeBudget = vi.fn(async (..._a: unknown[]) => true as boolean);
  const requireUser = vi.fn(async () => null as unknown);
  const requireClientAccess = vi.fn(() => null as Response | null);
  const requireModuleApiAccess = vi.fn(() => null as Response | null);
  const state = { replies: ["Tell us what you would change."] as string[], stopReason: "end_turn" as string | null };
  let at = 0;
  // Named, and reinstated in beforeEach: `vi.clearAllMocks()` clears the CALLS and
  // leaves the implementation, so one test's mockRejectedValue would otherwise be
  // every later test's model.
  const replyImpl = async (..._a: unknown[]) => ({
    content: [{ type: "text", text: state.replies[Math.min(at++, state.replies.length - 1)] ?? "" }],
    stop_reason: state.stopReason,
  });
  const createMsg = vi.fn(replyImpl);
  const resetReplies = () => {
    at = 0;
  };
  return {
    consumeBudget,
    requireUser,
    requireClientAccess,
    requireModuleApiAccess,
    state,
    createMsg,
    replyImpl,
    resetReplies,
  };
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
import { templateForGoal } from "@/lib/smile-assessment/flow-templates";
import { assistMaxTokens } from "@/lib/smile-assessment/flow-assist";
import { FLOW_LIMITS, type FlowBlock, type FlowGraph, type FlowNode } from "@/lib/smile-assessment/flow";

const FLOW = (): FlowGraph => templateForGoal("implants").build();

/** The same funnel with a testimonial the practice typed in itself. */
function withTestimonial(): FlowGraph {
  const graph = FLOW();
  const block: FlowBlock = {
    kind: "testimonial",
    quote: "The team looked after me from start to finish.",
    attribution: "Sam, Wood Green",
  };
  return {
    ...graph,
    nodes: graph.nodes.map((n): FlowNode => (n.kind === "welcome" ? { ...n, blocks: [block] } : n)),
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/smile-assessment/flow-copy-assist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const OK_BODY = {
  clientSlug: "vitality",
  flow: FLOW(),
  target: { nodeId: "welcome", field: "headline" },
  practiceName: "Vitality Dental",
};

type Reply = { ok?: boolean; text?: string | null; source?: string; reason?: string | null; message?: string | null; error?: string };

beforeEach(() => {
  vi.clearAllMocks();
  h.resetReplies();
  h.createMsg.mockImplementation(h.replyImpl);
  h.consumeBudget.mockResolvedValue(true);
  h.requireUser.mockResolvedValue(null);
  h.requireClientAccess.mockReturnValue(null);
  h.requireModuleApiAccess.mockReturnValue(null);
  h.state.replies = ["Tell us what you would change."];
  h.state.stopReason = "end_turn";
});

describe("POST /api/smile-assessment/flow-copy-assist — guards", () => {
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

describe("POST /api/smile-assessment/flow-copy-assist — input", () => {
  it("400s a non-JSON body rather than 500ing", async () => {
    expect((await POST(post("}{"))).status).toBe(400);
  });

  it("400s a funnel it cannot read, and an unreadable target", async () => {
    expect((await POST(post({ ...OK_BODY, flow: { nope: true } }))).status).toBe(400);
    expect((await POST(post({ ...OK_BODY, target: { field: "headline" } }))).status).toBe(400);
    expect((await POST(post({ ...OK_BODY, target: { nodeId: "welcome", field: "everything" } }))).status).toBe(400);
    expect(h.createMsg).not.toHaveBeenCalled();
  });

  // MUTATION: resolve the target only inside the pipeline. A field the screen does
  // not have would then spend a model call to produce a line with nowhere to land.
  it("400s a field the named screen does not have, before the budget", async () => {
    const res = await POST(post({ ...OK_BODY, target: { nodeId: "contact", field: "headline" } }));
    expect(res.status).toBe(400);
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(h.createMsg).not.toHaveBeenCalled();
  });
});

describe("POST /api/smile-assessment/flow-copy-assist — the charter, on the server", () => {
  // MUTATION: rely on the rail not drawing the button. A rule that lives in a
  // component's `disabled` attribute is a rule that disappears the next time the
  // button is restyled - and this endpoint is one fetch away from anyone signed in.
  it("refuses a testimonial's own words, in a sentence, spending nothing", async () => {
    for (const blockField of ["quote", "attribution"]) {
      vi.clearAllMocks();
      const res = await POST(
        post({
          ...OK_BODY,
          flow: withTestimonial(),
          target: { nodeId: "welcome", field: "block-text", index: 0, blockField },
        }),
      );
      expect(res.status, blockField).toBe(400);
      const j = (await res.json()) as Reply;
      expect(j.error).toContain("nothing here writes one for you");
      expect(h.consumeBudget).not.toHaveBeenCalled();
      expect(h.createMsg).not.toHaveBeenCalled();
    }
  });

  it("never returns wording that fails the compliance scan", async () => {
    h.state.replies = ["The best NHS smile in London.", "Guaranteed pain free, privately."];
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(200);
    const j = (await res.json()) as Reply;
    expect(j.text).toBeNull();
    expect(j.source).toBe("none");
    expect(j.reason).toBe("non-compliant");
    // One regeneration, then it gives up. Never a third call.
    expect(h.createMsg).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/smile-assessment/flow-copy-assist — the cost guard", () => {
  // MUTATION: share flow-generate's key. Thirty an hour is one afternoon of copy
  // tuning, and the whole-funnel button - the expensive one - would then be dead
  // for the rest of the hour.
  it("consumes its OWN per-practice budget BEFORE the model call", async () => {
    await POST(post(OK_BODY));
    expect(h.consumeBudget).toHaveBeenCalledWith("sa-copy-assist:vitality", 120, 3600);
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
    await POST(post(OK_BODY));
    expect(h.consumeBudget.mock.calls[0]![0] as string).toBe("sa-copy-assist:vitality");
  });

  // THE LETTER OF THE RULE, WHICH NO RUNTIME ASSERTION IN THIS FILE REACHES.
  //
  // The invocation-order test above proves the budget is spent before the model is
  // CALLED. The house rule is stricter: it is spent before the Anthropic CLIENT IS
  // CONSTRUCTED. Hoist `new Anthropic(...)` above the consumeBudget block and every
  // mock-order assertion here stays green - the client is built, the 429 still
  // returns, no message is ever created - while the rule is broken.
  //
  // It matters more on this route than on the drafting one, because this is the
  // button that gets pressed dozens of times in a sitting: whatever construction
  // costs, it costs that many times before the cap has had its say.
  //
  // MUTATION: swap the two statements in route.ts. This assertion is the only thing
  // in the repository that goes red.
  it("spends the budget BEFORE the Anthropic client is constructed, in source order", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/app/api/smile-assessment/flow-copy-assist/route.ts"),
      "utf8",
    );
    const budget = src.indexOf("await consumeBudget(");
    const client = src.indexOf("new Anthropic(");
    expect(budget, "the route no longer consumes a budget").toBeGreaterThan(-1);
    expect(client, "the route no longer constructs a client").toBeGreaterThan(-1);
    expect(budget).toBeLessThan(client);
    expect(src.split("new Anthropic(").length - 1).toBe(1);
    expect(src.split("consumeBudget(").length - 1).toBe(1);
  });
});

describe("POST /api/smile-assessment/flow-copy-assist — the reply", () => {
  it("returns the line the model wrote", async () => {
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(200);
    const j = (await res.json()) as Reply;
    expect(j.ok).toBe(true);
    expect(j.source).toBe("model");
    expect(j.text).toBe("Tell us what you would change.");
  });

  // MUTATION: pass the funnel writer's 3000 max_tokens. This is a button on every
  // copy box; a cap ten times the field's size only pays for a model that ignored
  // the "reply with the line itself" rule.
  it("asks Sonnet with thinking disabled, capped to the FIELD", async () => {
    await POST(post(OK_BODY));
    const [args] = h.createMsg.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(args.model).toBe("claude-sonnet-5");
    expect(args.thinking).toEqual({ type: "disabled" });
    expect(args.max_tokens).toBe(assistMaxTokens(FLOW_LIMITS.headline));
    expect(args.max_tokens as number).toBeLessThanOrEqual(300);
  });

  it("returns nothing, and 200, when the model is unusable", async () => {
    h.createMsg.mockRejectedValue(new Error("upstream 529"));
    const res = await POST(post(OK_BODY));
    expect(res.status).toBe(200);
    const j = (await res.json()) as Reply;
    expect(j.text).toBeNull();
    expect(j.reason).toBe("model-error");
    expect(j.message).toContain("exactly as it was");
  });

  it("refuses a truncated line without retrying it", async () => {
    h.state.stopReason = "max_tokens";
    const res = await POST(post(OK_BODY));
    const j = (await res.json()) as Reply;
    expect(j.text).toBeNull();
    expect(j.reason).toBe("truncated");
    expect(h.createMsg).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/smile-assessment/flow-copy-assist — it writes a line, not a row", () => {
  it("holds no write path: no repository import, no campaign update", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/app/api/smile-assessment/flow-copy-assist/route.ts"),
      "utf8",
    );
    expect(src).not.toContain("campaign-repository");
    expect(src).not.toMatch(/updateCampaign|insertCampaign|setCampaign/);
    // The guard triad, by name: the coverage sweep proves a guard exists at all,
    // and this proves it is the same three the sibling routes carry.
    for (const guard of ["requireUser", "requireClientAccess", "requireModuleApiAccess"]) {
      expect(src).toContain(guard);
    }
  });
});
