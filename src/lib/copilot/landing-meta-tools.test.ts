import { describe, it, expect, vi, beforeEach } from "vitest";
import { goodContent } from "@/lib/landing/test-fixtures";

// The co-pilot's marketing tools, mirroring the outreach two-step discipline:
//   - create_landing_page WRAPS the real landing generation (generateBothVariants +
//     validator + compliance lint + repository) and only ever produces a DRAFT.
//   - launch_landing_page reads back without confirm and only publishes with confirm.
//   - create_meta_campaign assembles a Meta draft (real prices, compliant copy) and is
//     always honest that it is NOT live.
//   - publish_meta_campaign refuses until the practice's Meta account is connected.
//
// generate-run + the compliance lint + the treatment catalogue are REAL (so the lint is
// genuinely exercised); the model, repositories, preview token and Meta-connection seam
// are mocked so we test the branching deterministically without the network or a DB.

const store = vi.hoisted(() => ({
  logged: [] as Record<string, unknown>[],
  inserted: [] as Record<string, unknown>[],
  metaCreated: [] as Record<string, unknown>[],
  setStatus: [] as { id: string; clientId: string; status: string }[],
  page: null as unknown, // getPageById -> LandingPageWithVariants | null
  pageBySlug: null as unknown, // getPageBySlug -> LandingPageWithVariants | null
  metaCampaign: null as unknown, // getMetaCampaign -> MetaCampaignDraft | null
  metaConnected: false,
  modelReply: "", // the FakeAnthropic reply text
  previewToken: "tok123" as string | null,
}));

vi.mock("@/lib/copilot/actions", () => ({
  logCopilotAction: (a: Record<string, unknown>) => {
    store.logged.push(a);
  },
}));
vi.mock("@/lib/mock", () => ({
  getSite: (id: string) => ({ id, name: id === "site-cc" ? "N15 Vitality Dental" : id }),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSites: (cid: string) => (cid === "vitality" ? [{ id: "site-cc" }, { id: "site-rv" }] : []),
  getClient: (idOrSlug: string) =>
    idOrSlug === "vitality" ? { id: "vitality", slug: "vitality", name: "Vitality Dental" } : undefined,
}));
vi.mock("@/lib/dentally/read", () => ({
  listPatients: vi.fn(),
  searchPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
}));

vi.mock("@/lib/landing/repository", () => ({
  // Defined inside the (hoisted) factory so no top-level variable is referenced.
  SlugTakenError: class SlugTakenError extends Error {},
  insertPageWithVariants: async (input: Record<string, unknown>) => {
    store.inserted.push(input);
    return {
      page: {
        id: "page-1",
        clientId: input.clientId,
        siteId: input.siteId,
        slug: "invisalign-abcd",
        treatment: input.treatment,
        status: "draft",
      },
      variants: [],
    };
  },
  getPageById: async () => store.page,
  getPageBySlug: async () => store.pageBySlug,
  setPageStatus: async (id: string, clientId: string, status: string) => {
    store.setStatus.push({ id, clientId, status });
  },
}));
vi.mock("@/lib/landing/preview-token", () => ({ mintPreviewToken: () => store.previewToken }));

vi.mock("@/lib/meta-ads/repository", () => ({
  createMetaCampaign: async (input: Record<string, unknown>) => {
    store.metaCreated.push(input);
    return { id: "meta-1", ...input };
  },
  getMetaCampaign: async () => store.metaCampaign,
}));
vi.mock("@/lib/meta-ads/connection", () => ({ isMetaConnected: () => store.metaConnected }));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: async () => ({ content: [{ type: "text", text: store.modelReply }] }) };
  }
  return { default: FakeAnthropic };
});

import { makeCopilotDispatch } from "./tools";

const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "tester");

const COMPLIANT_META_COPY = JSON.stringify({
  headline: "Straighten your smile with clear aligners",
  primaryText:
    "Thinking about straightening your teeth? Clear aligners fit around your life. Book a consultation to see if they suit you. Treatment is subject to a clinical assessment.",
  description: "Free consultation. Finance available.",
  cta: "Book a consultation",
  complianceNote: "Treatment is subject to a clinical assessment.",
});

