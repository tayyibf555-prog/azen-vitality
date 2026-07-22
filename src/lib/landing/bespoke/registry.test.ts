import { describe, it, expect } from "vitest";
import { getBespokeTemplate, bespokeVariantCopy } from "./registry";
import { INVISALIGN_LANDING_COPY } from "./copy";
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

  it("returns null for any other (client, slug)", () => {
    expect(getBespokeTemplate("vitality", "veneers")).toBeNull();
    expect(getBespokeTemplate("vitality", "invisalign-demo")).toBeNull();
    expect(getBespokeTemplate("other", "invisalign")).toBeNull();
    expect(getBespokeTemplate("", "")).toBeNull();
  });

  it("the hero accent is a verbatim substring of the headline for both variants", () => {
    const t = getBespokeTemplate("vitality", "invisalign")!;
    for (const key of ["a", "b"] as const) {
      const v = bespokeVariantCopy(t, key);
      expect(v.heroHeadline.toLowerCase()).toContain(v.heroAccent.toLowerCase());
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
