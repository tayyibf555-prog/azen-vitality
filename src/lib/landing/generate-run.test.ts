import { describe, it, expect, vi } from "vitest";
import { generateVariant, generateBothVariants, type CallModel } from "./generate-run";
import { validateContent } from "./content";
import { lintContent } from "./compliance";
import { getDefaultContent } from "./defaults";
import { TREATMENTS, type Treatment } from "@/lib/treatments/catalog";

const invisalign = TREATMENTS.find((t) => t.key === "invisalign") as Treatment;

// A clean, on-brand, correctly-priced reply the model might return.
const GOOD_REPLY = JSON.stringify({
  hero: { headline: "Straighten your smile with clear aligners", subhead: "A discreet way to align your teeth, with a free first consultation." },
  benefits: [
    { title: "Discreet", detail: "Clear aligners that most people will not notice day to day." },
    { title: "Removable", detail: "Take them out to eat, brush and floss with ease." },
    { title: "Spread the cost", detail: "0 percent finance is available to help." },
  ],
  pricing: { lines: [{ treatment: "Invisalign", fromPriceGBP: 2500 }], caveat: "A guide price, confirmed after a clinical assessment." },
  faqs: [
    { q: "How long does it take?", a: "It varies from person to person." },
    { q: "Is it right for me?", a: "That depends on a clinical assessment." },
    { q: "Can I spread the cost?", a: "Yes, 0 percent finance is available." },
  ],
  cta: { label: "Check your options", target: "assessment", targetSlug: null },
});

const base = { treatment: invisalign, practiceName: "Vitality Dental", ctaTarget: "assessment" as const };

describe("generateVariant", () => {
  it("uses the model reply when it is clean (source 'model')", async () => {
    const callModel: CallModel = vi.fn(async () => GOOD_REPLY);
    const res = await generateVariant({ ...base, direction: "a", callModel });
    expect(res.source).toBe("model");
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(validateContent(res.content).ok).toBe(true);
    expect(lintContent(res.content).ok).toBe(true);
  });

  it("regenerates once when the first reply fails, then uses it (source 'model-retry')", async () => {
    const callModel: CallModel = vi
      .fn()
      .mockResolvedValueOnce("sorry, here is some prose with no json")
      .mockResolvedValueOnce(GOOD_REPLY);
    const res = await generateVariant({ ...base, direction: "a", callModel });
    expect(res.source).toBe("model-retry");
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(lintContent(res.content).ok).toBe(true);
  });

  it("falls back to the hand-written default after a DOUBLE failure", async () => {
    const callModel: CallModel = vi.fn(async () => "still no usable json here");
    const res = await generateVariant({ ...base, direction: "b", callModel });
    expect(res.source).toBe("default");
    expect(callModel).toHaveBeenCalledTimes(2);
    const expected = getDefaultContent("invisalign", "assessment");
    expect(res.content.hero.headline).toBe(expected?.hero.headline);
    expect(lintContent(res.content).ok).toBe(true);
  });

  it("falls back to the default when the model THROWS", async () => {
    const callModel: CallModel = vi.fn(async () => {
      throw new Error("network down");
    });
    const res = await generateVariant({ ...base, direction: "a", callModel });
    expect(res.source).toBe("default");
    expect(lintContent(res.content).ok).toBe(true);
  });

  it("pins the CTA to the owner-chosen target regardless of the model", async () => {
    // GOOD_REPLY says target 'assessment'; request 'booking'.
    const callModel: CallModel = vi.fn(async () => GOOD_REPLY);
    const res = await generateVariant({ ...base, ctaTarget: "booking", direction: "a", callModel });
    expect(res.content.cta.target).toBe("booking");
  });

  it("also fails a reply that lints against a price mismatch, forcing the retry/default", async () => {
    // A shaped reply with a WRONG price (1999 vs 2500) must not be stored.
    const wrongPrice = JSON.parse(GOOD_REPLY);
    wrongPrice.pricing.lines[0].fromPriceGBP = 1999;
    const callModel: CallModel = vi.fn(async () => JSON.stringify(wrongPrice));
    const res = await generateVariant({ ...base, direction: "a", callModel });
    // Both attempts return the mispriced reply, so we fall back to the default.
    expect(res.source).toBe("default");
    expect(res.content.pricing.lines[0].fromPriceGBP).toBe(2500);
  });
});

describe("generateBothVariants", () => {
  it("produces variants a and b", async () => {
    const callModel: CallModel = vi.fn(async () => GOOD_REPLY);
    const { a, b } = await generateBothVariants({ ...base, callModel });
    expect(a.variant).toBe("a");
    expect(b.variant).toBe("b");
  });
});
