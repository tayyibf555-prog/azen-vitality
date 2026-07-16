import { describe, it, expect } from "vitest";
import { validateContent, LIMITS, type LandingPageContent } from "./content";

/** A minimal, valid content object to mutate per test. */
function goodContent(): Record<string, unknown> {
  return {
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
  };
}

describe("validateContent", () => {
  it("accepts a well-formed content object and normalises it", () => {
    const res = validateContent(goodContent());
    expect(res.ok).toBe(true);
    const c = res.content as LandingPageContent;
    expect(c.benefits).toHaveLength(3);
    expect(c.faqs).toHaveLength(3);
    expect(c.pricing.lines[0].fromPriceGBP).toBe(2500);
    expect(c.cta.target).toBe("assessment");
    expect(c.cta.targetSlug).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(validateContent(null).ok).toBe(false);
    expect(validateContent("nope").ok).toBe(false);
    expect(validateContent(42).ok).toBe(false);
  });

  it("requires exactly three benefits and three faqs", () => {
    const two = goodContent();
    (two.benefits as unknown[]).pop();
    const r1 = validateContent(two);
    expect(r1.ok).toBe(false);
    expect(r1.errors.join(" ")).toMatch(/benefits must contain exactly 3/);

    const fourFaqs = goodContent();
    (fourFaqs.faqs as unknown[]).push({ q: "Extra?", a: "One too many." });
    const r2 = validateContent(fourFaqs);
    expect(r2.ok).toBe(false);
    expect(r2.errors.join(" ")).toMatch(/faqs must contain exactly 3/);
  });

  it("enforces the headline max length", () => {
    const long = goodContent();
    (long.hero as Record<string, unknown>).headline = "x".repeat(LIMITS.headline + 1);
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
});
