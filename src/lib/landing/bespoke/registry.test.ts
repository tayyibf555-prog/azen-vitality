import { describe, it, expect } from "vitest";
import { getBespokeTemplate, bespokeVariantCopy } from "./registry";
import { INVISALIGN_LANDING_COPY, BONDING_LANDING_COPY, HYGIENE_LANDING_COPY } from "./copy";
import { scanBannedText } from "@/lib/landing/compliance";

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

  it("returns null for any other (client, slug)", () => {
    expect(getBespokeTemplate("vitality", "veneers")).toBeNull();
    expect(getBespokeTemplate("vitality", "invisalign-demo")).toBeNull();
    expect(getBespokeTemplate("vitality", "bonding-demo")).toBeNull();
    expect(getBespokeTemplate("vitality", "hygiene-demo")).toBeNull();
    expect(getBespokeTemplate("other", "invisalign")).toBeNull();
    expect(getBespokeTemplate("other", "bonding")).toBeNull();
    expect(getBespokeTemplate("other", "hygiene")).toBeNull();
    expect(getBespokeTemplate("", "")).toBeNull();
  });

  it("the hero accent is a verbatim substring of the headline for both variants", () => {
    for (const slug of ["invisalign", "bonding", "hygiene"]) {
      const t = getBespokeTemplate("vitality", slug)!;
      for (const key of ["a", "b"] as const) {
        const v = bespokeVariantCopy(t, key);
        expect(v.heroHeadline.toLowerCase()).toContain(v.heroAccent.toLowerCase());
      }
    }
  });
});

describe("bespoke variant design flags (layout)", () => {
  // The exact per-page chip the price/finance variant b advertises. Real catalogue
  // prices only (invisalign £2,500, bonding £180, hygiene £75), and hygiene carries
  // no finance wording.
  const EXPECTED_B_CHIP: Record<string, { value: string; note: string }> = {
    invisalign: { value: "From £2,500", note: "0% finance available" },
    bonding: { value: "From £180", note: "Usually one visit" },
    hygiene: { value: "£75", note: "Usually about 30 minutes" },
  };

  it("variant a carries NO layout object on any page (structurally identical to today)", () => {
    for (const slug of ["invisalign", "bonding", "hygiene"]) {
      const t = getBespokeTemplate("vitality", slug)!;
      expect(t.variants.a.layout).toBeUndefined();
    }
  });

  it("variant b enables the sticky CTA + the expected hero price chip on every page", () => {
    for (const slug of ["invisalign", "bonding", "hygiene"]) {
      const t = getBespokeTemplate("vitality", slug)!;
      const b = t.variants.b;
      expect(b.layout).toBeDefined();
      expect(b.layout?.stickyCta).toBe(true);
      expect(b.layout?.heroPriceChip).toEqual(EXPECTED_B_CHIP[slug]);
    }
  });

  it("every hero price chip string is compliance-clean", () => {
    for (const slug of ["invisalign", "bonding", "hygiene"]) {
      const chip = getBespokeTemplate("vitality", slug)!.variants.b.layout!.heroPriceChip!;
      expect(scanBannedText(chip.value)).toEqual([]);
      expect(scanBannedText(chip.note)).toEqual([]);
    }
  });

  it("the hygiene chip carries no finance wording (hygiene has no finance)", () => {
    const chip = getBespokeTemplate("vitality", "hygiene")!.variants.b.layout!.heroPriceChip!;
    const text = `${chip.value} ${chip.note}`.toLowerCase();
    expect(text).not.toContain("finance");
    expect(text).not.toContain("0%");
    expect(text).not.toContain("interest");
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
