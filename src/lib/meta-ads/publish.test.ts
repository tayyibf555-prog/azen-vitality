import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  publishCampaign,
  mapObjective,
  mapOptimisation,
  mapCallToAction,
  dailyBudgetMinorUnits,
  buildTargeting,
  adsetName,
  landingUrlFor,
  META_API_VERSION,
} from "./publish";
import type { MetaConnection } from "./connection";
import type { MetaCampaignDraft } from "./repository";

// The publish adapter. NO live Meta calls: global fetch is mocked. Every assertion is
// about the requests we WOULD send (PAUSED on every create, real budget in pence, UK-wide
// geo fallback) and honest handling of not-connected / no-budget / Graph errors.

const CONNECTED: MetaConnection = {
  connected: true,
  accessToken: "tok_123",
  adAccountId: "act_999",
  pageId: "page_555",
};

function draft(overrides: Partial<MetaCampaignDraft> = {}): MetaCampaignDraft {
  return {
    id: "camp-uuid",
    clientId: "vitality",
    siteId: "site-cc",
    name: "Invisalign (leads)",
    treatment: "invisalign",
    objective: "leads",
    status: "ready",
    radiusMiles: null,
    dailyBudgetGbp: 20,
    audienceNotes: null,
    transparentPricing: false,
    fromPriceGbp: null,
    negativeKeywords: [],
    landingSlug: "invisalign-demo",
    copy: {
      headline: "Straighten your smile",
      primaryText: "Near invisible aligners. Book a consultation.",
      description: "Free consultation",
      cta: "Learn more",
      complianceNote: "Treatment is subject to a consultation.",
    },
    creativeImageUrl: null,
    createdBy: "owner",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    metaCampaignRef: null,
    metaAdsetRef: null,
    metaAdRef: null,
    publishedAt: null,
    publishError: null,
    ...overrides,
  };
}

interface Call {
  node: string;
  params: URLSearchParams;
}

