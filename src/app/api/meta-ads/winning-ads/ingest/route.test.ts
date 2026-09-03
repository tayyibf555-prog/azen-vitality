import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

// The winning-ads ingest route. Owner-or-cron auth, an honest no-op when APIFY_TOKEN
// is not set, and a rank+upsert pass over whatever the Apify source returns. Ingest
// stays REAL (it is pure) so the happy path exercises the actual ranking; only the
// network + DB + auth edges are mocked.

vi.mock("@/lib/mock", () => ({ getClient: vi.fn(() => ({ id: "vitality", slug: "vitality", name: "Vitality" })) }));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => null),
  requireClientAccess: vi.fn(() => null),
  requireModuleApiAccess: vi.fn(() => null),
  requireOwnerRole: vi.fn(() => null),
}));
vi.mock("@/lib/meta-ads/apify", () => ({
  fetchApifyDatasetItems: vi.fn(),
  runApifyAdLibraryScrape: vi.fn(),
}));
vi.mock("@/lib/meta-ads/winning-repository", () => ({ upsertWinningAds: vi.fn(async () => 0) }));

import { POST } from "./route";
import { requireUser, requireOwnerRole } from "@/lib/auth/guard";
import { fetchApifyDatasetItems, runApifyAdLibraryScrape } from "@/lib/meta-ads/apify";
import { upsertWinningAds } from "@/lib/meta-ads/winning-repository";

function req(body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Request("http://test/api/meta-ads/winning-ads/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const rawAd = (id: string, text: string, start: string) => ({
  ad_archive_id: id,
  collation_id: `col-${id}`,
  page_id: "p1",
  page_name: "A Practice",
  is_active: true,
  start_date_formatted: start,
  end_date_formatted: "2026-08-21 00:00:00",
  snapshot: { cta_type: "LEARN_MORE", display_format: "IMAGE", body: { text } },
});

// ---------------------------------------------------------------------------
// THE PROCESS CLOCK IS PINNED, AND THAT IS THE POINT OF THIS BLOCK.
//
// This file was a TIME BOMB: it passed on today's calendar and went red on a
// shifted one, and the failure read as a logic regression rather than as a stale
// fixture. Found by running the whole suite under a shifted process clock
// (+3h/+1d/+3d/+4d/+30d/+90d/+181d/+2y/+10y) and diffing against a real-clock
// baseline — the only method that finds these, because grepping for hard-coded
// dates matches a third of the suite and misses the ones that matter.
//
// Only `Date` is faked. Faking all timers hangs the async route and agent paths
// these tests drive; this is the pattern from src/lib/agent/booking-duration.test.ts.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-20T09:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APIFY_TOKEN;
  delete process.env.CRON_SECRET;
  delete process.env.WINNING_ADS_DATASET_ID;
  delete process.env.WINNING_ADS_APIFY_ACTOR;
  vi.mocked(requireUser).mockResolvedValue(null);
  vi.mocked(requireOwnerRole).mockReturnValue(null);
  vi.mocked(upsertWinningAds).mockResolvedValue(0);
});

