import { describe, it, expect, vi } from "vitest";
import { generateVariant, generateBothVariants, type CallModel } from "./generate-run";
import { validateContent } from "./content";
import { lintContent } from "./compliance";
import { getDefaultContent } from "./defaults";
import { buildVariantPrompt, CREATIVE_DIRECTIONS } from "./generate";
import { goodContent } from "./test-fixtures";
import { TREATMENTS, type Treatment } from "@/lib/treatments/catalog";

const invisalign = TREATMENTS.find((t) => t.key === "invisalign") as Treatment;

// A clean, on-brand, correctly-priced v2 reply the model might return.
const GOOD_REPLY = JSON.stringify(goodContent());

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

  it("also rejects a v1-SHAPED reply (missing the new sections), forcing retry/default", async () => {
    const v1ish = JSON.parse(GOOD_REPLY) as Record<string, unknown>;
    delete v1ish.painPoints;
    delete v1ish.howItWorks;
    const callModel: CallModel = vi.fn(async () => JSON.stringify(v1ish));
    const res = await generateVariant({ ...base, direction: "a", callModel });
    expect(res.source).toBe("default");
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

  it("STRIPS any model-supplied showcase3d (owner-configured only, never generated)", async () => {
    const withShowcase = JSON.parse(GOOD_REPLY) as Record<string, unknown>;
    withShowcase.showcase3d = {
      modelUrl: "/models/made-up.glb",
      posterUrl: "/models/made-up.webp",
      caption: "A model the AI invented.",
    };
    const callModel: CallModel = vi.fn(async () => JSON.stringify(withShowcase));
    const res = await generateVariant({ ...base, direction: "a", callModel });
    expect(res.source).toBe("model"); // otherwise clean, so the reply is used
    expect(res.content.showcase3d).toBeNull(); // but the 3D section is stripped
  });

  it("rejects a reply carrying an invented proof claim (award), forcing the fallback", async () => {
    const withAward = JSON.parse(GOOD_REPLY) as { hero: { eyebrow: string } };
    withAward.hero.eyebrow = "Award winning aligners";
    const callModel: CallModel = vi.fn(async () => JSON.stringify(withAward));
    const res = await generateVariant({ ...base, direction: "a", callModel });
    // Both attempts return the award claim, so we fall back to the clean default.
    expect(res.source).toBe("default");
    expect(lintContent(res.content).ok).toBe(true);
  });

  it("also fails a reply that lints against a price mismatch, forcing the retry/default", async () => {
    // A shaped reply with a WRONG price (1999 vs 2500) must not be stored.
    const wrongPrice = JSON.parse(GOOD_REPLY) as { pricing: { lines: { fromPriceGBP: number }[] } };
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

describe("buildVariantPrompt (v2)", () => {
  it("explicitly forbids invented proof claims and the showcase3d key", () => {
    const { system } = buildVariantPrompt({
      direction: CREATIVE_DIRECTIONS.a,
      treatment: invisalign,
      practiceName: "Vitality Dental",
      ctaTarget: "assessment",
    });
    expect(system).toMatch(/never mention a Google rating, a review count, awards/i);
    expect(system).toMatch(/no showcase3d key/i);
    expect(system).toMatch(/headlineAccent/);
    // The real price line is pinned into the prompt.
    expect(system).toContain('fromPriceGBP 2500');
  });

  it("keeps the exemplars free of version/showcase keys and excludes the focus treatment", () => {
    const { system } = buildVariantPrompt({
      direction: CREATIVE_DIRECTIONS.b,
      treatment: invisalign,
      practiceName: "Vitality Dental",
      ctaTarget: "booking",
    });
    // Exemplars are serialised defaults; they must not teach the model to emit
    // the owner-only keys, nor include the invisalign default itself.
    expect(system).not.toMatch(/"showcase3d"/);
    expect(system).not.toMatch(/"version"/);
    const refs = system.split("Reference ").slice(1);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const ref of refs) {
      expect(ref).not.toContain('"treatment":"Invisalign"');
    }
  });
});
