import { describe, it, expect } from "vitest";
import { lintContent, type PriceResolver } from "./compliance";
import { validateContent, type LandingPageContent } from "./content";
import { getDefaultContent, DEFAULT_TREATMENT_KEYS } from "./defaults";
import { goodContent } from "./test-fixtures";

// Resolver that only knows Invisalign at £2,500 (mirrors the real catalogue value)
// so tests do not depend on the whole catalogue.
const stubResolver: PriceResolver = (t) => (/invisalign/i.test(t) ? 2500 : null);

/** A validated, lint-clean v2 fixture (from the shared content.test builder). */
function cleanContent(): LandingPageContent {
  const res = validateContent(goodContent());
  if (!res.content) throw new Error("fixture is not valid");
  return res.content;
}

describe("lintContent (schema v2)", () => {
  it("passes clean, correctly-priced content", () => {
    expect(lintContent(cleanContent(), { resolvePrice: stubResolver }).ok).toBe(true);
  });

  it("fails on a price MISMATCH (advertised price differs from the real price)", () => {
    const c = cleanContent();
    c.pricing.lines[0].fromPriceGBP = 1999; // real price is 2500
    const res = lintContent(c, { resolvePrice: stubResolver });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.category === "price")).toBe(true);
  });

  it("fails on an unknown treatment (no real price to verify against)", () => {
    const c = cleanContent();
    c.pricing.lines[0].treatment = "Teeth teleportation";
    const res = lintContent(c, { resolvePrice: stubResolver });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.category === "price")).toBe(true);
  });

  it("fails on TESTIMONIAL / review language", () => {
    const c = cleanContent();
    c.hero.subhead = "See our 5 star reviews from happy patients.";
    const res = lintContent(c, { resolvePrice: stubResolver });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.category === "testimonial")).toBe(true);
  });

  it("fails on guarantees, pain-free claims, superlatives and funding words", () => {
    const guarantee = cleanContent();
    guarantee.benefits[0].detail = "Results guaranteed or your money back.";
    expect(lintContent(guarantee, { resolvePrice: stubResolver }).failures.some((f) => f.category === "guarantee")).toBe(true);

    const pain = cleanContent();
    pain.benefits[0].detail = "A completely pain-free treatment.";
    expect(lintContent(pain, { resolvePrice: stubResolver }).failures.some((f) => f.category === "pain")).toBe(true);

    const superlative = cleanContent();
    superlative.hero.headline = "The best dentist in town, from 3 months";
    expect(lintContent(superlative, { resolvePrice: stubResolver }).failures.some((f) => f.category === "superlative")).toBe(true);

    const funding = cleanContent();
    funding.faqs[0].a = "This is available on the NHS too.";
    expect(lintContent(funding, { resolvePrice: stubResolver }).failures.some((f) => f.category === "funding")).toBe(true);
  });

  it("fails on banned symbols (em-dash, dollar sign)", () => {
    const dash = cleanContent();
    dash.hero.subhead = "Clear aligners — with finance.";
    expect(lintContent(dash, { resolvePrice: stubResolver }).failures.some((f) => f.category === "symbol")).toBe(true);

    const dollar = cleanContent();
    dollar.pricing.caveat = "Prices from $2,500.";
    expect(lintContent(dollar, { resolvePrice: stubResolver }).failures.some((f) => f.category === "symbol")).toBe(true);
  });

  describe("PROOF claims (owner-verified facts must never appear in generated copy)", () => {
    it("rejects 'award' wording anywhere, including the eyebrow", () => {
      const eyebrow = cleanContent();
      eyebrow.hero.eyebrow = "Award winning clear aligners";
      const res = lintContent(eyebrow, { resolvePrice: stubResolver });
      expect(res.ok).toBe(false);
      expect(res.failures.some((f) => f.category === "proof" && f.where === "hero.eyebrow")).toBe(true);

      const body = cleanContent();
      body.about.body = "Our awarded team looks after every case personally.";
      expect(lintContent(body, { resolvePrice: stubResolver }).failures.some((f) => f.category === "proof")).toBe(true);
    });

    it("rejects 'as seen in' / 'featured in' press claims", () => {
      const seen = cleanContent();
      seen.painPoints.reassurance = "As seen in national papers, you are in good hands.";
      expect(lintContent(seen, { resolvePrice: stubResolver }).failures.some((f) => f.category === "proof")).toBe(true);

      const featured = cleanContent();
      featured.faqs[0].a = "We were featured in a magazine recently.";
      expect(lintContent(featured, { resolvePrice: stubResolver }).failures.some((f) => f.category === "proof")).toBe(true);
    });

    it("rejects numeric star-rating shapes (4.9/5, 4.8 out of 5) and patient-count boasts", () => {
      const slash = cleanContent();
      slash.hero.subhead = "Come and see why we score 4.9/5 with local families.";
      expect(lintContent(slash, { resolvePrice: stubResolver }).failures.some((f) => f.category === "proof")).toBe(true);

      const outOf = cleanContent();
      outOf.benefits[1].detail = "We hold 4.8 out of 5 across our clinics.";
      expect(lintContent(outOf, { resolvePrice: stubResolver }).failures.some((f) => f.category === "proof")).toBe(true);

      const count = cleanContent();
      count.about.body = "Over 10,000 happy patients have chosen us.";
      expect(lintContent(count, { resolvePrice: stubResolver }).failures.some((f) => f.category === "proof")).toBe(true);
    });
  });

  it("scans the NEW v2 sections (pain points, key facts, steps, suitability, checklist)", () => {
    const painCard = cleanContent();
    painCard.painPoints.items[0].body = "Everyone else guarantees results but cannot.";
    expect(lintContent(painCard, { resolvePrice: stubResolver }).failures.some((f) => f.where.startsWith("painPoints.items[0]"))).toBe(true);

    const keyFact = cleanContent();
    keyFact.about.keyFacts[0] = "Rated top by everyone";
    expect(lintContent(keyFact, { resolvePrice: stubResolver }).failures.some((f) => f.where.startsWith("about.keyFacts[0]"))).toBe(true);

    const step = cleanContent();
    step.howItWorks.steps[2].body = "A totally painless visit.";
    expect(lintContent(step, { resolvePrice: stubResolver }).failures.some((f) => f.where.startsWith("howItWorks.steps[2]"))).toBe(true);

    const suit = cleanContent();
    suit.suitability.items[1].body = "Ideal if you want the cheapest option going.";
    expect(lintContent(suit, { resolvePrice: stubResolver }).failures.some((f) => f.where.startsWith("suitability.items[1]"))).toBe(true);

    const check = cleanContent();
    check.hero.checklist[0] = "World-class results";
    expect(lintContent(check, { resolvePrice: stubResolver }).failures.some((f) => f.where.startsWith("hero.checklist[0]"))).toBe(true);
  });

  it("scans the showcase caption when a showcase is configured", () => {
    const c = cleanContent();
    c.showcase3d = {
      modelUrl: "/models/aligner.glb",
      posterUrl: "/models/aligner.webp",
      caption: "Our award winning aligner up close.",
    };
    const res = lintContent(c, { resolvePrice: stubResolver });
    expect(res.ok).toBe(false);
    expect(res.failures.some((f) => f.where === "showcase3d.caption" && f.category === "proof")).toBe(true);
  });

  it("every hand-written default is valid AND lint-clean against the real catalogue", () => {
    expect(DEFAULT_TREATMENT_KEYS.length).toBeGreaterThanOrEqual(6);
    for (const key of DEFAULT_TREATMENT_KEYS) {
      const content = getDefaultContent(key, "assessment");
      expect(content, `default for ${key}`).not.toBeNull();
      // Shape.
      const shape = validateContent(content);
      expect(shape.ok, `shape ${key}: ${shape.errors.join("; ")}`).toBe(true);
      // Compliance + real price cross-check (catalogue resolver, no stub).
      const res = lintContent(content as LandingPageContent);
      expect(res.ok, `lint ${key}: ${JSON.stringify(res.failures)}`).toBe(true);
    }
  });
});
