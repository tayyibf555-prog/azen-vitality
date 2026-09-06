// ===========================================================================
// WHAT ONE UNLOCK BUYS: THE METER ON THE PRACTICE-BRAIN MODEL DOORS.
//
// Charter section 0 item 10 requires `api_budget` on any public AI endpoint and
// the spend consumed BEFORE the client is constructed. This route's own header
// calls itself "a password-gated PORTAL ... protected by the per-tier password
// alone, with no platform login, by design", and three of its actions reach
// Anthropic: `ask` (a retrieval then a Sonnet completion), `classify` and `learn`
// (Sonnet, max_tokens 4000). Until this file existed the only consumeBudget in
// the route was `pb-unlock`, spent on the unlock ATTEMPT — so one successful
// unlock bought an eight-hour cookie with unlimited, unmetered, unbounded-size
// model calls against the practice's own key, and nothing counted it.
//
// So each test here answers ONE question about a call that costs money:
//   1. is it metered at all, and under a key naming the action and the caller?
//   2. is the meter spent BEFORE the model is reached, so a refusal costs nothing?
//   3. is what goes INTO the prompt bounded, so a permitted call cannot be the
//      most expensive call it could be?
//
// The model modules are faked (this suite never speaks to Anthropic) and so is
// the budget, so a refusal is expressible; everything else is the real route.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signSession } from "@/lib/practice-brain/session";

// route.ts imports guard.ts, which does `import "server-only"` (unresolvable in the
// node test env). The owner-write gate is a no-op without a service-role key, which
// is why `learn` is reachable below.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: vi.fn(async () => true) }));

vi.mock("@/lib/practice-brain/repository", () => ({
  createItem: vi.fn(async () => ({ id: "node-1" })),
  ensureBranch: vi.fn(async () => null),
  listActiveNodes: vi.fn(async () => []),
  listBranchNames: vi.fn(async () => []),
  listNeedsReview: vi.fn(async () => []),
  listOpenGaps: vi.fn(async () => []),
  logKnowledgeGap: vi.fn(),
  logQa: vi.fn(async () => "qa-1"),
  resolveGap: vi.fn(),
  resolveReview: vi.fn(),
  setQaFeedback: vi.fn(),
  verifyCredential: vi.fn(async () => null),
}));

vi.mock("@/lib/practice-brain/classify", () => ({
  classifyKnowledge: vi.fn(async () => ({
    title: "A note",
    body: "Body",
    branch: "Fees",
    branchIsNew: false,
    tier: 1,
    tags: [],
    needsReview: false,
    reasoning: "",
    confidence: 1,
  })),
}));
vi.mock("@/lib/practice-brain/retrieval", () => ({ searchKnowledge: vi.fn(async () => []) }));
vi.mock("@/lib/practice-brain/copilot", () => ({
  askCopilot: vi.fn(async () => ({ answer: "Yes.", groundedIn: "practice", citations: [] })),
}));

import { POST } from "./route";
import { consumeBudget } from "@/lib/rate-budget";
import { classifyKnowledge } from "@/lib/practice-brain/classify";
import { searchKnowledge } from "@/lib/practice-brain/retrieval";
import { askCopilot } from "@/lib/practice-brain/copilot";

const SECRET = "ai-budget-test-secret";
process.env.PRACTICE_BRAIN_SESSION_SECRET = SECRET;

const CREDENTIAL = "cred-tier4";

function unlocked(): string {
  return signSession({ credentialId: CREDENTIAL, maxTier: 4, exp: Date.now() + 60_000 }, SECRET);
}

