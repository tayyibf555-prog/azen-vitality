// Owner-only WRITE gate for the practice brain.
//
// The brain is a password-gated portal layered ON TOP of the platform login.
// Since ruling W3/46 the unlock itself requires a platform session as well as the
// per-tier password (pinned in route.unlock-session-gate.test.ts), so the read
// actions (tree, ask, needs-review, gaps, qa-feedback, classify) are reachable
// only with an unlock cookie that a signed-in user minted; the per-tier password
// decides WHICH tiers those reads return. This
// suite covers the gate layered on top of that: the content-mutating actions (create,
// learn, resolve-gap, resolve-review) ALSO require a platform session with an
// owner/agency role, so a practice manager (client_coordinator) is refused even
// with a valid unlock cookie, while the read/unlock portal actions are unchanged.
//
// The guard is mocked (as in the patients-status route test) so requireUser /
// requireOwnerRole can be driven per role; requireOwnerRole keeps its real shape
// (403 for a non-owner enforced user, pass-through for null/owner/agency).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signSession } from "@/lib/practice-brain/session";

// route.ts imports guard.ts, which does `import "server-only"` (unresolvable in the
// node test env). Stub it even though the guard module itself is mocked below.
vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  // Faithful mini-impl of the real requireOwnerRole: 403 for a non-owner enforced
  // user; null for owner/agency AND for the not-enforced null user (no-op).
  requireOwnerRole: vi.fn((user: { role?: string } | null) =>
    user && user.role !== "client_owner" && user.role !== "agency_admin"
      ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      : null,
  ),
}));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireOwnerRole: h.requireOwnerRole,
}));

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
vi.mock("@/lib/practice-brain/classify", () => ({
  classifyKnowledge: vi.fn(async () => ({
    branch: "Clinical Protocols",
    branchIsNew: false,
    title: "Captured note",
    body: "Body",
    tier: 2,
    tags: ["protocol"],
    confidence: 0.9,
    reasoning: "ok",
    needsReview: false,
  })),
}));
vi.mock("@/lib/practice-brain/retrieval", () => ({ searchKnowledge: vi.fn(async () => []) }));
vi.mock("@/lib/practice-brain/copilot", () => ({
  askCopilot: vi.fn(async () => ({ answer: "a", groundedIn: [], citations: [] })),
}));

import { POST } from "./route";
import { createItem, resolveGap, resolveReview } from "@/lib/practice-brain/repository";

const SECRET = "owner-write-gate-test-secret";
process.env.PRACTICE_BRAIN_SESSION_SECRET = SECRET;

const OWNER = { id: "u1", email: "o@x", role: "client_owner", clientId: "vitality", siteIds: [] };
const COORD = { id: "u2", email: "c@x", role: "client_coordinator", clientId: "vitality", siteIds: [] };

function post(
  action: string,
  body: unknown,
  maxTier = 4,
): [NextRequest, { params: Promise<{ action: string }> }] {
  const token = signSession({ credentialId: "cred", maxTier, exp: Date.now() + 60_000 }, SECRET);
  const req = new NextRequest(`http://localhost:3000/api/practice-brain/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-real-ip": "10.0.9.9",
      cookie: `pb_session=${token}`,
    },
  });
  return [req, { params: Promise.resolve({ action }) }];
}

// A well-formed body for each content-mutating action (tier 4 unlock => would pass
// the existing publish/tier gates, so only the owner gate can block it).
const MUTATING: [string, unknown][] = [
  [
    "create",
    {
      rawInput: "note",
      result: {
        tier: 2,
        needsReview: false,
        branch: "Clinical Protocols",
        title: "t",
        body: "b",
        tags: [],
        confidence: 1,
        reasoning: "r",
        branchIsNew: false,
      },
    },
  ],
  ["learn", { text: "a captured note" }],
  ["resolve-gap", { id: "gap-1" }],
  ["resolve-review", { id: "rev-1", branch: "Clinical Protocols", tier: 2 }],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.requireOwnerRole.mockImplementation((user: { role?: string } | null) =>
    user && user.role !== "client_owner" && user.role !== "agency_admin"
      ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      : null,
  );
});

describe("practice-brain: owner-only write gate", () => {
  it("403s a coordinator platform session on every content-mutating action (even with a tier-4 unlock)", async () => {
    h.requireUser.mockResolvedValue(COORD);
    for (const [action, body] of MUTATING) {
      const res = await POST(...post(action, body));
      expect(res.status, `${action} must 403 a coordinator`).toBe(403);
    }
    // The gate fires before any repository write, so nothing was mutated.
    expect(createItem).not.toHaveBeenCalled();
    expect(resolveGap).not.toHaveBeenCalled();
    expect(resolveReview).not.toHaveBeenCalled();
  });

  it("lets an owner platform session through (happy path: create writes a node)", async () => {
    h.requireUser.mockResolvedValue(OWNER);
    const [action, body] = MUTATING[0];
    const res = await POST(...post(action, body));
    expect(res.status).toBe(200);
    expect(createItem).toHaveBeenCalledTimes(1);
  });

  it("401s an enforced-but-anonymous caller on a write (unlock cookie is not a platform login)", async () => {
    // requireUser returns a 401 Response when auth is enforced and nobody is signed in.
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const [action, body] = MUTATING[0];
    const res = await POST(...post(action, body));
    expect(res.status).toBe(401);
    expect(createItem).not.toHaveBeenCalled();
  });

  it("does NOT gate the password-portal READ actions: tree works on the unlock cookie alone, even enforced+anon", async () => {
    // Even with requireUser primed to a 401 (enforced + no platform login), a read
    // must succeed on the unlock cookie: reads are password-portal only, by design.
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await POST(...post("tree", {}));
    expect(res.status).toBe(200);
    // The owner gate is never consulted for a read action.
    expect(h.requireUser).not.toHaveBeenCalled();
  });

  it("is a no-op when auth is not enforced (requireUser null): a write still works on the unlock cookie", async () => {
    // Not enforced -> requireUser() returns null -> requireOwnerRole(null) -> null,
    // so the existing password-portal behaviour (and every prior test) is unchanged.
    h.requireUser.mockResolvedValue(null);
    const [action, body] = MUTATING[0];
    const res = await POST(...post(action, body));
    expect(res.status).toBe(200);
    expect(createItem).toHaveBeenCalledTimes(1);
  });
});