beforeEach(() => {
  store.logged = [];
  store.inserted = [];
  store.metaCreated = [];
  store.setStatus = [];
  store.page = null;
  store.pageBySlug = null;
  store.metaCampaign = null;
  store.metaConnected = false;
  store.modelReply = "";
  store.previewToken = "tok123";
});

describe("create_landing_page (wraps the real generation + lint, DRAFT only)", () => {
  it("produces a DRAFT with two preview links and passes the compliance lint", async () => {
    store.modelReply = JSON.stringify(goodContent()); // valid, lint-clean (Invisalign £2,500)
    const out = JSON.parse(await dispatch("create_landing_page", { treatment: "invisalign" }));

    expect(out.created).toBe(true);
    expect(out.published).toBe(false);
    expect(out.status).toBe("draft");
    expect(out.pageId).toBe("page-1");
    expect(out.slug).toBe("invisalign-abcd");
    // Two preview links, one per A/B variant, carrying the draft preview token.
    expect(out.previewLinks.a).toBe("/go/vitality/invisalign-abcd?preview=tok123&v=a");
    expect(out.previewLinks.b).toBe("/go/vitality/invisalign-abcd?preview=tok123&v=b");
    expect(typeof out.variants.a).toBe("string");
    expect(out.variants.a.length).toBeGreaterThan(0);
    // Persisted as a draft; NEVER published.
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0].treatment).toBe("invisalign");
    expect(store.setStatus).toHaveLength(0);
    // Audited.
    expect(store.logged.some((l) => l.action === "create_landing_page" && l.status === "created")).toBe(true);
  });

  it("REJECTS an invented price via the reused lint and falls back to the real catalogue price", async () => {
    // Shape-valid but the Invisalign 'from' price is invented (£999, not the real £2,500).
    store.modelReply = JSON.stringify({
      ...goodContent(),
      pricing: { lines: [{ treatment: "Invisalign", fromPriceGBP: 999 }], caveat: "From price." },
    });
    const out = JSON.parse(await dispatch("create_landing_page", { treatment: "invisalign" }));

    expect(out.created).toBe(true);
    // The lint rejected the invented £999 on both attempts, so the stored variants use
    // the hand-written default (real catalogue price £2,500). The bad price never persists.
    const persisted = store.inserted[0] as { variantA: { pricing: { lines: { fromPriceGBP: number }[] } }; variantB: { pricing: { lines: { fromPriceGBP: number }[] } } };
    const prices = [...persisted.variantA.pricing.lines, ...persisted.variantB.pricing.lines].map((l) => l.fromPriceGBP);
    expect(prices).not.toContain(999);
    expect(prices).toContain(2500);
  });

  it("refuses an unknown treatment (never invents one)", async () => {
    const out = JSON.parse(await dispatch("create_landing_page", { treatment: "spaceship polishing" }));
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/could not match|which treatment/i);
    expect(store.inserted).toHaveLength(0);
  });

  it("returns the variant summaries even when no preview key is configured (token null)", async () => {
    store.previewToken = null;
    store.modelReply = JSON.stringify(goodContent());
    const out = JSON.parse(await dispatch("create_landing_page", { treatment: "invisalign" }));
    expect(out.created).toBe(true);
    expect(out.previewLinks).toBeNull();
    expect(out.note).toMatch(/preview key/i);
  });
});