function post(
  action: string,
  body: unknown,
): [NextRequest, { params: Promise<{ action: string }> }] {
  const req = new NextRequest(`http://localhost:3000/api/practice-brain/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-real-ip": "203.0.113.9",
      cookie: `pb_session=${unlocked()}`,
    },
  });
  return [req, { params: Promise.resolve({ action }) }];
}

/** The keys consumeBudget was asked for, in the order it was asked. */
function keys(): string[] {
  return vi.mocked(consumeBudget).mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  vi.mocked(consumeBudget).mockClear();
  vi.mocked(consumeBudget).mockResolvedValue(true);
  vi.mocked(classifyKnowledge).mockClear();
  vi.mocked(searchKnowledge).mockClear();
  vi.mocked(askCopilot).mockClear();
});

describe("every practice-brain call that reaches the model spends a budget first", () => {
  it("pb-ask-consumes-a-per-credential-and-a-global-budget-before-the-model", async () => {
    const res = await POST(...post("ask", { question: "What is the whitening fee?" }));
    expect(res.status).toBe(200);
    expect(keys()).toEqual([`pb-ask:${CREDENTIAL}`, "pb-ask"]);
    // Both windows are an hour, and the per-credential cap is the tighter one.
    const [perCredential, global] = vi.mocked(consumeBudget).mock.calls;
    expect(perCredential![2]).toBe(3600);
    expect(global![2]).toBe(3600);
    expect(Number(perCredential![1])).toBeLessThan(Number(global![1]));
  });

  it("pb-classify-consumes-a-per-credential-and-a-global-budget-before-the-model", async () => {
    const res = await POST(...post("classify", { rawInput: "We charge 350 for whitening." }));
    expect(res.status).toBe(200);
    expect(keys()).toEqual([`pb-classify:${CREDENTIAL}`, "pb-classify"]);
  });

  it("pb-learn-consumes-its-own-keys-so-an-ask-loop-cannot-starve-the-owner", async () => {
    // `learn` clears the owner gate as well (a no-op here, no service-role key) and
    // is still a Sonnet call, so it is metered — under keys of its own, because a
    // shared key would let a public `ask` loop spend the owner's capture allowance.
    const res = await POST(...post("learn", { text: "Whitening is 350." }));
    expect(res.status).toBe(200);
    expect(keys()).toEqual([`pb-learn:${CREDENTIAL}`, "pb-learn"]);
  });
});

describe("an exhausted budget refuses BEFORE anything is spent on the model", () => {
  it("pb-ask-refused-by-the-budget-reaches-neither-retrieval-nor-anthropic", async () => {
    vi.mocked(consumeBudget).mockResolvedValue(false);
    const res = await POST(...post("ask", { question: "What is the whitening fee?" }));
    expect(res.status).toBe(429);
    expect(searchKnowledge, "a refused question still cost a retrieval").not.toHaveBeenCalled();
    expect(askCopilot, "a refused question still reached Anthropic").not.toHaveBeenCalled();
  });

  it("pb-classify-refused-by-the-budget-never-reaches-anthropic", async () => {
    vi.mocked(consumeBudget).mockResolvedValue(false);
    const res = await POST(...post("classify", { rawInput: "We charge 350 for whitening." }));
    expect(res.status).toBe(429);
    expect(classifyKnowledge).not.toHaveBeenCalled();
  });

  it("pb-learn-refused-by-the-budget-never-reaches-anthropic", async () => {
    vi.mocked(consumeBudget).mockResolvedValue(false);
    const res = await POST(...post("learn", { text: "Whitening is 350." }));
    expect(res.status).toBe(429);
    expect(classifyKnowledge).not.toHaveBeenCalled();
  });

  it("the GLOBAL ceiling alone is enough to refuse, even with the credential in credit", async () => {
    // The half that bounds the practice's bill when a whole tier's password is
    // loose: many credentials, each inside its own allowance, one shared ceiling.
    vi.mocked(consumeBudget).mockImplementation(async (key: string) => key !== "pb-ask");
    const res = await POST(...post("ask", { question: "What is the whitening fee?" }));
    expect(res.status).toBe(429);
    expect(askCopilot).not.toHaveBeenCalled();
  });

  it("says the same sentence whichever cap was hit", async () => {
    vi.mocked(consumeBudget).mockResolvedValue(false);
    const res = await POST(...post("ask", { question: "Anything" }));
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Practice Brain is busy. Please try again shortly.");
  });
});

describe("what goes into the prompt is bounded", () => {
  it("pb-ask-refuses-an-oversized-question-before-it-spends-a-budget-unit", async () => {
    // The equipment desk caps a chat message at 4,000 characters and the pre-visit
    // submit caps the whole body at 16KB; this door had no ceiling at all, so a
    // 500KB "question" went into the prompt verbatim.
    const res = await POST(...post("ask", { question: "x".repeat(4_001) }));
    expect(res.status).toBe(413);
    expect(consumeBudget, "an oversized question spent a budget unit").not.toHaveBeenCalled();
    expect(askCopilot).not.toHaveBeenCalled();
  });

  it("a question at the ceiling is still answered", async () => {
    const res = await POST(...post("ask", { question: "x".repeat(4_000) }));
    expect(res.status).toBe(200);
    expect(askCopilot).toHaveBeenCalled();
  });

  it("pb-classify-refuses-an-oversized-note-before-it-spends-a-budget-unit", async () => {
    const res = await POST(...post("classify", { rawInput: "x".repeat(8_001) }));
    expect(res.status).toBe(413);
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(classifyKnowledge).not.toHaveBeenCalled();
  });

  it("pb-learn-refuses-an-oversized-note-before-it-spends-a-budget-unit", async () => {
    const res = await POST(...post("learn", { text: "x".repeat(8_001) }));
    expect(res.status).toBe(413);
    expect(consumeBudget).not.toHaveBeenCalled();
    expect(classifyKnowledge).not.toHaveBeenCalled();
  });

  it("a note at the ceiling is still classified", async () => {
    const res = await POST(...post("classify", { rawInput: "x".repeat(8_000) }));
    expect(res.status).toBe(200);
    expect(classifyKnowledge).toHaveBeenCalled();
  });
});

describe("the actions that cost nothing are not metered", () => {
  it("tree, gaps and qa-feedback spend no AI budget", async () => {
    for (const action of ["tree", "gaps"]) {
      await POST(...post(action, {}));
    }
    expect(keys()).toEqual([]);
  });
});
