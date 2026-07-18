import { describe, it, expect, vi, beforeEach } from "vitest";

// The hourly Meta insights sweep route. CRON_SECRET auth, an honest no-op when the Meta
// account is not connected (today's state), and a capture pass when connected.

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/meta-ads/connection", () => ({ metaConnection: vi.fn() }));
vi.mock("@/lib/meta-ads/repository", () => ({
  listPublishedMetaCampaigns: vi.fn(async () => []),
  insertMetaCampaignInsight: vi.fn(async () => {}),
}));
vi.mock("@/lib/meta-ads/metrics", () => ({ fetchCampaignInsights: vi.fn() }));

import { POST } from "./route";
import { metaConnection } from "@/lib/meta-ads/connection";
import { listPublishedMetaCampaigns, insertMetaCampaignInsight } from "@/lib/meta-ads/repository";
import { fetchCampaignInsights } from "@/lib/meta-ads/metrics";
import { acquireCronLock } from "@/lib/cron-lock";

const CONNECTED = { connected: true, accessToken: "tok", adAccountId: "act_1", pageId: "page_1" };

function req(headers: Record<string, string> = {}) {
  return new Request("http://test/api/meta-ads/insights", { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  vi.mocked(acquireCronLock).mockResolvedValue(true);
  vi.mocked(listPublishedMetaCampaigns).mockResolvedValue([]);
});

describe("insights sweep auth", () => {
  it("rejects when CRON_SECRET is set and the bearer is missing/wrong", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await POST(req());
    expect(res.status).toBe(401);
    // Never even checked the connection.
    expect(vi.mocked(metaConnection)).not.toHaveBeenCalled();
  });

  it("allows a correct bearer", async () => {
    process.env.CRON_SECRET = "s3cret";
    vi.mocked(metaConnection).mockReturnValue({ connected: false });
    const res = await POST(req({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
  });
});

describe("insights sweep not connected (dormant default)", () => {
  it("is an honest no-op: no lock, no campaign read, captured 0", async () => {
    vi.mocked(metaConnection).mockReturnValue({ connected: false });
    const res = await POST(req());
    const body = await res.json();
    expect(body).toEqual({ ok: true, connected: false, skipped: "meta_not_connected", captured: 0 });
    expect(vi.mocked(acquireCronLock)).not.toHaveBeenCalled();
    expect(vi.mocked(listPublishedMetaCampaigns)).not.toHaveBeenCalled();
  });
});

describe("insights sweep when connected", () => {
  it("captures one snapshot per published campaign", async () => {
    vi.mocked(metaConnection).mockReturnValue(CONNECTED);
    vi.mocked(listPublishedMetaCampaigns).mockResolvedValue([
      { id: "c1", metaCampaignRef: "camp_1" },
      { id: "c2", metaCampaignRef: "camp_2" },
      // A published row missing its ref is skipped defensively.
      { id: "c3", metaCampaignRef: null },
    ] as never);
    vi.mocked(fetchCampaignInsights).mockResolvedValue({
      spendGbp: 10,
      impressions: 100,
      clicks: 5,
      leads: 1,
      raw: {},
    });

    const res = await POST(req());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.captured).toBe(2);
    expect(vi.mocked(insertMetaCampaignInsight)).toHaveBeenCalledTimes(2);
  });

  it("isolates a campaign whose Graph pull fails and still reports it", async () => {
    vi.mocked(metaConnection).mockReturnValue(CONNECTED);
    vi.mocked(listPublishedMetaCampaigns).mockResolvedValue([
      { id: "c1", metaCampaignRef: "camp_1" },
      { id: "c2", metaCampaignRef: "camp_2" },
    ] as never);
    vi.mocked(fetchCampaignInsights)
      .mockResolvedValueOnce({ spendGbp: 10, impressions: 100, clicks: 5, leads: 1, raw: {} })
      .mockRejectedValueOnce(new Error("Meta: rate limited"));

    const res = await POST(req());
    const body = await res.json();
    expect(body.captured).toBe(1);
    expect(body.failed).toBe(1);
    expect(vi.mocked(insertMetaCampaignInsight)).toHaveBeenCalledTimes(1);
  });

  it("skips when another run holds the lease", async () => {
    vi.mocked(metaConnection).mockReturnValue(CONNECTED);
    vi.mocked(acquireCronLock).mockResolvedValue(false);
    const res = await POST(req());
    const body = await res.json();
    expect(body.skipped).toBe("another run in progress");
    expect(vi.mocked(listPublishedMetaCampaigns)).not.toHaveBeenCalled();
  });
});
