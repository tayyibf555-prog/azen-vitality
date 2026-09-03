// OWNER-ONLY, PROVEN PER ROLE.
//
// The approved-authorities list decides what external context the co-pilot may
// lean on when it answers ANYBODY in the practice. A role that can add a row can
// put words into every answer the co-pilot gives, which is why this surface is
// the principal's and not the practice manager's — even though she has the
// co-pilot itself, and even though she is an approver everywhere else.
//
// The guard module is mocked (the pattern the practice-brain owner-write-gate
// suite uses) so each guard can be driven per role, with faithful mini-impls of
// the two role guards: a 403 for the role they exclude, and a pass-through for
// null, which is what the real guards return when auth enforcement is off.
import { describe, it, expect, vi, beforeEach } from "vitest";

// route.ts -> guard.ts / repository.ts both do `import "server-only"`, which does
// not resolve in the node test env.
vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireClientAccess: vi.fn(() => null as Response | null),
  // Faithful to @/lib/nav: the co-pilot slug names owner, agency and the
  // coordinator, so the clinician and staff roles are the ones this refuses.
  requireModuleApiAccess: vi.fn((user: { role?: string } | null, slug: string) =>
    user && slug === "co-pilot" && !["agency_admin", "client_owner", "client_coordinator"].includes(user.role ?? "")
      ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      : null,
  ),
  // Faithful to the real requireOwnerRole: 403 for a non-owner enforced user;
  // null for owner/agency AND for the not-enforced null user.
  requireOwnerRole: vi.fn((user: { role?: string } | null) =>
    user && user.role !== "client_owner" && user.role !== "agency_admin"
      ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      : null,
  ),
}));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: h.requireUser,
  requireClientAccess: h.requireClientAccess,
  requireModuleApiAccess: h.requireModuleApiAccess,
  requireOwnerRole: h.requireOwnerRole,
}));

const repo = vi.hoisted(() => ({
  listAllAuthorities: vi.fn(async () => []),
  createAuthority: vi.fn(async () => ({ id: "auth-1" })),
  updateAuthority: vi.fn(async () => ({ id: "auth-1" })),
  archiveAuthority: vi.fn(async () => ({ id: "auth-1" })),
}));
vi.mock("@/lib/knowledge/repository", () => repo);

import { POST } from "./route";

const OWNER = { id: "u1", email: "o@x", role: "client_owner", clientId: "vitality", siteIds: [] };
const AGENCY = { id: "u0", email: "a@x", role: "agency_admin", clientId: null, siteIds: [] };
const COORD = { id: "u2", email: "c@x", role: "client_coordinator", clientId: "vitality", siteIds: [] };
const CLINICIAN = { id: "u3", email: "d@x", role: "client_clinician", clientId: "vitality", siteIds: [] };
const STAFF = { id: "u4", email: "s@x", role: "client_staff", clientId: "vitality", siteIds: [] };

const GOOD_BODY = {
  client: "vitality",
  name: "Standards for the Dental Team",
  kind: "regulator",
  publisher: "General Dental Council",
  summary: "The nine principles registrants work to.",
};

