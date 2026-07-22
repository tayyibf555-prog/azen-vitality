import { describe, it, expect } from "vitest";
import {
  deriveLandingOverview,
  summariseLandingOverview,
  groupRowsByTreatment,
  type LandingOverviewInput,
} from "./overview";
import { decideAutoPromotion, MIN_VIEWS } from "./winner";
import type { LandingPage } from "./types";
import type { FunnelVariantCounters } from "@/lib/funnel/events";

// Unit tests for the Growth > Landing pages aggregator. Pure, no DB/crypto: every
// input (page record, per-variant counters, draft preview token) is handed in, so
// these fully pin the stats shaping, the winner marker (which must come straight from
// the shared decideAutoPromotion, never re-derived here), the preview links and the
// ranking.

function makePage(over: Partial<LandingPage> = {}): LandingPage {
  return {
    id: "p1",
    clientId: "vitality",
    siteId: "site-cc",
    slug: "invisalign-abc",
    treatment: "invisalign",
    campaignRef: null,
    status: "live",
    winnerVariant: null,
    autoPromote: true,
    createdBy: null,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...over,
  };
}

const treatmentName = (k: string) => (k === "invisalign" ? "Invisalign" : k);

function derive(items: LandingOverviewInput[]) {
  return deriveLandingOverview({ clientSlug: "vitality", items, treatmentName });
}

const counters = (views: number, ctaClicks: number, leads: number): FunnelVariantCounters => ({
  views,
  ctaClicks,
  leads,
});

describe("deriveLandingOverview — per-variant stats", () => {
  it("returns each variant's counters and derived rates, plus page totals", () => {
    const [row] = derive([
      { page: makePage(), summary: { a: counters(100, 20, 5), b: counters(200, 10, 0) }, previewToken: null },
    ]);
    expect(row.treatmentName).toBe("Invisalign");
    expect(row.totalViews).toBe(300);
    expect(row.totalCtaClicks).toBe(30);
    expect(row.totalLeads).toBe(5);
    // Variant A: 20/100 clicks, 5/100 leads.
    expect(row.variants.a.ctaRate).toBeCloseTo(0.2, 6);
    expect(row.variants.a.leadRate).toBeCloseTo(0.05, 6);
    // Variant B: 10/200 clicks, 0 leads.
    expect(row.variants.b.ctaRate).toBeCloseTo(0.05, 6);
    expect(row.variants.b.leadRate).toBe(0);
    expect(row.hasData).toBe(true);
  });

  it("never divides by zero: a page with no views has zero rates and hasData false", () => {
    const [row] = derive([
      { page: makePage(), summary: { a: counters(0, 0, 0), b: counters(0, 0, 0) }, previewToken: null },
    ]);
    expect(row.variants.a.ctaRate).toBe(0);
    expect(row.variants.a.leadRate).toBe(0);
    expect(row.totalViews).toBe(0);
    expect(row.hasData).toBe(false);
  });
});

describe("deriveLandingOverview — winner marker uses the shared criteria", () => {
  it("marks the winning variant exactly as decideAutoPromotion decides (fair sample + clear lead)", () => {
    const a = counters(1000, 200, 100); // 10% lead rate
    const b = counters(1000, 150, 70); //  7% lead rate -> ~43% relative lift
    const [row] = derive([{ page: makePage({ status: "live" }), summary: { a, b }, previewToken: null }]);

    // The decision is the SHARED one, not a local re-derivation.
    expect(row.decision).toEqual(decideAutoPromotion({ a, b }));
    expect(row.decision.promote).toBe(true);
    expect(row.decision.winner).toBe("a");
    expect(row.variants.a.winning).toBe(true);
    expect(row.variants.b.winning).toBe(false);
    expect(row.performingWell).toBe(true);
  });

  it("does NOT mark a winner below the shared MIN_VIEWS threshold (threshold not re-derived)", () => {
    const a = counters(MIN_VIEWS - 1, 40, 20); // strong rate but too small a sample
    const b = counters(500, 10, 2);
    const [row] = derive([{ page: makePage({ status: "live" }), summary: { a, b }, previewToken: null }]);
    expect(row.decision.promote).toBe(false);
    expect(row.variants.a.winning).toBe(false);
    expect(row.variants.b.winning).toBe(false);
    expect(row.performingWell).toBe(false);
  });

  it("a promoted page marks that variant as the served winner regardless of live counters", () => {
    const [row] = derive([
      {
        page: makePage({ status: "live", winnerVariant: "b" }),
        summary: { a: counters(10, 1, 0), b: counters(8, 1, 0) }, // tiny sample, undecidable live
        previewToken: null,
      },
    ]);
    expect(row.variants.b.promoted).toBe(true);
    expect(row.variants.b.winning).toBe(true);
    expect(row.variants.a.winning).toBe(false);
    expect(row.performingWell).toBe(true);
  });
});

