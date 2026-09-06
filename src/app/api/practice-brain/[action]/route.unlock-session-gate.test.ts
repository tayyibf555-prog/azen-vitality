// The unlock door needs a PLATFORM SESSION, not just the per-tier password.
//
// Ruling W3/46. src/proxy.ts's matcher omits "api", so this route never sits
// behind the login proxy — and until the gate under test existed, POST
// /api/practice-brain/unlock accepted a password from the open internet. That
// password is published: supabase/migrations/0003_practice_brain.sql seeds it as
// a literal, it is repeated in docs/superpowers/plans/2026-06-19-practice-brain-
// foundation.md, this repository is PUBLIC, and the live credential still answers
// to it. A correct password mints an 8-hour pb_session carrying maxTier 4, which
// opens every tier of the practice's knowledge base.
//
// So the password alone was a second, weaker authentication system standing beside
// the real one. This suite pins that it no longer is, and pins the ORDER too: the
// session is checked BEFORE the rate limits, so an anonymous caller cannot burn
// the shared 100-per-hour unlock budget and lock the practice out of its own brain.
//
// The guard is mocked (as in route.owner-write-gate.test.ts) so requireUser can be
// driven through its three real shapes: null when auth enforcement is off, a 401
// Response when enforced-and-signed-out, and the user when enforced-and-signed-in.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// route.ts imports guard.ts, which does `import "server-only"` (unresolvable in the
// node test env). Stub it even though the guard module itself is mocked below.
vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireOwnerRole: vi.fn(() => null),
  consumeBudget: vi.fn(async () => true),
  // Typed with the null branch so a test can drive the wrong-password path.
  verifyCredential: vi.fn(async (): Promise<{ id: string; label: string; tier: number } | null> => ({
    id: "cred-1", label: "Owner", tier: 4,
  })),
}));
vi.mock("@/lib/auth/guard", () => ({ requireUser: h.requireUser, requireOwnerRole: h.requireOwnerRole }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("@/lib/practice-brain/repository", () => ({
  createItem: vi.fn(),
  ensureBranch: vi.fn(),
  listActiveNodes: vi.fn(async () => []),
  listBranchNames: vi.fn(async () => []),
  listNeedsReview: vi.fn(async () => []),
  listOpenGaps: vi.fn(async () => []),
  logKnowledgeGap: vi.fn(),
  logQa: vi.fn(),
  resolveGap: vi.fn(),
  resolveReview: vi.fn(),
  setQaFeedback: vi.fn(),
  verifyCredential: h.verifyCredential,
}));
vi.mock("@/lib/practice-brain/classify", () => ({ classifyKnowledge: vi.fn() }));
vi.mock("@/lib/practice-brain/retrieval", () => ({ searchKnowledge: vi.fn(async () => []) }));
vi.mock("@/lib/practice-brain/copilot", () => ({ askCopilot: vi.fn() }));

import { POST } from "./route";

process.env.PRACTICE_BRAIN_SESSION_SECRET = "unlock-session-gate-test-secret";

const OWNER = { id: "u1", email: "o@x", role: "client_owner", clientId: "vitality", siteIds: [] };

function unlock(password = "vitality-owner-2026"): [NextRequest, { params: Promise<{ action: string }> }] {
  const req = new NextRequest("http://localhost:3000/api/practice-brain/unlock", {
    method: "POST",
    body: JSON.stringify({ password }),
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
  });
  return [req, { params: Promise.resolve({ action: "unlock" }) }];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.consumeBudget.mockResolvedValue(true);
  h.verifyCredential.mockResolvedValue({ id: "cred-1", label: "Owner", tier: 4 });
});

describe("practice-brain unlock requires a platform session (W3/46)", () => {
  it("refuses a signed-out caller holding the PUBLISHED password, and mints no session cookie", async () => {
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));

    const res = await POST(...unlock());

    expect(res.status).toBe(401);
    expect(
      res.headers.get("set-cookie"),
      "a refused unlock must not hand back a pb_session at any tier",
    ).toBeNull();
  });

  it("never reaches the credential check for a signed-out caller, so the password is not even tested", async () => {
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));

    await POST(...unlock());

    expect(h.verifyCredential).not.toHaveBeenCalled();
  });

  it("checks the session BEFORE the rate limits, so a signed-out caller cannot burn the shared unlock budget", async () => {
    // The budget is the practice's own lock-out risk: 100 unlock attempts an hour
    // are shared across every instance, so an anonymous loop that consumed one per
    // request would deny the owner their own brain.
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));

    await POST(...unlock());

    expect(h.consumeBudget).not.toHaveBeenCalled();
  });

  it("CONTROL: a signed-in caller with the right password still unlocks, and still gets the cookie", async () => {
    h.requireUser.mockResolvedValue(OWNER);

    const res = await POST(...unlock());

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("pb_session=");
    expect(h.verifyCredential).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a signed-in caller with the WRONG password is still refused, so the session is not a bypass", async () => {
    h.requireUser.mockResolvedValue(OWNER);
    h.verifyCredential.mockResolvedValue(null);

    const res = await POST(...unlock("not-the-password"));

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("CONTROL: with auth enforcement OFF the gate is a no-op, so the un-enforced local demo is unchanged", async () => {
    // requireUser returns null when SUPABASE_SERVICE_ROLE_KEY is absent.
    h.requireUser.mockResolvedValue(null);

    const res = await POST(...unlock());

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("pb_session=");
  });
});
