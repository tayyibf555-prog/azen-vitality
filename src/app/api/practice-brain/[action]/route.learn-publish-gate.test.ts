// Security regression: the practice-brain "learn" action (co-pilot capture) must
// apply the SAME publish gate as "create". Before the fix, any unlocked session
// (even maxTier 1) could POST /api/practice-brain/learn with a note crafted so
// the classifier returns needsReview=false and a chosen tier, planting an ACTIVE
// node into the shared brain (which the co-pilot then treats as authoritative
// grounding), bypassing the review queue that "create" forces on the same
// low-tier session. Callers below the review gate (maxTier < 3) must land in
// needs_review at tier 4; tier 3+ callers keep the legitimate flow.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signSession } from "@/lib/practice-brain/session";

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: vi.fn(async () => true) }));

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
import { classifyKnowledge } from "@/lib/practice-brain/classify";

const SECRET = "learn-gate-test-secret";
process.env.PRACTICE_BRAIN_SESSION_SECRET = SECRET;

function post(
  body: unknown,
  maxTier: number,
): [NextRequest, { params: Promise<{ action: string }> }] {
  const token = signSession(
    { credentialId: `cred-tier-${maxTier}`, maxTier, exp: Date.now() + 60_000 },
    SECRET,
  );
  const req = new NextRequest("http://localhost:3000/api/practice-brain/learn", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-real-ip": "10.0.9.2",
      cookie: `pb_session=${token}`,
    },
  });
  return [req, { params: Promise.resolve({ action: "learn" }) }];
}

function classifierReturns(overrides: Record<string, unknown> = {}) {
  vi.mocked(classifyKnowledge).mockResolvedValue({
    branch: "Clinical Protocols",
    branchIsNew: false,
    title: "Captured note",
    body: "Attacker-authored knowledge",
    tier: 1,
    tags: ["protocol"],
    confidence: 0.9,
    reasoning: "looks fine",
    needsReview: false,
    ...overrides,
  } as never);
}

beforeEach(() => {
  vi.mocked(createItem).mockClear();
  vi.mocked(ensureBranch).mockClear();
});

describe("practice-brain learn action: publish gate (parity with create)", () => {
  it("forces a low-tier (below review gate) learn into needs_review at tier 4", async () => {
    classifierReturns({ tier: 1, needsReview: false });
    const res = await POST(...post({ text: "crafted note to plant an active node" }, 2));
    expect(res.status).toBe(200);
    expect(createItem).toHaveBeenCalledTimes(1);
    const input = vi.mocked(createItem).mock.calls[0][0];
    // Fail closed: never active, never attached to a live branch.
    expect(input.status).toBe("needs_review");
    expect(input.tier).toBe(4);
    expect(input.parentId).toBeNull();
    expect(ensureBranch).not.toHaveBeenCalled();
  });

  it("forces a tier-1 caller claiming a harmless active node into needs_review too", async () => {
    classifierReturns({ tier: 1, needsReview: false });
    const res = await POST(...post({ text: "another crafted note" }, 1));
    expect(res.status).toBe(200);
    const input = vi.mocked(createItem).mock.calls[0][0];
    expect(input.status).toBe("needs_review");
    expect(input.tier).toBe(4);
  });

  it("keeps the legitimate owner (tier 4) capture: active node at the classified tier under the branch", async () => {
    classifierReturns({ tier: 2, needsReview: false });
    const res = await POST(...post({ text: "owner captures a real SOP" }, 4));
    expect(res.status).toBe(200);
    const input = vi.mocked(createItem).mock.calls[0][0];
    expect(input.status).toBe("active");
    expect(input.tier).toBe(2);
    expect(input.parentId).toBe("branch-1");
  });

  it("still honours needsReview=true from the classifier for a high-tier caller", async () => {
    classifierReturns({ tier: 3, needsReview: true });
    await POST(...post({ text: "uncertain capture" }, 4));
    const input = vi.mocked(createItem).mock.calls[0][0];
    expect(input.status).toBe("needs_review");
    expect(input.parentId).toBeNull();
  });
});
