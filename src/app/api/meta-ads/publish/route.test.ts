import { describe, it, expect, vi, beforeEach } from "vitest";

// The owner-gated UI publish route. Honest refusal when Meta is not connected, honest
// failure on a Graph error, success reporting PAUSED-on-Meta, and the owner-role gate.

vi.mock("@/lib/mock", () => ({
  getClient: vi.fn((slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined)),
}));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => null), // not enforced by default (pilot)
  requireClientAccess: vi.fn(() => null),
  requireOwnerRole: vi.fn(() => null),
  requireSiteAccess: vi.fn(() => null),
}));
vi.mock("@/lib/meta-ads/connection", () => ({ metaConnection: vi.fn() }));
vi.mock("@/lib/meta-ads/repository", () => ({
  getMetaCampaign: vi.fn(),
  recordPublishResult: vi.fn(async () => null),
}));
vi.mock("@/lib/meta-ads/publish", () => ({ publishCampaign: vi.fn() }));

import { POST } from "./route";
import { requireOwnerRole } from "@/lib/auth/guard";
import { metaConnection } from "@/lib/meta-ads/connection";
import { getMetaCampaign, recordPublishResult } from "@/lib/meta-ads/repository";
import { publishCampaign } from "@/lib/meta-ads/publish";

const CONNECTED = { connected: true, accessToken: "tok", adAccountId: "act_1", pageId: "page_1" };

function campaign(overrides: Record<string, unknown> = {}) {
  return { id: "camp-uuid", clientId: "vitality", siteId: "site-cc", name: "Invisalign (leads)", ...overrides };
}

function post(body: unknown) {
  return POST(
    new Request("http://test/api/meta-ads/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireOwnerRole).mockReturnValue(null);
  vi.mocked(getMetaCampaign).mockResolvedValue(campaign() as never);
});

describe("publish route - not connected", () => {
  it("refuses honestly and never calls the adapter", async () => {
    vi.mocked(metaConnection).mockReturnValue({ connected: false });
    const res = await post({ clientSlug: "vitality", campaignId: "camp-uuid" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, published: false, reason: "meta_not_connected" });
    expect(vi.mocked(publishCampaign)).not.toHaveBeenCalled();
  });
});

describe("publish route - success", () => {
  it("reports PAUSED-on-Meta and records the result", async () => {
    vi.mocked(metaConnection).mockReturnValue(CONNECTED);
    vi.mocked(publishCampaign).mockResolvedValue({
      ok: true,
      metaCampaignRef: "camp_1",
      metaAdsetRef: "adset_1",
      metaAdRef: "ad_1",
      error: null,
      note: null,
      notes: [],
      apiVersion: "v25.0",
    });
    const res = await post({ clientSlug: "vitality", campaignId: "camp-uuid" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, published: true, status: "paused_on_meta", metaCampaignRef: "camp_1" });
    expect(body.message).toMatch(/PAUSED/);
    expect(vi.mocked(recordPublishResult)).toHaveBeenCalledWith(
      "camp-uuid",
      expect.objectContaining({ ok: true, metaCampaignRef: "camp_1" }),
    );
  });
});

describe("publish route - Graph error", () => {
  it("returns the honest error and still records it (status stays ready)", async () => {
    vi.mocked(metaConnection).mockReturnValue(CONNECTED);
    vi.mocked(publishCampaign).mockResolvedValue({
      ok: false,
      metaCampaignRef: "camp_1",
      metaAdsetRef: null,
      metaAdRef: null,
      error: "Meta: Invalid parameter (code 100)",
      note: null,
      notes: [],
      apiVersion: "v25.0",
    });
    const res = await post({ clientSlug: "vitality", campaignId: "camp-uuid" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, published: false, reason: "publish_failed" });
    expect(body.error).toMatch(/Invalid parameter/);
    expect(vi.mocked(recordPublishResult)).toHaveBeenCalledWith(
      "camp-uuid",
      expect.objectContaining({ ok: false, error: "Meta: Invalid parameter (code 100)" }),
    );
  });
});

describe("publish route - guards", () => {
  it("honours the owner-role gate", async () => {
    vi.mocked(requireOwnerRole).mockReturnValue(Response.json({ ok: false, error: "forbidden" }, { status: 403 }));
    const res = await post({ clientSlug: "vitality", campaignId: "camp-uuid" });
    expect(res.status).toBe(403);
    expect(vi.mocked(getMetaCampaign)).not.toHaveBeenCalled();
  });

  it("blocks acting on another practice's campaign (IDOR)", async () => {
    vi.mocked(metaConnection).mockReturnValue(CONNECTED);
    vi.mocked(getMetaCampaign).mockResolvedValue(campaign({ clientId: "someone-else" }) as never);
    const res = await post({ clientSlug: "vitality", campaignId: "camp-uuid" });
    expect(res.status).toBe(403);
    expect(vi.mocked(publishCampaign)).not.toHaveBeenCalled();
  });

  it("400s when campaignId is missing", async () => {
    const res = await post({ clientSlug: "vitality" });
    expect(res.status).toBe(400);
  });
});