describe("launch_landing_page (two-step, mirrors launch_outreach_campaign)", () => {
  const draftPage = () => ({
    page: { id: "page-1", clientId: "vitality", siteId: "site-cc", slug: "invisalign-abcd", treatment: "invisalign", status: "draft" },
    variants: [],
  });

  it("reads back WITHOUT publishing when confirm is absent", async () => {
    store.page = draftPage();
    const out = JSON.parse(await dispatch("launch_landing_page", { pageId: "page-1" }));
    expect(out.published).toBe(false);
    expect(out.preview).toBe(true);
    expect(out.url).toBe("/go/vitality/invisalign-abcd");
    expect(store.setStatus).toHaveLength(0);
  });

  it("publishes with confirm true", async () => {
    store.page = draftPage();
    const out = JSON.parse(await dispatch("launch_landing_page", { pageId: "page-1", confirm: true }));
    expect(out.published).toBe(true);
    expect(out.status).toBe("live");
    expect(store.setStatus).toContainEqual({ id: "page-1", clientId: "vitality", status: "live" });
    expect(store.logged.some((l) => l.action === "launch_landing_page" && l.status === "published")).toBe(true);
  });

  it("refuses to publish (confirm true) a page that is already live", async () => {
    store.page = { ...draftPage(), page: { ...draftPage().page, status: "live" } };
    const out = JSON.parse(await dispatch("launch_landing_page", { pageId: "page-1", confirm: true }));
    expect(out.published).toBe(false);
    expect(out.reason).toBe("already_live");
    expect(store.setStatus).toHaveLength(0);
  });

  it("REFUSES a page whose site is outside the co-pilot's view scope", async () => {
    store.page = { ...draftPage(), page: { ...draftPage().page, siteId: "site-rv" } };
    const out = JSON.parse(await dispatch("launch_landing_page", { pageId: "page-1", confirm: true }));
    expect(out.published).toBe(false);
    expect(out.error).toMatch(/site selector|outside/i);
    expect(store.setStatus).toHaveLength(0);
  });

  it("refuses when no page of the client matches the id (IDOR/not-found)", async () => {
    store.page = null; // getPageById is client-scoped: another practice's page reads as null
    const out = JSON.parse(await dispatch("launch_landing_page", { pageId: "page-x", confirm: true }));
    expect(out.published).toBe(false);
    expect(out.error).toMatch(/no landing page/i);
    expect(store.setStatus).toHaveLength(0);
  });
});

describe("create_meta_campaign (assembles a draft, honest not-live state)", () => {
  it("assembles a draft with the objective, budget, audience, negatives and generated copy", async () => {
    store.modelReply = COMPLIANT_META_COPY;
    const out = JSON.parse(
      await dispatch("create_meta_campaign", {
        objective: "leads",
        treatment: "invisalign",
        radiusMiles: 8,
        dailyBudgetGBP: 20,
        audienceNotes: "adults 25 to 45",
        negativeKeywords: ["cheap", "free braces"],
      }),
    );
    expect(out.created).toBe(true);
    expect(out.published).toBe(false);
    expect(out.status).toBe("ready_not_published");
    expect(out.campaignId).toBe("meta-1");
    expect(out.objective).toBe("leads");
    expect(out.radiusMiles).toBe(8);
    expect(out.dailyBudgetGBP).toBe(20);
    expect(out.audienceNotes).toBe("adults 25 to 45");
    expect(out.negativeKeywords).toEqual(["cheap", "free braces"]);
    expect(out.adCopy.headline).toBe("Straighten your smile with clear aligners");
    expect(out.metaConnected).toBe(false);
    expect(out.note).toMatch(/not live|Meta account connected/i);
    expect(store.metaCreated).toHaveLength(1);
    expect(store.logged.some((l) => l.action === "create_meta_campaign" && l.status === "created")).toBe(true);
  });

  it("pulls the REAL catalogue from-price when transparentPricing is set (never invents it)", async () => {
    store.modelReply = COMPLIANT_META_COPY;
    const out = JSON.parse(
      await dispatch("create_meta_campaign", { treatment: "implant", transparentPricing: true }),
    );
    expect(out.created).toBe(true);
    expect(out.fromPriceGBP).toBe(2400); // implant priceFrom in the catalogue
    expect(store.metaCreated[0].transparentPricing).toBe(true);
    expect(store.metaCreated[0].fromPriceGbp).toBe(2400);
  });

  it("does NOT set a from-price when transparentPricing is off", async () => {
    store.modelReply = COMPLIANT_META_COPY;
    const out = JSON.parse(await dispatch("create_meta_campaign", { treatment: "implant" }));
    expect(out.fromPriceGBP).toBeUndefined();
    expect(store.metaCreated[0].fromPriceGbp).toBeNull();
  });

  it("REJECTS non-compliant generated copy via the reused banned-word scanner and falls back to compliant template copy", async () => {
    store.modelReply = JSON.stringify({
      headline: "The best clear aligners, 5 star rated",
      primaryText: "We are the number one, award winning choice.",
      description: "x",
      cta: "Book",
      complianceNote: "n/a",
    });
    const out = JSON.parse(await dispatch("create_meta_campaign", { treatment: "invisalign" }));
    expect(out.created).toBe(true);
    // The banned copy ("best", "5 star", "rated", "award winning") never persists: the
    // fallback template copy is used instead.
    expect(out.adCopy.headline).not.toContain("5 star");
    expect(out.adCopy.headline).not.toMatch(/\bbest\b/i);
    expect(out.adCopy.primaryText).not.toMatch(/award/i);
  });

  it("attaches an in-scope landing page when its slug is given", async () => {
    store.modelReply = COMPLIANT_META_COPY;
    store.pageBySlug = { page: { id: "page-9", clientId: "vitality", siteId: "site-cc", slug: "implant-x1", status: "draft" }, variants: [] };
    const out = JSON.parse(
      await dispatch("create_meta_campaign", { treatment: "implant", attachLandingSlug: "implant-x1" }),
    );
    expect(out.landingPage).toBe("/go/vitality/implant-x1");
    expect(store.metaCreated[0].landingSlug).toBe("implant-x1");
  });
});

