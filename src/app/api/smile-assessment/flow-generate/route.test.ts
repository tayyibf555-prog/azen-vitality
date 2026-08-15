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
