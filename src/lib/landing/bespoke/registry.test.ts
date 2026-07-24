import { describe, it, expect } from "vitest";
import { getBespokeTemplate, bespokeVariantCopy } from "./registry";
import {
  INVISALIGN_LANDING_COPY,
  BONDING_LANDING_COPY,
  HYGIENE_LANDING_COPY,
  WHITENING_LANDING_COPY,
  VENEERS_LANDING_COPY,
  IMPLANT_LANDING_COPY,
  CHECKUP_LANDING_COPY,
  type TreatmentLandingCopy,
} from "./copy";
import { scanBannedText } from "@/lib/landing/compliance";

// The four remaining treatments share one shape + one renderer, so they are scanned
// together here (slug -> its shared corpus).
const REMAINING_CORPORA: { slug: string; templateId: string; copy: TreatmentLandingCopy }[] = [
  { slug: "whitening", templateId: "vitality-whitening", copy: WHITENING_LANDING_COPY },
  { slug: "veneers", templateId: "vitality-veneers", copy: VENEERS_LANDING_COPY },
  { slug: "implant", templateId: "vitality-implant", copy: IMPLANT_LANDING_COPY },
  { slug: "checkup", templateId: "vitality-checkup", copy: CHECKUP_LANDING_COPY },
];

// Every bespoke slug (the three original pages + the four remaining), used by the
// substring + price-led rules below.
const ALL_BESPOKE_SLUGS = [
  "invisalign",
  "bonding",
  "hygiene",
  "whitening",
  "veneers",
  "implant",
  "checkup",
];

// Two guarantees for the bespoke Invisalign landing:
//   (a) the registry resolves the template for vitality/invisalign and nothing else;
//   (b) EVERY user-visible copy string (the shared copy module + both A/B variant
//       copies) passes the same deterministic compliance scan the generic landing
//       lint uses, so the ported design carries no testimonials, star ratings,
//       guarantees, pain-free claims, superlatives, funding words or dash symbols.

