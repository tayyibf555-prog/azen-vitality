import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WinningAd } from "./ingest";

// upsertWinningAds / listWinningAds against a captured, chainable mock of the
// service-role client. The guarantees pinned here: the upsert targets the
// (niche, dedup_key) conflict target (so a re-run updates in place, never
// duplicates), camel maps to snake faithfully, and the list reads best-first.

const captured = vi.hoisted(() => ({
  upserts: [] as { rows: Record<string, unknown>[]; opts: unknown }[],
  order: [] as { col: string; opts: unknown }[],
  eq: [] as { col: string; val: unknown }[],
  limit: null as number | null,
  returnData: [] as unknown[],
}));

vi.mock("@/lib/supabase/server", () => {
  function from() {
    const builder: Record<string, unknown> = {
      upsert(rows: Record<string, unknown>[], opts: unknown) {
        captured.upserts.push({ rows, opts });
        return builder;
      },
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        captured.eq.push({ col, val });
        return builder;
      },
      order(col: string, opts: unknown) {
        captured.order.push({ col, opts });
        return builder;
      },
      limit(n: number) {
        captured.limit = n;
        return Promise.resolve({ data: captured.returnData, error: null });
      },
      then(resolve: (v: { data: unknown; error: null }) => unknown) {
        // upsert(...).select("id") is awaited directly.
        return resolve({ data: captured.returnData, error: null });
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

import { upsertWinningAds, listWinningAds, winningAdToInsert, rowToWinningAd } from "./winning-repository";

function ad(overrides: Partial<WinningAd> = {}): WinningAd {
  return {
    niche: "uk-dental",
    keyword: "dental-implants",
    dedupKey: "c:col-1",
    collationId: "col-1",
    adArchiveId: "arch-1",
    collationCount: 4,
    variantCount: 4,
    pageName: "A Practice",
    pageId: "page-1",
    title: "Implants",
    bodyText: "Full jaw dental implants.",
    ctaText: "Book now",
    ctaType: "BOOK_NOW",
    linkUrl: "https://x",
    displayFormat: "IMAGE",
    publisherPlatform: ["FACEBOOK", "INSTAGRAM"],
    imageUrl: "https://cdn/i.jpg",
    currency: "GBP",
    startDate: "2026-02-20T08:00:00.000Z",
    endDate: null,
    isActive: true,
    runtimeDays: 182,
    categories: ["UNKNOWN"],
    adLibraryUrl: "https://fb/lib?id=arch-1",
    winningScore: 83,
    ...overrides,
  };
}

beforeEach(() => {
  captured.upserts = [];
  captured.order = [];
  captured.eq = [];
  captured.limit = null;
  captured.returnData = [];
});

describe("winningAdToInsert maps camel to snake", () => {
  it("carries every column across with the right names", () => {
    const row = winningAdToInsert(ad());
    expect(row.dedup_key).toBe("c:col-1");
    expect(row.body_text).toBe("Full jaw dental implants.");
    expect(row.winning_score).toBe(83);
    expect(row.variant_count).toBe(4);
    expect(row.publisher_platform).toEqual(["FACEBOOK", "INSTAGRAM"]);
    expect(row.is_active).toBe(true);
    expect(typeof row.updated_at).toBe("string");
  });
});

describe("upsertWinningAds is idempotent by (niche, dedup_key)", () => {
  it("upserts on the composite conflict target", async () => {
    captured.returnData = [{ id: "1" }, { id: "2" }];
    const n = await upsertWinningAds([ad({ dedupKey: "c:a" }), ad({ dedupKey: "c:b" })]);
    expect(n).toBe(2);
    expect(captured.upserts).toHaveLength(1);
    expect(captured.upserts[0].rows).toHaveLength(2);
    expect(captured.upserts[0].opts).toEqual({ onConflict: "niche,dedup_key" });
  });

  it("no-ops on an empty batch (no DB call, count 0)", async () => {
    const n = await upsertWinningAds([]);
    expect(n).toBe(0);
    expect(captured.upserts).toHaveLength(0);
  });
});

describe("listWinningAds reads best-first with an optional keyword filter", () => {
  it("filters by niche + keyword, orders by score then runtime, and clamps the limit", async () => {
    await listWinningAds({ niche: "uk-dental", keyword: "clear-aligners", limit: 5000 });
    expect(captured.eq).toEqual([
      { col: "niche", val: "uk-dental" },
      { col: "keyword", val: "clear-aligners" },
    ]);
    expect(captured.order[0]).toEqual({ col: "winning_score", opts: { ascending: false } });
    expect(captured.order[1]).toEqual({ col: "runtime_days", opts: { ascending: false } });
    expect(captured.limit).toBe(200); // clamped from 5000
  });

  it("defaults the niche and omits the keyword filter when not given", async () => {
    await listWinningAds();
    expect(captured.eq).toEqual([{ col: "niche", val: "uk-dental" }]);
    expect(captured.limit).toBe(60);
  });

  it("maps a stored row back to the app shape", () => {
    const mapped = rowToWinningAd({
      id: "id-1",
      niche: "uk-dental",
      keyword: "veneers",
      dedup_key: "c:z",
      collation_id: "z",
      ad_archive_id: "arch",
      collation_count: "3",
      variant_count: "3",
      page_name: "P",
      page_id: "pg",
      title: "T",
      body_text: "B",
      cta_text: "C",
      cta_type: "LEARN_MORE",
      link_url: "u",
      display_format: "VIDEO",
      publisher_platform: ["FACEBOOK"],
      image_url: "img",
      currency: "GBP",
      start_date: "2026-01-01T00:00:00.000Z",
      end_date: null,
      is_active: true,
      runtime_days: "120",
      categories: ["X"],
      ad_library_url: "lib",
      winning_score: "77",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:00.000Z",
    });
    expect(mapped.variantCount).toBe(3);
    expect(mapped.runtimeDays).toBe(120);
    expect(mapped.winningScore).toBe(77);
    expect(mapped.publisherPlatform).toEqual(["FACEBOOK"]);
    expect(mapped.id).toBe("id-1");
  });
});