describe("publish_meta_campaign (honesty gate: refuses until Meta connected)", () => {
  const draftCampaign = (over: Record<string, unknown> = {}) => ({
    id: "meta-1",
    clientId: "vitality",
    siteId: "site-cc",
    name: "Invisalign (leads)",
    objective: "leads",
    treatment: "invisalign",
    dailyBudgetGbp: 20,
    status: "draft",
    ...over,
  });

  it("reads back WITHOUT publishing when confirm is absent", async () => {
    store.metaCampaign = draftCampaign();
    const out = JSON.parse(await dispatch("publish_meta_campaign", { campaignId: "meta-1" }));
    expect(out.published).toBe(false);
    expect(out.preview).toBe(true);
    expect(out.note).toMatch(/Meta account connected|nothing is published/i);
    expect(store.logged).toHaveLength(0);
  });

  it("REFUSES (confirm true) while Meta is NOT connected, and never claims it went live", async () => {
    store.metaCampaign = draftCampaign();
    store.metaConnected = false;
    const out = JSON.parse(await dispatch("publish_meta_campaign", { campaignId: "meta-1", confirm: true }));
    expect(out.published).toBe(false);
    expect(out.reason).toBe("meta_not_connected");
    expect(out.message).toMatch(/Meta Ads/i);
    expect(out.message).toMatch(/nothing has gone live/i);
    expect(store.logged.some((l) => l.status === "blocked:meta_not_connected")).toBe(true);
  });

  it("even when Meta IS connected, stays honest (no auto-publisher) and never reports live", async () => {
    store.metaCampaign = draftCampaign();
    store.metaConnected = true;
    const out = JSON.parse(await dispatch("publish_meta_campaign", { campaignId: "meta-1", confirm: true }));
    expect(out.published).toBe(false);
    expect(out.reason).toBe("publisher_not_built");
    expect(out.message).toMatch(/nothing has gone live/i);
  });

  it("will not act on another practice's campaign (cross-client IDOR guard)", async () => {
    store.metaCampaign = draftCampaign({ clientId: "someone-else" });
    store.metaConnected = true;
    const out = JSON.parse(await dispatch("publish_meta_campaign", { campaignId: "meta-1", confirm: true }));
    expect(out.published).toBe(false);
    expect(out.error).toMatch(/another practice/i);
    expect(store.logged).toHaveLength(0);
  });

  it("REFUSES a campaign whose site is outside the co-pilot's view scope", async () => {
    store.metaCampaign = draftCampaign({ siteId: "site-rv" });
    store.metaConnected = true;
    const out = JSON.parse(await dispatch("publish_meta_campaign", { campaignId: "meta-1", confirm: true }));
    expect(out.published).toBe(false);
    expect(out.error).toMatch(/site selector|outside/i);
  });
});
