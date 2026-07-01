// FIX E regression tests: the practice-brain "create" action must not trust
// the client-supplied classification. Before the fix, ANY authenticated
// session (even maxTier 1) could POST create with result.tier=4 and
// needsReview=false and plant an ACTIVE tier-4 node straight into the
// practice brain (knowledge-poisoning of the agent). Per the design contract
// in src/lib/practice-brain/types.ts ("fail closed to needs_review @ tier 4"),
// callers below the review gate (maxTier < 3, the same gate used by
// needs-review / gaps / resolve-review) must have their created node forced
// to needs_review at tier 4; tier 3+ callers keep the legitimate flow.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signSession } from "@/lib/practice-brain/session";

vi.mock("@/lib/rate-budget", () => ({
  consumeBudget: vi.fn(async () => true),
}));

vi.mock("@/lib/practice-brain/repository", () => ({
  createItem: vi.fn(async (input: Record<string, unknown>) => ({ id: "node-1", ...input })),
  ensureBranch: vi.fn(async () => "branch-1"),
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

vi.mock("@/lib/practice-brain/classify", () => ({ classifyKnowledge: vi.fn() }));
vi.mock("@/lib/practice-brain/retrieval", () => ({ searchKnowledge: vi.fn(async () => []) }));
vi.mock("@/lib/practice-brain/copilot", () => ({ askCopilot: vi.fn() }));

import { POST } from "./route";
import { createItem, ensureBranch } from "@/lib/practice-brain/repository";

const SECRET = "fixE-test-secret";
process.env.PRACTICE_BRAIN_SESSION_SECRET = SECRET;

function post(
  action: string,
  body: unknown,
  maxTier: number,
): [NextRequest, { params: Promise<{ action: string }> }] {
  const token = signSession(
    { credentialId: `cred-tier-${maxTier}`, maxTier, exp: Date.now() + 60_000 },
    SECRET,
  );
  const req = new NextRequest(`http://localhost:3000/api/practice-brain/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-real-ip": "10.0.9.1",
      cookie: `pb_session=${token}`,
    },
  });
  return [req, { params: Promise.resolve({ action }) }];
}

function classification(overrides: Record<string, unknown> = {}) {
  return {
    branch: "Clinical Protocols",
    branchIsNew: false,
    title: "Planted node",
    body: "Attacker-authored knowledge",
    tier: 4,
    tags: ["protocol"],
    confidence: 0.99,
    reasoning: "looks fine",
    needsReview: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(createItem).mockClear();
  vi.mocked(ensureBranch).mockClear();
});

describe("FIX E: create must not trust client-supplied classification", () => {
  it("forces a low-tier (below review gate) create with tier=4/needsReview=false into needs_review at tier 4", async () => {
    const res = await POST(
      ...post("create", { result: classification(), rawInput: "poison note" }, 2),
    );
    expect(res.status).toBe(200);
    expect(createItem).toHaveBeenCalledTimes(1);
    const input = vi.mocked(createItem).mock.calls[0][0];
    // Fail closed: never active, never attached to a live branch.
    expect(input.status).toBe("needs_review");
    expect(input.tier).toBe(4);
    expect(input.parentId).toBeNull();
    expect(ensureBranch).not.toHaveBeenCalled();
  });

  it("forces a tier-1 create claiming a harmless tier=1 active node into needs_review too", async () => {
    const res = await POST(
      ...post("create", { result: classification({ tier: 1 }), rawInput: "poison note" }, 1),
    );
    expect(res.status).toBe(200);
    const input = vi.mocked(createItem).mock.calls[0][0];
    expect(input.status).toBe("needs_review");
    expect(input.tier).toBe(4);
  });

  it("keeps the legitimate owner (tier 4) flow: active node at the classified tier under the branch", async () => {
    const res = await POST(
      ...post(
        "create",
        { result: classification({ tier: 2 }), rawInput: "owner note" },
        4,
      ),
    );
    expect(res.status).toBe(200);
    const input = vi.mocked(createItem).mock.calls[0][0];
    expect(input.status).toBe("active");
    expect(input.tier).toBe(2);
    expect(input.parentId).toBe("branch-1");
    expect(ensureBranch).toHaveBeenCalledWith("vitality", "Clinical Protocols", 2);
  });

  it("still honours needsReview=true from the classifier for a high-tier caller", async () => {
    await POST(
      ...post(
        "create",
        { result: classification({ needsReview: true }), rawInput: "uncertain note" },
        4,
      ),
    );
    const input = vi.mocked(createItem).mock.calls[0][0];
    expect(input.status).toBe("needs_review");
    expect(input.parentId).toBeNull();
  });

  it("clamps an invalid tier value to the fail-closed tier 4 even for the owner", async () => {
    await POST(
      ...post("create", { result: classification({ tier: 99 }), rawInput: "bad tier" }, 4),
    );
    const input = vi.mocked(createItem).mock.calls[0][0];
    expect(input.tier).toBe(4);
  });
});
