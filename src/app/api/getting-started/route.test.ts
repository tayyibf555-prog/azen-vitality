// Getting-started checklist API: ticking is now open to any signed-in role with
// access to the client (not requireOwnerRole), because the practice coordinator
// is normally the one who works through the checklist day to day (src/lib/nav.ts
// no longer marks "getting-started" owner-only). requireClientAccess remains the
// real gate against a foreign client. Auth + repository are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

type User = { id: string; email: string; role: string; clientId: string | null; siteIds: string[] } | null;

const store = vi.hoisted(() => ({
  user: null as User | Response | null,
  saved: [] as { client: string; key: string; checked: boolean; by: string | null }[],
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => store.user,
  requireClientAccess: (u: User, cid: string) =>
    u && u.role !== "agency_admin" && u.clientId !== cid ? Response.json({ error: "forbidden" }, { status: 403 }) : null,
}));

vi.mock("@/lib/getting-started/repository", () => ({
  getChecklistState: async () => ({ consent: true }),
  setChecklistItem: async (client: string, key: string, checked: boolean, by: string | null) => {
    store.saved.push({ client, key, checked, by });
  },
}));

import { GET, POST } from "./route";

const coordinator: NonNullable<User> = { id: "u2", email: "manager@vitality.example", role: "client_coordinator", clientId: "vitality", siteIds: ["site-cc"] };
const owner: NonNullable<User> = { id: "u1", email: "owner@vitality.example", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
const foreignCoordinator: NonNullable<User> = { id: "u9", email: "other@other.example", role: "client_coordinator", clientId: "other", siteIds: [] };

beforeEach(() => {
  store.user = owner;
  store.saved = [];
});

const getReq = (qs: string) => new Request(`http://localhost/api/getting-started?${qs}`);
const postReq = (b: unknown) =>
  new Request("http://localhost/api/getting-started", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(b),
  });

describe("GET /api/getting-started", () => {
  it("requires an authed user", async () => {
    store.user = Response.json({ error: "unauthorized" }, { status: 401 });
    expect((await GET(getReq("client=vitality"))).status).toBe(401);
  });

  it("returns the checklist state for a signed-in client user", async () => {
    const res = await GET(getReq("client=vitality"));
    const data = (await res.json()) as { ok: boolean; state: Record<string, boolean> };
    expect(res.status).toBe(200);
    expect(data.state).toEqual({ consent: true });
  });
});

describe("POST /api/getting-started (tick)", () => {
  it("lets the owner tick an item", async () => {
    store.user = owner;
    const res = await POST(postReq({ client: "vitality", key: "consent", checked: true }));
    expect(res.status).toBe(200);
    expect(store.saved).toEqual([{ client: "vitality", key: "consent", checked: true, by: "owner@vitality.example" }]);
  });

  it("lets the coordinator tick an item too (the checklist is not owner-only)", async () => {
    store.user = coordinator;
    const res = await POST(postReq({ client: "vitality", key: "consent", checked: true }));
    expect(res.status).toBe(200);
    expect(store.saved).toEqual([{ client: "vitality", key: "consent", checked: true, by: "manager@vitality.example" }]);
  });

  it("still blocks a coordinator from a client they do not belong to", async () => {
    store.user = foreignCoordinator;
    const res = await POST(postReq({ client: "vitality", key: "consent", checked: true }));
    expect(res.status).toBe(403);
    expect(store.saved).toHaveLength(0);
  });

  it("requires client and key", async () => {
    const res = await POST(postReq({ client: "vitality" }));
    expect(res.status).toBe(400);
  });
});
