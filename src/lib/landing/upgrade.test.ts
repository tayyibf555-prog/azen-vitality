import { describe, it, expect } from "vitest";
import { upgradeContent, isV2Content, deriveAccent, genericContent } from "./upgrade";
import { validateContent, CONTENT_VERSION, type LandingPageContent } from "./content";
import { lintContent } from "./compliance";
import { getDefaultContent, DEFAULT_TREATMENT_KEYS } from "./defaults";
import { goodContent, v1Content } from "./test-fixtures";

// The read-time v1 -> v2 mapper is what keeps the seeded demo (and any other
// pre-v2 row) rendering as a full conversion page with no DB migration. These
// tests pin its guarantees: valid v2 out, own copy preserved, filled sections
// lint-clean, idempotent for v2, and never inventing showcase3d.

describe("upgradeContent (v1 -> v2 at read time)", () => {
  it("upgrades the seeded demo v1 shape to valid, lint-clean v2", () => {
    const upgraded = upgradeContent(v1Content(), "invisalign");
    expect(upgraded.version).toBe(CONTENT_VERSION);

    // Shape: passes the v2 validator outright.
    const shape = validateContent(upgraded);
    expect(shape.ok, shape.errors.join("; ")).toBe(true);

    // Compliance: the whole upgraded object lints clean against the REAL catalogue.
    const lint = lintContent(upgraded);
    expect(lint.ok, JSON.stringify(lint.failures)).toBe(true);
  });

  it("preserves the row's own v1 copy (hero, benefits, pricing, faqs, cta)", () => {
    const v1 = v1Content();
    const upgraded = upgradeContent(v1, "invisalign");
    expect(upgraded.hero.headline).toBe("Straighten your smile with Invisalign");
    expect(upgraded.hero.subhead).toMatch(/free initial consultation/);
    expect(upgraded.benefits[2].title).toBe("A confident smile");
    expect(upgraded.pricing.lines[0].fromPriceGBP).toBe(2500);
    expect(upgraded.faqs[0].q).toBe("How long does treatment take?");
    expect(upgraded.cta.label).toBe("Check your options");
    expect(upgraded.cta.target).toBe("assessment");
  });

  it("fills the new sections from the treatment default", () => {
    const upgraded = upgradeContent(v1Content(), "invisalign");
    const def = getDefaultContent("invisalign", "assessment") as LandingPageContent;
    expect(upgraded.hero.eyebrow).toBe(def.hero.eyebrow);
    expect(upgraded.hero.checklist).toEqual(def.hero.checklist);
    expect(upgraded.painPoints.items.length).toBe(def.painPoints.items.length);
    expect(upgraded.about.body).toBe(def.about.body);
    expect(upgraded.howItWorks.steps).toHaveLength(4);
    expect(upgraded.suitability.heading).toBe(def.suitability.heading);
  });

  it("derives an accent that is always a substring of the kept v1 headline", () => {
    const upgraded = upgradeContent(v1Content(), "invisalign");
    expect(
      upgraded.hero.headline.toLowerCase().includes(upgraded.hero.headlineAccent.toLowerCase()),
    ).toBe(true);
    // The seeded headline ends in the treatment name, so that is the accent.
    expect(upgraded.hero.headlineAccent).toBe("Invisalign");
  });

  it("upgrades a v1 row for EVERY default treatment into valid, lint-clean v2", () => {
    for (const key of DEFAULT_TREATMENT_KEYS) {
      const upgraded = upgradeContent(v1Content(), key);
      const shape = validateContent(upgraded);
      expect(shape.ok, `${key}: ${shape.errors.join("; ")}`).toBe(true);
      const lint = lintContent(upgraded);
      expect(lint.ok, `${key}: ${JSON.stringify(lint.failures)}`).toBe(true);
    }
  });

  it("falls back to the generic sections for an unknown treatment, still valid + clean", () => {
    const upgraded = upgradeContent(v1Content(), "not-a-treatment");
    const shape = validateContent(upgraded);
    expect(shape.ok, shape.errors.join("; ")).toBe(true);
    expect(lintContent(upgraded).ok).toBe(true);
    // Own v1 copy still preserved even on the generic path.
    expect(upgraded.hero.headline).toBe("Straighten your smile with Invisalign");
  });

  it("serves the treatment default for unreadable content (never throws)", () => {
    const upgraded = upgradeContent("garbage", "invisalign");
    expect(validateContent(upgraded).ok).toBe(true);
    const def = getDefaultContent("invisalign", "assessment") as LandingPageContent;
    expect(upgraded.hero.headline).toBe(def.hero.headline);
  });

  it("is idempotent: v2 input passes through unchanged (showcase3d preserved)", () => {
    const v2 = validateContent(goodContent()).content as LandingPageContent;
    v2.showcase3d = {
      modelUrl: "/models/aligner.glb",
      posterUrl: "/models/aligner.webp",
      caption: "A clear aligner up close.",
    };
    const out = upgradeContent(v2, "invisalign");
    expect(out).toBe(v2); // same reference, untouched
    expect(isV2Content(out)).toBe(true);
    expect(out.showcase3d?.modelUrl).toBe("/models/aligner.glb");
  });

  it("never invents a showcase3d on an upgraded v1 row (owner-configured only)", () => {
    const upgraded = upgradeContent(v1Content(), "invisalign");
    expect(upgraded.showcase3d).toBeNull();
  });
});

describe("deriveAccent", () => {
  it("prefers the default accent when the headline contains it", () => {
    expect(deriveAccent("Straighter teeth, from 3 months", "from 3 months")).toBe("from 3 months");
  });
  it("falls back to the final word, trimming trailing punctuation", () => {
    expect(deriveAccent("Straighten your smile with Invisalign!", "from 3 months")).toBe("Invisalign");
  });
  it("degenerates safely to the whole headline", () => {
    expect(deriveAccent("Invisalign", null)).toBe("Invisalign");
  });
});

describe("genericContent", () => {
  it("is valid v2 and lint-clean against the real catalogue, for both CTA targets", () => {
    for (const target of ["assessment", "booking"] as const) {
      const c = genericContent(target);
      const shape = validateContent(c);
      expect(shape.ok, shape.errors.join("; ")).toBe(true);
      expect(lintContent(c).ok, JSON.stringify(lintContent(c).failures)).toBe(true);
      expect(c.cta.target).toBe(target);
    }
  });
});
