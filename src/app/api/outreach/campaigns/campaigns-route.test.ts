// Campaign API: owner-gate + validation for POST /api/outreach/campaigns, and the
// PATCH /[id] launch gating (only from ready, needs a message angle, REFUSED while the
// outreach system is off). Auth/clients/repository/systems/build are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

type Campaign = {
  id: string;
  clientId: string;
  status: string;
  messageAngle: string | null;
  siteId: string;
  filters: Record<string, unknown>;
  practitionerName: string | null;
  dailyCap: number;
};

const store = vi.hoisted(() => ({
  user: { id: "u1", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] } as {
    id: string;
    role: string;
    clientId: string | null;
    siteIds: string[];
  } | null,
  requireUserResponse: null as Response | null,
  ownerResponse: null as Response | null,
  campaign: null as Campaign | null,
  isSystemEnabled: true,
  created: [] as Record<string, unknown>[],
  updated: [] as { id: string; fields: Record<string, unknown> }[],
}));

vi.mock("@/lib/auth/guard", () => ({
  requireUser: async () => store.requireUserResponse ?? store.user,
  requireOwnerRole: () => store.ownerResponse,
  requireClientAccess: () => null,
}));
vi.mock("@/lib/mock/clients", () => ({
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
  getSites: (cid: string) =>
    cid === "vitality"
      ? [
          { id: "site-cc", name: "N15 Vitality Dental" },
          { id: "site-rv", name: "N17 Dental" },
        ]
      : [],
}));
vi.mock("@/lib/outreach/repository", () => ({
  createCampaign: async (input: Record<string, unknown>) => {
    store.created.push(input);
    return {
      id: "camp-new",
      status: "draft",
      buildCursor: null,
      counts: null,
      createdAt: "2026-07-17T00:00:00Z",
      updatedAt: "2026-07-17T00:00:00Z",
      practitionerId: input.practitionerId ?? null,
      practitionerName: input.practitionerName ?? null,
      messageAngle: input.messageAngle ?? null,
      ...input,
    };
  },
  listCampaigns: async () => [],
  campaignStatusCounts: async () => ({ built: 0, contacted: 0, replied: 0, booked: 0, blocked: 0 }),
  getCampaign: async () => store.campaign,
  updateCampaign: async (id: string, fields: Record<string, unknown>) => {
    store.updated.push({ id, fields });
  },
  listTargetsByCampaign: async () => [],
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabled: async () => store.isSystemEnabled }));
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => "test-key" }));
vi.mock("@/lib/outreach/build", () => ({
  runOutreachBuildTick: async () => ({ ok: true, done: true, counts: {}, cursor: null }),
}));

import { POST, GET } from "./route";
import { PATCH } from "./[id]/route";

const post = (body: unknown) =>
  new Request("http://localhost/api/outreach/campaigns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const patch = (body: unknown) =>
  new Request("http://localhost/api/outreach/campaigns/camp-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = Promise.resolve({ id: "camp-1" });

function readyCampaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: "camp-1",
    clientId: "vitality",
    status: "ready",
    messageAngle: "a hygiene visit",
    siteId: "site-cc",
    filters: {},
    practitionerName: null,
    dailyCap: 25,
    ...over,
  };
}

beforeEach(() => {
  store.user = { id: "u1", role: "client_owner", clientId: "vitality", siteIds: ["site-cc"] };
  store.requireUserResponse = null;
  store.ownerResponse = null;
  store.campaign = null;
  store.isSystemEnabled = true;
  store.created = [];
  store.updated = [];
});

