// AREA 5 (API auth coverage) regression tests for the practice-brain route.
//
// The unlock action is the only password-guessing surface in the app: a single
// shared password per tier protects tier 1-4 practice knowledge. These tests
// prove (a) unlock is rate-limited per IP and by the shared api_budget BEFORE
// the credential check runs, and (b) every other action stays locked without a
// valid signed session cookie.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { signSession } from "@/lib/practice-brain/session";

// route.ts imports guard.ts, which does `import "server-only"` (unresolvable in the
// node test env). Stub it; the owner-write gate is a no-op here anyway (auth is not
// enforced without a service-role key), so the unlock + locked-without-cookie
// assertions below are unchanged.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/rate-budget", () => ({
  consumeBudget: vi.fn(async () => true),
}));

vi.mock("@/lib/practice-brain/repository", () => ({
  createItem: vi.fn(),
  ensureBranch: vi.fn(),
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
import { verifyCredential } from "@/lib/practice-brain/repository";
import { consumeBudget } from "@/lib/rate-budget";

const SECRET = "area5-test-secret";
process.env.PRACTICE_BRAIN_SESSION_SECRET = SECRET;

function post(
  action: string,
  body: unknown,
  headers: Record<string, string> = {},
): [NextRequest, { params: Promise<{ action: string }> }] {
  const req = new NextRequest(`http://localhost:3000/api/practice-brain/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
  return [req, { params: Promise.resolve({ action }) }];
}

beforeEach(() => {
  vi.mocked(verifyCredential).mockClear();
  vi.mocked(verifyCredential).mockResolvedValue(null);
  vi.mocked(consumeBudget).mockClear();
  vi.mocked(consumeBudget).mockResolvedValue(true);
});

describe("practice-brain unlock brute-force guard", () => {
  it("rejects a wrong password with 401 (credential check reached when within limits)", async () => {
    const res = await POST(...post("unlock", { password: "wrong" }, { "x-real-ip": "10.0.0.1" }));
    expect(res.status).toBe(401);
    expect(verifyCredential).toHaveBeenCalledWith("vitality", "wrong");
  });

  it("unlocks with a valid password and sets the signed session cookie", async () => {
    vi.mocked(verifyCredential).mockResolvedValue({ id: "cred-1", label: "Owner", tier: 4 });
    const res = await POST(...post("unlock", { password: "right" }, { "x-real-ip": "10.0.0.2" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { maxTier: number } };
    expect(json.success).toBe(true);
    expect(json.data.maxTier).toBe(4);
    expect(res.headers.get("set-cookie")).toContain("pb_session=");
  });

  it("returns 429 and never touches the credential check when the shared budget is exhausted", async () => {
    vi.mocked(consumeBudget).mockResolvedValue(false);
    const res = await POST(...post("unlock", { password: "guess" }, { "x-real-ip": "10.0.0.3" }));
    expect(res.status).toBe(429);
    expect(verifyCredential).not.toHaveBeenCalled();
    expect(consumeBudget).toHaveBeenCalledWith("pb-unlock", expect.any(Number), 3600);
  });

  it("caps unlock attempts per IP: the 21st attempt in an hour is refused before the credential check", async () => {
    const ip = { "x-real-ip": "10.0.0.4" };
    for (let i = 0; i < 20; i += 1) {
      const res = await POST(...post("unlock", { password: `guess-${i}` }, ip));
      expect(res.status).toBe(401); // wrong password, but the attempt was allowed
    }
    expect(verifyCredential).toHaveBeenCalledTimes(20);
    const blocked = await POST(...post("unlock", { password: "guess-21" }, ip));
    expect(blocked.status).toBe(429);
    expect(verifyCredential).toHaveBeenCalledTimes(20); // not called for the blocked attempt
  });
});

describe("practice-brain session gate on every other action", () => {
  it("refuses any non-unlock action without the session cookie", async () => {
    for (const action of ["tree", "classify", "ask", "learn", "gaps"]) {
      const res = await POST(...post(action, {}, { "x-real-ip": "10.0.1.1" }));
      expect(res.status).toBe(401);
    }
  });

  it("refuses a session signed with the wrong secret", async () => {
    const forged = signSession(
      { credentialId: "cred-1", maxTier: 4, exp: Date.now() + 60_000 },
      "not-the-real-secret",
    );
    const res = await POST(
      ...post("tree", {}, { "x-real-ip": "10.0.1.2", cookie: `pb_session=${forged}` }),
    );
    expect(res.status).toBe(401);
  });

  it("serves a valid signed session, and tier-gated actions refuse a low tier", async () => {
    const token = signSession(
      { credentialId: "cred-1", maxTier: 2, exp: Date.now() + 60_000 },
      SECRET,
    );
    const headers = { "x-real-ip": "10.0.1.3", cookie: `pb_session=${token}` };
    const tree = await POST(...post("tree", {}, headers));
    expect(tree.status).toBe(200);
    const gaps = await POST(...post("gaps", {}, headers)); // requires tier >= 3
    expect(gaps.status).toBe(403);
  });
});