// Build a fetch that returns a fresh id per node, recording every call.
function stubFetch(errorOnNode?: string) {
  const calls: Call[] = [];
  const idFor = (node: string) => {
    if (node.endsWith("/campaigns")) return "camp_1";
    if (node.endsWith("/adsets")) return "adset_1";
    if (node.endsWith("/adcreatives")) return "creative_1";
    if (node.endsWith("/ads")) return "ad_1";
    return "obj_1";
  };
  const fn = vi.fn(async (url: string, init: { body?: string }) => {
    const u = new URL(url);
    const node = u.pathname;
    const params = new URLSearchParams(init?.body ?? "");
    calls.push({ node, params });
    if (errorOnNode && node.endsWith(errorOnNode)) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Invalid parameter", code: 100 } }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ id: idFor(node) }) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

beforeEach(() => {
  vi.unstubAllEnvs?.();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapObjective", () => {
  it("maps our enum to Meta OUTCOME_* objectives", () => {
    expect(mapObjective("awareness")).toBe("OUTCOME_AWARENESS");
    expect(mapObjective("leads")).toBe("OUTCOME_LEADS");
    expect(mapObjective("traffic")).toBe("OUTCOME_TRAFFIC");
    expect(mapObjective("engagement")).toBe("OUTCOME_ENGAGEMENT");
    // retargeting is our structural pattern, not a native objective -> leads
    expect(mapObjective("retargeting")).toBe("OUTCOME_LEADS");
  });
});

describe("mapOptimisation", () => {
  it("gives a valid optimisation + billing for each objective", () => {
    expect(mapOptimisation("awareness")).toEqual({ optimizationGoal: "REACH", billingEvent: "IMPRESSIONS" });
    expect(mapOptimisation("engagement")).toEqual({ optimizationGoal: "POST_ENGAGEMENT", billingEvent: "IMPRESSIONS" });
    expect(mapOptimisation("leads")).toEqual({ optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS" });
    expect(mapOptimisation("retargeting")).toEqual({ optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS" });
  });
});

describe("dailyBudgetMinorUnits", () => {
  it("converts GBP to pence (minor units)", () => {
    expect(dailyBudgetMinorUnits(20)).toBe(2000);
    expect(dailyBudgetMinorUnits(12.5)).toBe(1250);
    expect(dailyBudgetMinorUnits(9.99)).toBe(999);
  });
});

describe("mapCallToAction", () => {
  it("maps obvious CTAs and falls back to LEARN_MORE", () => {
    expect(mapCallToAction("Call us today")).toBe("CALL_NOW");
    expect(mapCallToAction("Get a quote")).toBe("GET_QUOTE");
    expect(mapCallToAction("Sign up now")).toBe("SIGN_UP");
    expect(mapCallToAction("Contact us")).toBe("CONTACT_US");
    expect(mapCallToAction("Book a consultation")).toBe("LEARN_MORE");
    expect(mapCallToAction("")).toBe("LEARN_MORE");
  });
});

describe("buildTargeting", () => {
  it("always uses a UK-country fallback and notes when a radius was requested", () => {
    const withRadius = buildTargeting(5);
    expect(withRadius.targeting).toEqual({ geo_locations: { countries: ["GB"] } });
    expect(withRadius.radiusNote).toMatch(/Radius targeting/);
    expect(withRadius.radiusNote).toMatch(/no coordinates/i);

    const noRadius = buildTargeting(null);
    expect(noRadius.targeting).toEqual({ geo_locations: { countries: ["GB"] } });
    expect(noRadius.radiusNote).toBeNull();
  });
});

describe("adsetName", () => {
  it("surfaces excluded keywords in the ad set name (Meta has no negative keywords)", () => {
    expect(adsetName("Invisalign (leads)", [])).toBe("Invisalign (leads) ad set");
    expect(adsetName("Invisalign (leads)", ["cheap", "free"])).toBe(
      "Invisalign (leads) ad set [excludes: cheap, free]",
    );
  });
});

describe("landingUrlFor", () => {
  it("builds the /go/<slug>/<landing> URL on PUBLIC_BASE_URL", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://app.example.com");
    const r = landingUrlFor({ clientId: "vitality", landingSlug: "invisalign-demo" });
    expect(r.url).toBe("https://app.example.com/go/vitality/invisalign-demo");
    expect(r.hasLanding).toBe(true);
  });
  it("falls back to the base when no landing page is attached", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://app.example.com");
    const r = landingUrlFor({ clientId: "vitality", landingSlug: null });
    expect(r.url).toBe("https://app.example.com");
    expect(r.hasLanding).toBe(false);
  });
});

describe("publishCampaign - honest guards (no Meta calls)", () => {
  it("refuses when the connection is not connected, without calling Meta", async () => {
    const { fn } = stubFetch();
    const res = await publishCampaign(draft(), { connected: false });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not connected/i);
    expect(res.metaCampaignRef).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("refuses when there is no daily budget, without calling Meta", async () => {
    const { fn } = stubFetch();
    const res = await publishCampaign(draft({ dailyBudgetGbp: null }), CONNECTED);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/daily budget/i);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("publishCampaign - success path", () => {
  it("creates campaign, ad set, creative and ad, ALL in PAUSED status", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://app.example.com");
    const { calls } = stubFetch();
    const res = await publishCampaign(draft(), CONNECTED);

    expect(res.ok).toBe(true);
    expect(res.metaCampaignRef).toBe("camp_1");
    expect(res.metaAdsetRef).toBe("adset_1");
    expect(res.metaAdRef).toBe("ad_1");
    expect(res.apiVersion).toBe(META_API_VERSION);

    // Exactly the four creates, in order.
    expect(calls.map((c) => c.node.split("/").pop())).toEqual([
      "campaigns",
      "adsets",
      "adcreatives",
      "ads",
    ]);

    // HARD RULE: PAUSED on every object that carries a status (campaign, ad set, ad).
    const campaign = calls.find((c) => c.node.endsWith("/campaigns"))!;
    const adset = calls.find((c) => c.node.endsWith("/adsets"))!;
    const ad = calls.find((c) => c.node.endsWith("/ads"))!;
    expect(campaign.params.get("status")).toBe("PAUSED");
    expect(adset.params.get("status")).toBe("PAUSED");
    expect(ad.params.get("status")).toBe("PAUSED");

    // Objective + non-special category + real budget in pence + UK geo fallback.
    expect(campaign.params.get("objective")).toBe("OUTCOME_LEADS");
    expect(campaign.params.get("special_ad_categories")).toBe("[]");
    expect(adset.params.get("daily_budget")).toBe("2000");
    expect(JSON.parse(adset.params.get("targeting")!)).toEqual({ geo_locations: { countries: ["GB"] } });
  });

  it("targets the correct ad account node", async () => {
    const { calls } = stubFetch();
    await publishCampaign(draft(), CONNECTED);
    expect(calls[0].node).toBe("/v25.0/act_999/campaigns");
  });

  it("records honest notes for radius fallback and negative keywords", async () => {
    const { calls } = stubFetch();
    const res = await publishCampaign(draft({ radiusMiles: 5, negativeKeywords: ["cheap"] }), CONNECTED);
    expect(res.ok).toBe(true);
    expect(res.note).toMatch(/Radius targeting/);
    expect(res.note).toMatch(/negative-keyword/i);
    // The excluded keyword is surfaced on the ad set name.
    const adset = calls.find((c) => c.node.endsWith("/adsets"))!;
    expect(adset.params.get("name")).toMatch(/\[excludes: cheap\]/);
  });
});

describe("publishCampaign - Graph error is honest", () => {
  it("returns ok:false with the Meta error and keeps the partial campaign ref; ad set/ad null", async () => {
    const { calls } = stubFetch("/adsets"); // campaign succeeds, ad set fails
    const res = await publishCampaign(draft(), CONNECTED);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Meta: Invalid parameter/);
    // Campaign was created before the failure, so its ref is kept (not orphaned silently).
    expect(res.metaCampaignRef).toBe("camp_1");
    expect(res.metaAdsetRef).toBeNull();
    expect(res.metaAdRef).toBeNull();
    // It stopped at the ad set; no creative/ad calls were attempted.
    expect(calls.map((c) => c.node.split("/").pop())).toEqual(["campaigns", "adsets"]);
  });
});