describe("POST /api/outreach/campaigns (auth + validation)", () => {
  it("returns the 401 from requireUser when not signed in", async () => {
    store.requireUserResponse = Response.json({ error: "unauthorized" }, { status: 401 });
    expect((await POST(post({ clientSlug: "vitality" }))).status).toBe(401);
  });

  it("returns the 403 from the owner-role gate for a non-owner", async () => {
    store.ownerResponse = Response.json({ error: "forbidden" }, { status: 403 });
    expect((await POST(post({ clientSlug: "vitality" }))).status).toBe(403);
  });

  it("404s an unknown client", async () => {
    expect((await POST(post({ clientSlug: "nope", name: "x", siteId: "site-cc" }))).status).toBe(404);
  });

  it("400s a missing name", async () => {
    const res = await POST(post({ clientSlug: "vitality", siteId: "site-cc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name is required/);
  });

  it("400s a site that is not one of the client's", async () => {
    const res = await POST(post({ clientSlug: "vitality", name: "x", siteId: "site-zzz" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/site/i);
  });

  it("400s a malformed filter shape", async () => {
    const res = await POST(post({ clientSlug: "vitality", name: "x", siteId: "site-cc", filters: { treatmentContains: "hygiene" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/treatmentContains/);
  });

  it("400s an out-of-range daily cap", async () => {
    const res = await POST(post({ clientSlug: "vitality", name: "x", siteId: "site-cc", dailyCap: 0 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/dailyCap/);
  });

  it("creates a DRAFT even without a message angle (list preview allowed)", async () => {
    const res = await POST(post({ clientSlug: "vitality", name: "Hygiene list", siteId: "site-cc" }));
    expect(res.status).toBe(201);
    expect(store.created).toHaveLength(1);
    expect(store.created[0].messageAngle).toBeNull();
  });

  it("creates a campaign with valid input", async () => {
    const res = await POST(
      post({
        clientSlug: "vitality",
        name: "Spring hygiene",
        siteId: "site-cc",
        messageAngle: "a hygiene visit",
        filters: { treatmentContains: ["hygiene"], gender: "female", ageMin: 25, ageMax: 35 },
        dailyCap: 30,
      }),
    );
    expect(res.status).toBe(201);
    expect(store.created[0]).toMatchObject({ name: "Spring hygiene", dailyCap: 30 });
  });
});

describe("GET /api/outreach/campaigns", () => {
  it("404s an unknown client", async () => {
    expect((await GET(new Request("http://localhost/api/outreach/campaigns?client=nope"))).status).toBe(404);
  });
  it("lists for a known client", async () => {
    const res = await GET(new Request("http://localhost/api/outreach/campaigns?client=vitality"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("PATCH /api/outreach/campaigns/[id] (launch gating)", () => {
  it("launches a ready campaign with an angle while outreach is ON", async () => {
    store.campaign = readyCampaign();
    store.isSystemEnabled = true;
    const res = await PATCH(patch({ action: "launch" }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("running");
    expect(store.updated).toContainEqual({ id: "camp-1", fields: { status: "running" } });
  });

  it("REFUSES launch while the outreach system is switched OFF, and does not set running", async () => {
    store.campaign = readyCampaign();
    store.isSystemEnabled = false;
    const res = await PATCH(patch({ action: "launch" }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("outreach_off");
    expect(body.message).toMatch(/System controls/);
    expect(store.updated).toHaveLength(0);
  });

  it("refuses launch when the campaign is not ready", async () => {
    store.campaign = readyCampaign({ status: "building" });
    const res = await PATCH(patch({ action: "launch" }), { params });
    expect(res.status).toBe(409);
    expect(store.updated).toHaveLength(0);
  });

  it("refuses launch when the campaign has no message angle", async () => {
    store.campaign = readyCampaign({ messageAngle: null });
    const res = await PATCH(patch({ action: "launch" }), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/message angle/);
    expect(store.updated).toHaveLength(0);
  });

  it("pauses a running campaign", async () => {
    store.campaign = readyCampaign({ status: "running" });
    const res = await PATCH(patch({ action: "pause" }), { params });
    expect(res.status).toBe(200);
    expect(store.updated).toContainEqual({ id: "camp-1", fields: { status: "paused" } });
  });

  it("rejects an unknown action", async () => {
    store.campaign = readyCampaign();
    expect((await PATCH(patch({ action: "explode" }), { params })).status).toBe(400);
  });
});
