import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateContent } from "@/lib/landing/content";
import { lintContent, catalogPriceResolver } from "@/lib/landing/compliance";

// Requirement: the JSON seeded by migration 0061 for the four remaining bespoke pages
// (whitening, veneers, implant, checkup), both variants each, must be valid, compliant
// v2 LandingPageContent. Rather than duplicate the JSON, this test reads the ACTUAL
// migration file, extracts the eight jsonb literals in order, and runs the real
// validateContent + lintContent (with the same catalogue price resolver the lint uses
// in production) over them, so the seed can never drift out of spec. Mirrors the 0056
// (invisalign), 0057 (bonding) and 0058 (hygiene) seed tests, extended to four pages.
// Each page still seeds a real landing_page + two variants so it appears in
// Growth > Landing pages with Preview + A/B stats and its lead endpoint works; the
// public /go render is the bespoke component (see bespoke/registry.ts and the per-slug
// vitality-<slug>-landing.tsx), exactly as for the first three pages.

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/0061_vitality_remaining_landings.sql",
);

/** Extract every '{ ... }'::jsonb literal from the migration as parsed objects, in order. */
function seededContents(): unknown[] {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  // The seeded copy contains no apostrophes, so the first }'::jsonb ends each blob.
  const matches = [...sql.matchAll(/'(\{[\s\S]*?\})'::jsonb/g)];
  return matches.map((m) => JSON.parse(m[1]));
}

// The four pages in file order, each with its two variants ([a, b]) and the real
// catalogue price the pricing block must carry.
const PAGES = [
  { slug: "whitening", treatment: "Teeth whitening", price: 350 },
  { slug: "veneers", treatment: "Veneers", price: 450 },
  { slug: "implant", treatment: "Dental implant", price: 2400 },
  { slug: "checkup", treatment: "Checkup", price: 60 },
];

describe("0061 remaining seed content", () => {
  const contents = seededContents();

  it("seeds exactly eight variant content blobs (four pages, two variants each)", () => {
    expect(contents).toHaveLength(8);
  });

  it("every variant passes validateContent AND lintContent", () => {
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

  it("each page's two variants differ only in the hero + CTA (the A/B surface)", () => {
    PAGES.forEach((page, i) => {
      const a = validateContent(contents[i * 2]).content!;
      const b = validateContent(contents[i * 2 + 1]).content!;
      // The A/B surface differs.
      expect(a.hero.headline, page.slug).not.toBe(b.hero.headline);
      expect(a.hero.headlineAccent, page.slug).not.toBe(b.hero.headlineAccent);
      expect(a.hero.subhead, page.slug).not.toBe(b.hero.subhead);
      expect(a.cta.label, page.slug).not.toBe(b.cta.label);
      // Both variants carry the real catalogue price for the page's treatment.
      expect(a.pricing.lines[0]).toMatchObject({ treatment: page.treatment, fromPriceGBP: page.price });
      expect(b.pricing.lines[0]).toMatchObject({ treatment: page.treatment, fromPriceGBP: page.price });
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
  });

  it("checkup carries no finance wording (catalogue financeAvailable is false)", () => {
    // Checkup is the last page (blobs 6 and 7).
    const checkup = [contents[6], contents[7]]
      .map((raw) => JSON.stringify(raw).toLowerCase())
      .join(" \n ");
    expect(checkup).not.toContain("finance");
    expect(checkup).not.toContain("0 percent");
    expect(checkup).not.toContain("spread the cost");
  });

  it("seeds all four pages as DRAFTs and not published", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    for (const { slug } of PAGES) {
      // The landing_page insert seeds each page as a draft (goes live later).
      expect(sql).toContain(`'${slug}', '${slug}', null, 'draft'`);
    }
    expect(sql).not.toContain("'live'");
  });
});