describe("graceful when APIFY_TOKEN is not set", () => {
  it("is a 200 no-op that never touches Apify or the library", async () => {
    // No CRON_SECRET in a non-production test env => cron-authorized, session skipped.
    const res = await POST(req({ datasetId: "ds1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "apify_token_not_set", upserted: 0 });
    expect(vi.mocked(fetchApifyDatasetItems)).not.toHaveBeenCalled();
    expect(vi.mocked(upsertWinningAds)).not.toHaveBeenCalled();
  });
});

describe("dataset re-ingest path", () => {
  it("fetches the dataset, ranks it, and upserts the top slice", async () => {
    process.env.APIFY_TOKEN = "tok";
    vi.mocked(fetchApifyDatasetItems).mockResolvedValue([
      rawAd("implant", "Full jaw dental implants, fixed price, book your consultation.", "2026-02-20 00:00:00"),
      rawAd("fresh", "Teeth whitening this week, book your whitening appointment now please.", "2026-08-19 00:00:00"),
    ] as never);
    vi.mocked(upsertWinningAds).mockResolvedValue(2);

    const res = await POST(req({ datasetId: "ds1", topN: 10 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.source).toBe("dataset");
    expect(body.fetched).toBe(2);
    expect(body.deduped).toBe(2);
    expect(body.upserted).toBe(2);
    expect(vi.mocked(fetchApifyDatasetItems)).toHaveBeenCalledWith("ds1", "tok");
    // The upserted batch is the ranked ingest output (implant first).
    const batch = vi.mocked(upsertWinningAds).mock.calls[0][0];
    expect(batch[0].adArchiveId).toBe("implant");
    expect(batch[0].winningScore).toBeGreaterThan(batch[1].winningScore);
  });

  it("returns 502 when the Apify fetch throws, without writing the library", async () => {
    process.env.APIFY_TOKEN = "tok";
    vi.mocked(fetchApifyDatasetItems).mockRejectedValue(new Error("boom"));
    const res = await POST(req({ datasetId: "ds1" }));
    expect(res.status).toBe(502);
    expect(vi.mocked(upsertWinningAds)).not.toHaveBeenCalled();
  });
});

describe("scrape path (no datasetId)", () => {
  it("runs the actor when only an actor is configured", async () => {
    process.env.APIFY_TOKEN = "tok";
    process.env.WINNING_ADS_APIFY_ACTOR = "apify/facebook-ads-scraper";
    vi.mocked(runApifyAdLibraryScrape).mockResolvedValue([
      rawAd("a1", "Straighten your teeth with clear aligners, free consultation available.", "2026-05-01 00:00:00"),
    ] as never);
    vi.mocked(upsertWinningAds).mockResolvedValue(1);
    const res = await POST(req({}));
    const body = await res.json();
    expect(body.source).toBe("scrape");
    expect(body.upserted).toBe(1);
    expect(vi.mocked(runApifyAdLibraryScrape)).toHaveBeenCalled();
  });

  it("400s when neither a datasetId nor an actor is configured", async () => {
    process.env.APIFY_TOKEN = "tok";
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(vi.mocked(upsertWinningAds)).not.toHaveBeenCalled();
  });
});

describe("auth: owner or cron only", () => {
  it("delegates to the session guards when the cron bearer is wrong", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.APIFY_TOKEN = "tok";
    vi.mocked(requireUser).mockResolvedValue(
      Response.json({ error: "unauthorized" }, { status: 401 }) as never,
    );
    const res = await POST(req({ datasetId: "ds1" }, { authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(vi.mocked(requireUser)).toHaveBeenCalled();
    expect(vi.mocked(fetchApifyDatasetItems)).not.toHaveBeenCalled();
  });

  it("refuses a signed-in non-owner with the owner guard's 403", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.APIFY_TOKEN = "tok";
    vi.mocked(requireUser).mockResolvedValue({ id: "u1", role: "client_coordinator" } as never);
    vi.mocked(requireOwnerRole).mockReturnValue(Response.json({ ok: false, error: "forbidden" }, { status: 403 }));
    const res = await POST(req({ datasetId: "ds1" }, { authorization: "Bearer wrong" }));
    expect(res.status).toBe(403);
    expect(vi.mocked(fetchApifyDatasetItems)).not.toHaveBeenCalled();
  });

  it("lets a correct cron bearer through with no session", async () => {
    process.env.CRON_SECRET = "s3cret";
    process.env.APIFY_TOKEN = "tok";
    vi.mocked(fetchApifyDatasetItems).mockResolvedValue([] as never);
    vi.mocked(upsertWinningAds).mockResolvedValue(0);
    const res = await POST(req({ datasetId: "ds1" }, { authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(requireUser)).not.toHaveBeenCalled();
  });
});