/** Recursively collect every string value from a copy object/array. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
  return out;
}

describe("bespoke registry", () => {
  it("returns the vitality/invisalign template", () => {
    const t = getBespokeTemplate("vitality", "invisalign");
    expect(t).not.toBeNull();
    expect(t?.templateId).toBe("vitality-invisalign");
    expect(t?.treatment).toBe("invisalign");
    expect(t?.variants.a).toBeDefined();
    expect(t?.variants.b).toBeDefined();
  });

  it("returns the vitality/bonding template", () => {
    const t = getBespokeTemplate("vitality", "bonding");
    expect(t).not.toBeNull();
    expect(t?.templateId).toBe("vitality-bonding");
    expect(t?.treatment).toBe("bonding");
    expect(t?.variants.a).toBeDefined();
    expect(t?.variants.b).toBeDefined();
    // The A/B surface really differs between the variants.
    expect(t?.variants.a.heroHeadline).not.toBe(t?.variants.b.heroHeadline);
    expect(t?.variants.a.ctaLabel).not.toBe(t?.variants.b.ctaLabel);
  });

  it("returns the vitality/hygiene template", () => {
    const t = getBespokeTemplate("vitality", "hygiene");
    expect(t).not.toBeNull();
    expect(t?.templateId).toBe("vitality-hygiene");
    expect(t?.treatment).toBe("hygiene");
    expect(t?.variants.a).toBeDefined();
    expect(t?.variants.b).toBeDefined();
    // The A/B surface really differs between the variants.
    expect(t?.variants.a.heroHeadline).not.toBe(t?.variants.b.heroHeadline);
    expect(t?.variants.a.ctaLabel).not.toBe(t?.variants.b.ctaLabel);
  });

  it("returns the four remaining templates (whitening, veneers, implant, checkup)", () => {
    for (const { slug, templateId } of REMAINING_CORPORA) {
      const t = getBespokeTemplate("vitality", slug);
      expect(t, slug).not.toBeNull();
      expect(t?.templateId).toBe(templateId);
      expect(t?.treatment).toBe(slug);
      expect(t?.variants.a).toBeDefined();
      expect(t?.variants.b).toBeDefined();
      // The A/B surface really differs between the variants (headline AND CTA).
      expect(t?.variants.a.heroHeadline).not.toBe(t?.variants.b.heroHeadline);
      expect(t?.variants.a.ctaLabel).not.toBe(t?.variants.b.ctaLabel);
    }
  });

  it("returns null for any other (client, slug)", () => {
    // Non-bespoke catalogue treatments still fall through to the generic renderer.
    expect(getBespokeTemplate("vitality", "root-canal")).toBeNull();
    expect(getBespokeTemplate("vitality", "dentures")).toBeNull();
    expect(getBespokeTemplate("vitality", "invisalign-demo")).toBeNull();
    expect(getBespokeTemplate("vitality", "bonding-demo")).toBeNull();
    expect(getBespokeTemplate("vitality", "hygiene-demo")).toBeNull();
    expect(getBespokeTemplate("vitality", "whitening-demo")).toBeNull();
    expect(getBespokeTemplate("other", "invisalign")).toBeNull();
    expect(getBespokeTemplate("other", "whitening")).toBeNull();
    expect(getBespokeTemplate("other", "checkup")).toBeNull();
    expect(getBespokeTemplate("", "")).toBeNull();
  });

  it("the hero accent is a verbatim substring of the headline for both variants", () => {
    for (const slug of ALL_BESPOKE_SLUGS) {
      const t = getBespokeTemplate("vitality", slug)!;
      for (const key of ["a", "b"] as const) {
        const v = bespokeVariantCopy(t, key);
        expect(v.heroHeadline.toLowerCase()).toContain(v.heroAccent.toLowerCase());
      }
    }
  });
});

describe("bespoke copy compliance", () => {
  const template = getBespokeTemplate("vitality", "invisalign")!;

  // The full corpus of user-visible strings on the bespoke page.
  const strings = [
    ...collectStrings(INVISALIGN_LANDING_COPY),
    ...collectStrings(template.variants.a),
    ...collectStrings(template.variants.b),
  ];

  it("has a non-trivial corpus to scan", () => {
    expect(strings.length).toBeGreaterThan(60);
  });

  it("finds zero banned-pattern hits across every visible string", () => {
    const hits: { text: string; category: string; matched: string }[] = [];
    for (const text of strings) {
      for (const hit of scanBannedText(text)) {
        hits.push({ text, category: hit.category, matched: hit.matched });
      }
    }
    // Surface every offending string so a failure is actionable.
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});

describe("bespoke bonding copy compliance", () => {
  const template = getBespokeTemplate("vitality", "bonding")!;

  // The full corpus of user-visible strings on the bespoke bonding page.
  const strings = [
    ...collectStrings(BONDING_LANDING_COPY),
    ...collectStrings(template.variants.a),
    ...collectStrings(template.variants.b),
  ];

  it("has a non-trivial corpus to scan", () => {
    expect(strings.length).toBeGreaterThan(60);
  });

  it("finds zero banned-pattern hits across every visible string", () => {
    const hits: { text: string; category: string; matched: string }[] = [];
    for (const text of strings) {
      for (const hit of scanBannedText(text)) {
        hits.push({ text, category: hit.category, matched: hit.matched });
      }
    }
    // Surface every offending string so a failure is actionable.
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});

describe("bespoke hygiene copy compliance", () => {
  const template = getBespokeTemplate("vitality", "hygiene")!;

  // The full corpus of user-visible strings on the bespoke hygiene page, including
  // the before/after slider caption + Before/After labels (they live in the copy
  // module and are scanned here too).
  const strings = [
    ...collectStrings(HYGIENE_LANDING_COPY),
    ...collectStrings(template.variants.a),
    ...collectStrings(template.variants.b),
  ];

  it("has a non-trivial corpus to scan", () => {
    expect(strings.length).toBeGreaterThan(60);
  });

  it("finds zero banned-pattern hits across every visible string", () => {
    const hits: { text: string; category: string; matched: string }[] = [];
    for (const text of strings) {
      for (const hit of scanBannedText(text)) {
        hits.push({ text, category: hit.category, matched: hit.matched });
      }
    }
    // Surface every offending string so a failure is actionable.
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  it("includes the exact before/after slider caption, and it is compliant", () => {
    // The caption must say the image is an illustration, verbatim, and must itself
    // be clean (it is part of the scanned corpus above, asserted here explicitly).
    expect(HYGIENE_LANDING_COPY.beforeAfter.caption).toBe(
      "Drag to compare. Illustrative model, not a patient photo.",
    );
    expect(scanBannedText(HYGIENE_LANDING_COPY.beforeAfter.caption)).toEqual([]);
  });

  it("carries no finance wording anywhere (hygiene has no finance)", () => {
    const corpus = strings.join(" \n ").toLowerCase();
    expect(corpus).not.toContain("finance");
    expect(corpus).not.toContain("0%");
    expect(corpus).not.toContain("0 percent");
    expect(corpus).not.toContain("interest-free");
    expect(corpus).not.toContain("spread the cost");
  });
});

// The four remaining bespoke corpora, each scanned together with its A/B variant copy,
// exactly like the three describe blocks above. One loop keeps them all enforced.
describe.each(REMAINING_CORPORA)("bespoke $slug copy compliance", ({ slug, copy }) => {
  const template = getBespokeTemplate("vitality", slug)!;
  const strings = [
    ...collectStrings(copy),
    ...collectStrings(template.variants.a),
    ...collectStrings(template.variants.b),
  ];

  it("has a non-trivial corpus to scan", () => {
    expect(strings.length).toBeGreaterThan(60);
  });

  it("finds zero banned-pattern hits across every visible string", () => {
    const hits: { text: string; category: string; matched: string }[] = [];
    for (const text of strings) {
      for (const hit of scanBannedText(text)) {
        hits.push({ text, category: hit.category, matched: hit.matched });
      }
    }
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});

// Checkup has NO finance (catalogue financeAvailable is false), so its corpus must
// carry no finance/interest wording anywhere, like the hygiene page.
describe("bespoke checkup copy carries no finance wording", () => {
  const template = getBespokeTemplate("vitality", "checkup")!;
  const corpus = [
    ...collectStrings(CHECKUP_LANDING_COPY),
    ...collectStrings(template.variants.a),
    ...collectStrings(template.variants.b),
  ]
    .join(" \n ")
    .toLowerCase();

  it("has no finance / interest / spread-the-cost wording", () => {
    expect(corpus).not.toContain("finance");
    expect(corpus).not.toContain("0%");
    expect(corpus).not.toContain("0 percent");
    expect(corpus).not.toContain("interest-free");
    expect(corpus).not.toContain("spread the cost");
  });
});

describe("price-led headline split (owner rule)", () => {
  // Owner rule: exactly ONE variant may lead with a price. Variant A stays
  // outcome-led (no GBP figure in its headline); the price angle lives in B only.
  // Enforced across every bespoke slug, including the four remaining pages (checkup
  // is price-led in B via its flat catalogue price, just without any finance wording).
  it("variant A headlines never contain a price; variant B headlines do", () => {
    for (const slug of ALL_BESPOKE_SLUGS) {
      const tpl = getBespokeTemplate("vitality", slug)!;
      expect(tpl.variants.a.heroHeadline, `${slug} A`).not.toMatch(/£/);
      expect(tpl.variants.b.heroHeadline, `${slug} B`).toMatch(/£/);
    }
  });
});
