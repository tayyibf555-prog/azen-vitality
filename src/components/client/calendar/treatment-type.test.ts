import { describe, expect, it } from "vitest";
import {
  FAMILY_RULES,
  FAMILY_SLUGS,
  canonicalKey,
  familyOf,
  paletteSlotFor,
  typeLabelFor,
} from "./treatment-type";

describe("canonicalKey", () => {
  it("expands & to 'and' BEFORE stripping, so both spellings give one key", () => {
    expect(canonicalKey("Scale & Polish")).toBe("scale and polish");
    expect(canonicalKey("scale and polish")).toBe("scale and polish");
    expect(canonicalKey("SCALE  &  POLISH")).toBe("scale and polish");
  });

  it("is empty for null, undefined, empty and whitespace-only", () => {
    expect(canonicalKey(null)).toBe("");
    expect(canonicalKey(undefined)).toBe("");
    expect(canonicalKey("")).toBe("");
    expect(canonicalKey("   \t\n ")).toBe("");
  });

  it("collapses punctuation to single spaces and trims", () => {
    expect(canonicalKey("  Exam / Check-up!! ")).toBe("exam check up");
  });
});

describe("paletteSlotFor", () => {
  it("gives the reference's own two colours: Scale & Polish salmon, Extensive Hygiene lavender", () => {
    expect(paletteSlotFor("Scale & Polish")).toBe(8);
    expect(paletteSlotFor("Scale & Polish Extensive Hygiene")).toBe(11);
  });

  it("honours FAMILY_RULES declaration order for the three 'review' traps", () => {
    // Each of these contains "review", which the `treatment` family would claim
    // if it were declared before the specific families.
    expect(paletteSlotFor("Invisalign review")).toBe(10); // ortho, not treatment
    expect(paletteSlotFor("Root canal review")).toBe(11); // endodontic, not treatment
    expect(paletteSlotFor("Implant consult")).toBe(12); // implant, not treatment
  });

  it("falls back to the family for a reason not in TYPE_MAP", () => {
    expect(paletteSlotFor("Upper left wisdom extraction")).toBe(7);
    expect(paletteSlotFor("Composite bonding upper 6")).toBe(6);
    expect(paletteSlotFor("Urgent toothache")).toBe(9);
  });

  it("is slot 0 for an unrecognised reason and for a null reason", () => {
    expect(paletteSlotFor("Zzz unheard of thing")).toBe(0);
    expect(paletteSlotFor(null)).toBe(0);
    expect(paletteSlotFor("")).toBe(0);
  });

  it("lets overrides beat TYPE_MAP, which beats FAMILY_RULES", () => {
    const overrides = new Map([["scale and polish", 3]]);
    expect(paletteSlotFor("Scale & Polish", overrides)).toBe(3);
    // Not overridden: TYPE_MAP still wins over the hygiene family rule (both 8 here,
    // so use a row where they differ).
    expect(paletteSlotFor("Scale & Polish Extensive Hygiene", overrides)).toBe(11);
    // Nothing in TYPE_MAP: the family rule answers.
    expect(paletteSlotFor("Perio maintenance", overrides)).toBe(8);
  });

  it("ignores an out-of-range or non-integer override rather than drawing nothing", () => {
    expect(paletteSlotFor("Scale & Polish", new Map([["scale and polish", 99]]))).toBe(8);
    expect(paletteSlotFor("Scale & Polish", new Map([["scale and polish", -1]]))).toBe(8);
  });
});

describe("familyOf", () => {
  it("classifies each family and returns null for nothing recognisable", () => {
    expect(familyOf("Implant fit")).toBe("implant");
    expect(familyOf("Retainer check")).toBe("ortho");
    expect(familyOf("RCT upper 6")).toBe("endodontic");
    expect(familyOf("XLA lower 8")).toBe("surgical");
    expect(familyOf("Crown prep")).toBe("restorative");
    expect(familyOf("Whitening top up")).toBe("cosmetic");
    expect(familyOf("Hygienist")).toBe("hygiene");
    expect(familyOf("Emergency")).toBe("emergency");
    expect(familyOf("Examination")).toBe("exam");
    expect(familyOf("Continuing treatment")).toBe("treatment");
    expect(familyOf("Zzz unheard of thing")).toBeNull();
    expect(familyOf(null)).toBeNull();
  });
});

describe("the palette contract", () => {
  it("gives every family a DISTINCT slot", () => {
    const slots = FAMILY_RULES.map((r) => r.slot);
    expect(new Set(slots).size).toBe(FAMILY_RULES.length);
  });

  it("declares exactly the ten families in FAMILY_SLUGS", () => {
    expect(FAMILY_RULES.map((r) => r.slug).sort()).toEqual([...FAMILY_SLUGS].sort());
  });

  it("keeps every slot inside the thirteen-slot palette", () => {
    for (const rule of FAMILY_RULES) {
      expect(rule.slot).toBeGreaterThanOrEqual(0);
      expect(rule.slot).toBeLessThan(13);
    }
  });
});

describe("typeLabelFor", () => {
  it("prints the checked-in label, and null when we do not have one", () => {
    expect(typeLabelFor("scale & polish")).toBe("Scale & Polish");
    expect(typeLabelFor("Upper left wisdom extraction")).toBeNull();
    expect(typeLabelFor(null)).toBeNull();
  });

  it("lets an override rename a type", () => {
    expect(typeLabelFor("Scale & Polish", new Map([["scale and polish", "S&P"]]))).toBe("S&P");
  });
});
