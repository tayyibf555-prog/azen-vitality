import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateContent } from "@/lib/landing/content";
import { lintContent, catalogPriceResolver } from "@/lib/landing/compliance";

// Requirement: the JSON seeded by migration 0058 for BOTH variants must be valid,
// compliant v2 LandingPageContent. Rather than duplicate the JSON, this test reads
// the ACTUAL migration file, extracts the two jsonb literals, and runs the real
// validateContent + lintContent (with the same catalogue price resolver the lint
// uses in production) over them, so the seed can never drift out of spec.
// Mirrors the 0056 (Invisalign) and 0057 (bonding) seed tests. This page uses the
// GENERIC renderer: hygiene is deliberately NOT in the bespoke registry.

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/0058_vitality_hygiene_landing.sql",
);

/** Extract every '{ ... }'::jsonb literal from the migration as parsed objects. */
function seededContents(): unknown[] {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  // The seeded copy contains no apostrophes, so the first }'::jsonb ends each blob.
  const matches = [...sql.matchAll(/'(\{[\s\S]*?\})'::jsonb/g)];
  return matches.map((m) => JSON.parse(m[1]));
}

describe("0058 hygiene seed content", () => {
  const contents = seededContents();

  it("seeds exactly two variant content blobs", () => {
    expect(contents).toHaveLength(2);
  });

  it("both variants pass validateContent AND lintContent", () => {
    for (const raw of contents) {
      const validation = validateContent(raw);
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
      // Resolve prices via the same catalogue resolver lintContent uses in prod.
      const lint = lintContent(validation.content!, { resolvePrice: catalogPriceResolver });
      expect(lint.failures).toEqual([]);
      expect(lint.ok).toBe(true);
    }
  });

  it("the two variants differ only in their hero and CTA (the A/B surface)", () => {
    const [a, b] = contents.map((raw) => validateContent(raw).content!);
    expect(a.hero.headline).not.toBe(b.hero.headline);
    expect(a.hero.headlineAccent).not.toBe(b.hero.headlineAccent);
    expect(a.hero.subhead).not.toBe(b.hero.subhead);
    expect(a.cta.label).not.toBe(b.cta.label);
    // Pricing is the real catalogue figure on both (Hygiene visit from GBP 75).
    expect(a.pricing.lines[0]).toMatchObject({ treatment: "Hygiene visit", fromPriceGBP: 75 });
    expect(b.pricing.lines[0]).toMatchObject({ treatment: "Hygiene visit", fromPriceGBP: 75 });
    // Both CTAs route to booking (no downstream assessment funnel).
    expect(a.cta.target).toBe("booking");
    expect(b.cta.target).toBe("booking");
    expect(a.cta.targetSlug).toBeNull();
    expect(b.cta.targetSlug).toBeNull();
    // Everything outside the A/B surface is identical.
    expect(a.benefits).toEqual(b.benefits);
    expect(a.painPoints).toEqual(b.painPoints);
    expect(a.about).toEqual(b.about);
    expect(a.howItWorks).toEqual(b.howItWorks);
    expect(a.suitability).toEqual(b.suitability);
    expect(a.pricing).toEqual(b.pricing);
    expect(a.faqs).toEqual(b.faqs);
  });

  it("is seeded as a DRAFT and not published", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    // The landing_page insert seeds the hygiene page as a draft (goes live later).
    expect(sql).toContain("'hygiene', 'hygiene', null, 'draft'");
    expect(sql).not.toContain("'live'");
  });
});
