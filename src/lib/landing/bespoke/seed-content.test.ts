import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateContent } from "@/lib/landing/content";
import { lintContent } from "@/lib/landing/compliance";

// Requirement: the JSON seeded by migration 0056 for BOTH variants must be valid,
// compliant v2 LandingPageContent. Rather than duplicate the JSON, this test reads
// the ACTUAL migration file, extracts the two jsonb literals, and runs the real
// validateContent + lintContent over them, so the seed can never drift out of spec.

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/0056_vitality_invisalign_landing.sql",
);

/** Extract every '{ ... }'::jsonb literal from the migration as parsed objects. */
function seededContents(): unknown[] {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  // The seeded copy contains no apostrophes, so the first }'::jsonb ends each blob.
  const matches = [...sql.matchAll(/'(\{[\s\S]*?\})'::jsonb/g)];
  return matches.map((m) => JSON.parse(m[1]));
}

describe("0056 seed content", () => {
  const contents = seededContents();

  it("seeds exactly two variant content blobs", () => {
    expect(contents).toHaveLength(2);
  });

  it("both variants pass validateContent AND lintContent", () => {
    for (const raw of contents) {
      const validation = validateContent(raw);
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
      const lint = lintContent(validation.content!);
      expect(lint.failures).toEqual([]);
      expect(lint.ok).toBe(true);
    }
  });

  it("the two variants differ only in their hero and CTA (the A/B surface)", () => {
    const [a, b] = contents.map((raw) => validateContent(raw).content!);
    expect(a.hero.headline).not.toBe(b.hero.headline);
    expect(a.cta.label).not.toBe(b.cta.label);
    // Pricing is the real catalogue figure on both.
    expect(a.pricing.lines[0]).toMatchObject({ treatment: "Invisalign", fromPriceGBP: 2500 });
    expect(b.pricing.lines[0]).toMatchObject({ treatment: "Invisalign", fromPriceGBP: 2500 });
    // Everything outside the A/B surface is identical.
    expect(a.benefits).toEqual(b.benefits);
    expect(a.painPoints).toEqual(b.painPoints);
    expect(a.suitability).toEqual(b.suitability);
    expect(a.faqs).toEqual(b.faqs);
  });
});
