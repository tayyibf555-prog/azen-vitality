import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  datasetItemsUrl,
  runSyncDatasetUrl,
  fetchApifyDatasetItems,
  runApifyAdLibraryScrape,
  APIFY_PAGE_LIMIT,
} from "./apify";

describe("URL builders are pure and carry NO token", () => {
  it("dataset-items url pages by limit/offset and never embeds a secret", () => {
    const url = datasetItemsUrl("abc123", { limit: 1000, offset: 2000 });
    expect(url).toContain("/datasets/abc123/items");
    expect(url).toContain("limit=1000");
    expect(url).toContain("offset=2000");
    expect(url).toContain("clean=true");
    expect(url.toLowerCase()).not.toContain("token");
  });

  it("actor run-sync url encodes user/actor slugs to the tilde form", () => {
    expect(runSyncDatasetUrl("apify/facebook-ads-scraper")).toContain("/acts/apify~facebook-ads-scraper/run-sync-get-dataset-items");
    expect(runSyncDatasetUrl("actorId123")).toContain("/acts/actorId123/run-sync-get-dataset-items");
  });
});

describe("fetchApifyDatasetItems", () => {
  it("puts the token in the Authorization header, never the URL", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return { ok: true, json: async () => [] } as Response;
    });
    await fetchApifyDatasetItems("ds1", "secret-token", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(seen[0].url).not.toContain("secret-token");
    expect(seen[0].headers.authorization).toBe("Bearer secret-token");
  });

  it("pages until a short page, then stops", async () => {
    const full = Array.from({ length: APIFY_PAGE_LIMIT }, (_, i) => ({ ad_archive_id: `a${i}` }));
    const tail = [{ ad_archive_id: "last" }];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => full })
      .mockResolvedValueOnce({ ok: true, json: async () => tail });
    const items = await fetchApifyDatasetItems("ds1", "t", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(items).toHaveLength(APIFY_PAGE_LIMIT + 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws a short message on a non-2xx", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response);
    await expect(
      fetchApifyDatasetItems("ds1", "t", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("runApifyAdLibraryScrape", () => {
  it("POSTs the input as JSON with the bearer token and returns items", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      captured = init;
      return { ok: true, json: async () => [{ ad_archive_id: "x" }] } as Response;
    });
    const items = await runApifyAdLibraryScrape("tok", {
      actorId: "apify/facebook-ads-scraper",
      input: { count: 10 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(items).toEqual([{ ad_archive_id: "x" }]);
    expect(captured?.method).toBe("POST");
    expect((captured?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(captured?.body).toBe(JSON.stringify({ count: 10 }));
  });

  it("throws on a non-2xx actor run", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 402, json: async () => ({}) }) as Response);
    await expect(
      runApifyAdLibraryScrape("t", { actorId: "a", input: {}, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 402/);
  });
});
