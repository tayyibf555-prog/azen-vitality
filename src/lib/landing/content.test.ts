import { describe, it, expect } from "vitest";
import { validateContent, LIMITS, COUNTS, CONTENT_VERSION, type LandingPageContent } from "./content";
import { goodContent } from "./test-fixtures";

describe("validateContent (schema v2)", () => {
  it("accepts a well-formed content object, normalises it and stamps the version", () => {
    const res = validateContent(goodContent());
    expect(res.ok).toBe(true);
    const c = res.content as LandingPageContent;
    expect(c.version).toBe(CONTENT_VERSION);
    expect(c.hero.checklist).toHaveLength(COUNTS.checklist);
    expect(c.benefits).toHaveLength(3);
    expect(c.painPoints.items.length).toBeGreaterThanOrEqual(COUNTS.minPainPoints);
    expect(c.howItWorks.steps).toHaveLength(COUNTS.steps);
    expect(c.suitability.items.length).toBeGreaterThanOrEqual(COUNTS.minSuitability);
    expect(c.faqs.length).toBeGreaterThanOrEqual(COUNTS.minFaqs);
    expect(c.pricing.lines[0].fromPriceGBP).toBe(2500);
    expect(c.cta.target).toBe("assessment");
    expect(c.cta.targetSlug).toBeNull();
    // No showcase supplied -> cleanly null, never invented.
    expect(c.showcase3d).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(validateContent(null).ok).toBe(false);
    expect(validateContent("nope").ok).toBe(false);
    expect(validateContent(42).ok).toBe(false);
  });

  it("rejects v1-shaped content (missing the new sections)", () => {
    const v1 = goodContent();
    delete v1.painPoints;
    delete v1.about;
    delete v1.howItWorks;
    delete v1.suitability;
    (v1.hero as Record<string, unknown>).eyebrow = undefined;
    const res = validateContent(v1);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/painPoints/);
    expect(res.errors.join(" ")).toMatch(/howItWorks/);
  });

  it("requires the headline accent to appear inside the headline", () => {
    const bad = goodContent();
    (bad.hero as Record<string, unknown>).headlineAccent = "totally absent phrase";
    const res = validateContent(bad);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/headlineAccent must appear verbatim/);

    // Case-insensitive match is accepted.
    const caseDiff = goodContent();
    (caseDiff.hero as Record<string, unknown>).headlineAccent = "From 3 Months";
    expect(validateContent(caseDiff).ok).toBe(true);
  });

  it("requires exactly four checklist items and exactly four steps", () => {
    const shortList = goodContent();
    ((shortList.hero as Record<string, unknown>).checklist as unknown[]).pop();
    const r1 = validateContent(shortList);
    expect(r1.ok).toBe(false);
    expect(r1.errors.join(" ")).toMatch(/hero\.checklist must contain exactly 4/);

    const fiveSteps = goodContent();
    ((fiveSteps.howItWorks as Record<string, unknown>).steps as unknown[]).push({
      title: "Extra",
      body: "One too many.",
    });
    const r2 = validateContent(fiveSteps);
    expect(r2.ok).toBe(false);
    expect(r2.errors.join(" ")).toMatch(/howItWorks\.steps must contain exactly 4/);
  });

  it("bounds pain points (4-6) and faqs (3-5)", () => {
    const threePains = goodContent();
    ((threePains.painPoints as Record<string, unknown>).items as unknown[]).pop();
    expect(validateContent(threePains).ok).toBe(false);

    const sixFaqs = goodContent();
    (sixFaqs.faqs as unknown[]).push(
      { q: "Four?", a: "Fine." },
      { q: "Five?", a: "Fine." },
      { q: "Six?", a: "One too many." },
    );
    const res = validateContent(sixFaqs);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/faqs must contain between 3 and 5/);

    const fiveFaqs = goodContent();
    (fiveFaqs.faqs as unknown[]).push({ q: "Four?", a: "Fine." }, { q: "Five?", a: "Fine." });
    expect(validateContent(fiveFaqs).ok).toBe(true);
  });

  it("requires exactly three benefits", () => {
    const two = goodContent();
    (two.benefits as unknown[]).pop();
    const r = validateContent(two);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/benefits must contain exactly 3/);
  });

  it("enforces the headline max length", () => {
    const long = goodContent();
    (long.hero as Record<string, unknown>).headline = "x".repeat(LIMITS.headline + 1);
    (long.hero as Record<string, unknown>).headlineAccent = "x".repeat(10);
    const res = validateContent(long);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/hero\.headline must be/);
  });

  it("rejects a non-positive or non-numeric price", () => {
    const bad = goodContent();
    (bad.pricing as { lines: Record<string, unknown>[] }).lines[0].fromPriceGBP = "2500";
    expect(validateContent(bad).ok).toBe(false);

    const zero = goodContent();
    (zero.pricing as { lines: Record<string, unknown>[] }).lines[0].fromPriceGBP = 0;
    expect(validateContent(zero).ok).toBe(false);
  });

  it("rejects an invalid cta target and accepts a string targetSlug", () => {
    const badTarget = goodContent();
    (badTarget.cta as Record<string, unknown>).target = "phone";
    expect(validateContent(badTarget).ok).toBe(false);

    const withSlug = goodContent();
    (withSlug.cta as Record<string, unknown>).targetSlug = "spring-invisalign";
    const res = validateContent(withSlug);
    expect(res.ok).toBe(true);
    expect(res.content?.cta.targetSlug).toBe("spring-invisalign");
  });

  it("rejects too many pricing lines", () => {
    const many = goodContent();
    (many.pricing as { lines: unknown[] }).lines = Array.from({ length: LIMITS.maxPricingLines + 1 }, () => ({
      treatment: "Invisalign",
      fromPriceGBP: 2500,
    }));
    expect(validateContent(many).ok).toBe(false);
  });

  describe("showcase3d (owner-configured, optional)", () => {
    it("is null when absent or explicitly null (section omitted)", () => {
      const absent = validateContent(goodContent());
      expect(absent.ok).toBe(true);
      expect(absent.content?.showcase3d).toBeNull();

      const explicit = goodContent();
      explicit.showcase3d = null;
      const res = validateContent(explicit);
      expect(res.ok).toBe(true);
      expect(res.content?.showcase3d).toBeNull();
    });

    it("accepts a valid local .glb + poster + caption", () => {
      const withShowcase = goodContent();
      withShowcase.showcase3d = {
        modelUrl: "/models/aligner.glb",
        posterUrl: "/models/aligner-poster.webp",
        caption: "Explore a clear aligner from every angle.",
      };
      const res = validateContent(withShowcase);
      expect(res.ok).toBe(true);
      expect(res.content?.showcase3d?.modelUrl).toBe("/models/aligner.glb");
    });

    it("rejects remote URLs and non-glb models (self-hosted assets only)", () => {
      const remote = goodContent();
      remote.showcase3d = {
        modelUrl: "https://evil.example/model.glb",
        posterUrl: "/models/poster.webp",
        caption: "Nope.",
      };
      const r1 = validateContent(remote);
      expect(r1.ok).toBe(false);
      expect(r1.errors.join(" ")).toMatch(/local path/);

      const notGlb = goodContent();
      notGlb.showcase3d = {
        modelUrl: "/models/model.obj",
        posterUrl: "/models/poster.webp",
        caption: "Nope.",
      };
      const r2 = validateContent(notGlb);
      expect(r2.ok).toBe(false);
      expect(r2.errors.join(" ")).toMatch(/\.glb/);
    });
  });
});