describe("deriveLandingOverview — preview links", () => {
  it("live page: preview is the plain public path (no token)", () => {
    const [row] = derive([
      { page: makePage({ status: "live", slug: "inv-live" }), summary: { a: counters(0, 0, 0), b: counters(0, 0, 0) }, previewToken: null },
    ]);
    expect(row.path).toBe("/go/vitality/inv-live");
    expect(row.previewPath).toBe("/go/vitality/inv-live");
  });

  it("draft page: preview link carries the preview token", () => {
    const [row] = derive([
      { page: makePage({ status: "draft", slug: "inv-draft" }), summary: { a: counters(0, 0, 0), b: counters(0, 0, 0) }, previewToken: "tok123" },
    ]);
    expect(row.previewPath).toBe("/go/vitality/inv-draft?preview=tok123");
  });

  it("draft with no token (no server key) has no preview link", () => {
    const [row] = derive([
      { page: makePage({ status: "draft", slug: "inv-draft" }), summary: { a: counters(0, 0, 0), b: counters(0, 0, 0) }, previewToken: null },
    ]);
    expect(row.previewPath).toBeNull();
  });

  it("archived page has no preview link", () => {
    const [row] = derive([
      { page: makePage({ status: "archived", slug: "inv-old" }), summary: { a: counters(0, 0, 0), b: counters(0, 0, 0) }, previewToken: null },
    ]);
    expect(row.previewPath).toBeNull();
  });
});

describe("deriveLandingOverview — ranking", () => {
  it("orders performing-well live pages first, then live by views, then drafts, then archived", () => {
    const items: LandingOverviewInput[] = [
      // archived (should sink to the bottom)
      { page: makePage({ id: "arch", slug: "arch", status: "archived" }), summary: { a: counters(9999, 999, 0), b: counters(9999, 0, 0) }, previewToken: null },
      // live, big traffic but a too-close race -> not performing well
      { page: makePage({ id: "big", slug: "big", status: "live" }), summary: { a: counters(5000, 500, 0), b: counters(5000, 490, 0) }, previewToken: null },
      // draft
      { page: makePage({ id: "draft", slug: "draft", status: "draft" }), summary: { a: counters(0, 0, 0), b: counters(0, 0, 0) }, previewToken: "t" },
      // live, small sample -> not performing well
      { page: makePage({ id: "small", slug: "small", status: "live" }), summary: { a: counters(50, 10, 0), b: counters(50, 2, 0) }, previewToken: null },
      // live, performing well (clear winner on a fair sample)
      { page: makePage({ id: "well", slug: "well", status: "live" }), summary: { a: counters(1000, 200, 100), b: counters(1000, 150, 70) }, previewToken: null },
    ];
    const order = derive(items).map((r) => r.page.id);
    expect(order).toEqual(["well", "big", "small", "draft", "arch"]);
    // sanity: the performing-well flag is what floated "well" above the higher-traffic "big"
    const well = derive(items).find((r) => r.page.id === "well");
    expect(well?.performingWell).toBe(true);
  });
});

describe("summariseLandingOverview", () => {
  it("counts pages, live, drafts and total views", () => {
    const rows = derive([
      { page: makePage({ id: "1", slug: "a", status: "live" }), summary: { a: counters(100, 0, 0), b: counters(50, 0, 0) }, previewToken: null },
      { page: makePage({ id: "2", slug: "b", status: "draft" }), summary: { a: counters(0, 0, 0), b: counters(0, 0, 0) }, previewToken: "t" },
      { page: makePage({ id: "3", slug: "c", status: "archived" }), summary: { a: counters(10, 0, 0), b: counters(0, 0, 0) }, previewToken: null },
    ]);
    expect(summariseLandingOverview(rows)).toEqual({ pages: 3, live: 1, drafts: 1, totalViews: 160 });
  });

  it("handles an empty section", () => {
    expect(derive([])).toEqual([]);
    expect(summariseLandingOverview([])).toEqual({ pages: 0, live: 0, drafts: 0, totalViews: 0 });
  });
});

describe("groupRowsByTreatment", () => {
  it("groups rows by treatment, preserving the ranked order and each group's count", () => {
    const rows = derive([
      { page: makePage({ id: "i1", slug: "invisalign-1", treatment: "invisalign", status: "live" }), summary: { a: counters(50, 5, 1), b: counters(40, 4, 0) }, previewToken: null },
      { page: makePage({ id: "b1", slug: "bonding-1", treatment: "bonding", status: "draft" }), summary: { a: counters(0, 0, 0), b: counters(0, 0, 0) }, previewToken: "tok" },
      { page: makePage({ id: "i2", slug: "invisalign-2", treatment: "invisalign", status: "draft" }), summary: { a: counters(0, 0, 0), b: counters(0, 0, 0) }, previewToken: "tok2" },
    ]);
    const groups = groupRowsByTreatment(rows);
    // The live invisalign page ranks first, so invisalign leads; bonding follows.
    expect(groups.map((g) => g.key)).toEqual(["invisalign", "bonding"]);
    expect(groups.map((g) => g.name)).toEqual(["Invisalign", "bonding"]);
    expect(groups.map((g) => g.rows.length)).toEqual([2, 1]);
  });

  it("returns one group for a single treatment, and nothing for no rows", () => {
    expect(groupRowsByTreatment([])).toEqual([]);
    const rows = derive([
      { page: makePage(), summary: { a: counters(10, 1, 0), b: counters(10, 1, 0) }, previewToken: null },
    ]);
    const groups = groupRowsByTreatment(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("invisalign");
    expect(groups[0].rows).toHaveLength(1);
  });
});