function post(action: string, body: unknown): [Request, { params: Promise<{ action: string }> }] {
  const req = new Request(`http://localhost:3000/api/authorities/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return [req, { params: Promise.resolve({ action }) }];
}

const ACTIONS: [string, unknown][] = [
  ["list", { client: "vitality" }],
  ["create", GOOD_BODY],
  ["update", { ...GOOD_BODY, id: "auth-1" }],
  ["archive", { client: "vitality", id: "auth-1" }],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.requireClientAccess.mockReturnValue(null);
  h.requireModuleApiAccess.mockImplementation((user: { role?: string } | null, slug: string) =>
    user && slug === "co-pilot" && !["agency_admin", "client_owner", "client_coordinator"].includes(user.role ?? "")
      ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      : null,
  );
  h.requireOwnerRole.mockImplementation((user: { role?: string } | null) =>
    user && user.role !== "client_owner" && user.role !== "agency_admin"
      ? Response.json({ ok: false, error: "forbidden" }, { status: 403 })
      : null,
  );
});

describe("approved authorities: a non-owner role is refused", () => {
  it.each([
    ["client_coordinator", COORD],
    ["client_clinician", CLINICIAN],
    ["client_staff", STAFF],
  ])("403s a %s on every action, and nothing reaches the repository", async (_label, user) => {
    h.requireUser.mockResolvedValue(user);
    for (const [action, body] of ACTIONS) {
      const res = await POST(...post(action, body));
      expect(res.status, `${action} must 403 a ${_label}`).toBe(403);
    }
    expect(repo.listAllAuthorities).not.toHaveBeenCalled();
    expect(repo.createAuthority).not.toHaveBeenCalled();
    expect(repo.updateAuthority).not.toHaveBeenCalled();
    expect(repo.archiveAuthority).not.toHaveBeenCalled();
  });

  it("401s an enforced-but-anonymous caller before touching the repository", async () => {
    h.requireUser.mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const res = await POST(...post("create", GOOD_BODY));
    expect(res.status).toBe(401);
    expect(repo.createAuthority).not.toHaveBeenCalled();
  });

  it("403s a caller from another practice (tenancy, before the role question)", async () => {
    h.requireUser.mockResolvedValue(OWNER);
    h.requireClientAccess.mockReturnValue(Response.json({ error: "forbidden" }, { status: 403 }));
    const res = await POST(...post("list", { client: "vitality" }));
    expect(res.status).toBe(403);
    expect(repo.listAllAuthorities).not.toHaveBeenCalled();
  });
});

describe("approved authorities: an owner is not refused", () => {
  it.each([
    ["client_owner", OWNER],
    ["agency_admin", AGENCY],
  ])("lets a %s through on every action", async (_label, user) => {
    h.requireUser.mockResolvedValue(user);
    for (const [action, body] of ACTIONS) {
      const res = await POST(...post(action, body));
      expect(res.status, `${action} must succeed for a ${_label}`).toBe(200);
    }
    expect(repo.listAllAuthorities).toHaveBeenCalledTimes(1);
    expect(repo.createAuthority).toHaveBeenCalledTimes(1);
    expect(repo.updateAuthority).toHaveBeenCalledTimes(1);
    expect(repo.archiveAuthority).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when auth is not enforced (requireUser null): the local demo is unchanged", async () => {
    h.requireUser.mockResolvedValue(null);
    const res = await POST(...post("create", GOOD_BODY));
    expect(res.status).toBe(200);
    expect(repo.createAuthority).toHaveBeenCalledTimes(1);
  });

  it("scopes every write by the resolved client id, never by the id alone", async () => {
    h.requireUser.mockResolvedValue(OWNER);
    await POST(...post("update", { ...GOOD_BODY, id: "auth-1" }));
    await POST(...post("archive", { client: "vitality", id: "auth-1" }));
    expect(repo.updateAuthority).toHaveBeenCalledWith("vitality", "auth-1", expect.anything());
    expect(repo.archiveAuthority).toHaveBeenCalledWith("vitality", "auth-1");
  });

  it("refuses an unknown client slug before any guard resolves a session", async () => {
    h.requireUser.mockResolvedValue(OWNER);
    const res = await POST(...post("list", { client: "not-a-practice" }));
    expect(res.status).toBe(400);
    expect(h.requireUser).not.toHaveBeenCalled();
  });

  it("passes an over-ceiling body to the validator and refuses it with a 400, storing nothing", async () => {
    h.requireUser.mockResolvedValue(OWNER);
    const res = await POST(...post("create", { ...GOOD_BODY, summary: "x".repeat(2001) }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("2001");
    expect(repo.createAuthority).not.toHaveBeenCalled();
  });
});
