import { describe, it, expect } from "vitest";
import { lintContent, scanBannedText, type PriceResolver } from "./compliance";
import { validateContent, type LandingPageContent } from "./content";
import { getDefaultContent, DEFAULT_TREATMENT_KEYS } from "./defaults";

// Resolver that only knows Invisalign at £2,500 (mirrors the real catalogue value)
// so tests do not depend on the whole catalogue.
const stubResolver: PriceResolver = (t) => (/invisalign/i.test(t) ? 2500 : null);

function goodContent(): LandingPageContent {
  const res = validateContent({
    hero: { headline: "Straighten your smile", subhead: "Clear aligners with a free consultation." },
    benefits: [
      { title: "Barely there", detail: "Most people will not notice you are wearing them." },
      { title: "Removable", detail: "Take them out to eat, brush and floss." },
      { title: "Spread the cost", detail: "0 percent finance is available." },
    ],
    pricing: { lines: [{ treatment: "Invisalign", fromPriceGBP: 2500 }], caveat: "From price, confirmed after a clinical assessment." },
    faqs: [
      { q: "How long?", a: "It varies from person to person." },
      { q: "Suitable for me?", a: "Depends on a clinical assessment." },
      { q: "Finance?", a: "Yes, 0 percent finance is available." },
    ],
    cta: { label: "Check your options", target: "assessment", targetSlug: null },
  });
  if (!res.content) throw new Error("fixture is not valid");
  return res.content;
}

describe("lintContent", () => {
  it("passes clean, correctly-priced content", () => {
    expect(lintContent(goodContent(), { resolvePrice: stubResolver }).ok).toBe(true);
  });

  it("fails on a price MISMATCH (advertised price differs from the real price)", () => {
    const c = goodContent();
    c.pricing.lines[0].fromPriceGBP = 1999; // real price is 2500
    const res = lintContent(c, { resolvePrice: stubResolver });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.category === "price")).toBe(true);
  });

  it("fails on an unknown treatment (no real price to verify against)", () => {
    const c = goodContent();
    c.pricing.lines[0].treatment = "Teeth teleportation";
    const res = lintContent(c, { resolvePrice: stubResolver });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.category === "price")).toBe(true);
  });

  it("fails on TESTIMONIAL / review language", () => {
    const c = goodContent();
    c.hero.subhead = "See our 5 star reviews from happy patients.";
    const res = lintContent(c, { resolvePrice: stubResolver });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.category === "testimonial")).toBe(true);
  });

  it("fails on guarantees, pain-free claims, superlatives and funding words", () => {
    const guarantee = goodContent();
    guarantee.benefits[0].detail = "Results guaranteed or your money back.";
    expect(lintContent(guarantee, { resolvePrice: stubResolver }).failures.some((f) => f.category === "guarantee")).toBe(true);

    const pain = goodContent();
    pain.benefits[0].detail = "A completely pain-free treatment.";
    expect(lintContent(pain, { resolvePrice: stubResolver }).failures.some((f) => f.category === "pain")).toBe(true);

    const superlative = goodContent();
    superlative.hero.headline = "The best dentist in town";
    expect(lintContent(superlative, { resolvePrice: stubResolver }).failures.some((f) => f.category === "superlative")).toBe(true);

    const funding = goodContent();
    funding.faqs[0].a = "This is available on the NHS too.";
    expect(lintContent(funding, { resolvePrice: stubResolver }).failures.some((f) => f.category === "funding")).toBe(true);
  });

  it("fails on banned symbols (em-dash, dollar sign)", () => {
    const dash = goodContent();
    dash.hero.subhead = "Clear aligners — with finance.";
    expect(lintContent(dash, { resolvePrice: stubResolver }).failures.some((f) => f.category === "symbol")).toBe(true);

    const dollar = goodContent();
    dollar.pricing.caveat = "Prices from $2,500.";
    expect(lintContent(dollar, { resolvePrice: stubResolver }).failures.some((f) => f.category === "symbol")).toBe(true);
  });

  it("every hand-written default is valid AND lint-clean against the real catalogue", () => {
    expect(DEFAULT_TREATMENT_KEYS.length).toBeGreaterThanOrEqual(6);
    for (const key of DEFAULT_TREATMENT_KEYS) {
      const content = getDefaultContent(key, "assessment");
      expect(content, `default for ${key}`).not.toBeNull();
      // Shape.
      expect(validateContent(content).ok, `shape ${key}`).toBe(true);
      // Compliance + real price cross-check (catalogue resolver, no stub).
      const res = lintContent(content as LandingPageContent);
      expect(res.ok, `lint ${key}: ${JSON.stringify(res.failures)}`).toBe(true);
    }
  });
});

describe("scanBannedText (reusable free-text scanner)", () => {
  it("flags each banned category in arbitrary text", () => {
    expect(scanBannedText("what our patients say").some((h) => h.category === "testimonial")).toBe(true);
    expect(scanBannedText("we guarantee results").some((h) => h.category === "guarantee")).toBe(true);
    expect(scanBannedText("a pain-free visit").some((h) => h.category === "pain")).toBe(true);
    expect(scanBannedText("the best in town").some((h) => h.category === "superlative")).toBe(true);
  });

  it("returns nothing for clean copy and at most one hit per category", () => {
    expect(scanBannedText("Clear aligners, subject to a clinical assessment.")).toEqual([]);
    const many = scanBannedText("best best finest leading");
    expect(many.filter((h) => h.category === "superlative").length).toBe(1);
  });
});
