import { describe, it, expect } from "vitest";
import {
  EXEMPTION_CATEGORIES,
  EXEMPTION_KEYS,
  FP17_SOURCE,
  FP17_SOURCE_VERSION,
  PAYING_KEY,
  PAYING_LABEL,
  declarationChoiceLabel,
  exemptionCategory,
  isDeclarationChoice,
  isExemptionKey,
} from "./exemptions";

// The exemption catalogue is the legal content of the FP17 feature, so this test
// DOCUMENTS THE SOURCE and pins the invariants that make a wrong or over-broad
// claim impossible to introduce silently.

describe("FP17 exemption source", () => {
  it("names the NHS BSA England source and carries a dated version", () => {
    // If the wording is ever revised, this source string and the dated version are
    // what a reviewer checks against the live NHS BSA declaration before switch-on.
    expect(FP17_SOURCE).toContain("NHS Business Services Authority");
    expect(FP17_SOURCE).toContain("England");
    // yyyy-mm-dd — a real, parseable date, not a placeholder.
    expect(FP17_SOURCE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(FP17_SOURCE_VERSION))).toBe(false);
  });
});

describe("exemption categories", () => {
  it("has unique, non-empty keys and labels", () => {
    expect(EXEMPTION_KEYS.length).toBe(new Set(EXEMPTION_KEYS).size);
    for (const c of EXEMPTION_CATEGORIES) {
      expect(c.key.length).toBeGreaterThan(0);
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it("includes the standard England categories", () => {
    for (const key of [
      "under-18",
      "18-full-time-education",
      "pregnant",
      "new-mother",
      "income-support",
      "income-based-jsa",
      "income-related-esa",
      "pension-credit-guarantee",
      "universal-credit",
      "nhs-tax-credit-cert",
      "hc2",
    ]) {
      expect(EXEMPTION_KEYS).toContain(key);
    }
  });

  it("NEVER lists HC3 — it is partial help, not a free exemption", () => {
    // The load-bearing correction. HC3 must not be a claimable category; only HC2 is.
    expect(EXEMPTION_KEYS).not.toContain("hc3");
    for (const c of EXEMPTION_CATEGORIES) {
      expect(c.label.toLowerCase()).not.toContain("hc3 certificate");
    }
    // And HC2's own note warns about the HC3 confusion.
    const hc2 = exemptionCategory("hc2");
    expect(hc2?.note?.toLowerCase()).toContain("hc3");
  });

  it("flags the NHS Tax Credit certificate as being phased out", () => {
    expect(exemptionCategory("nhs-tax-credit-cert")?.note?.toLowerCase()).toContain("phased out");
  });

  it("does not bake a specific Universal Credit earnings figure into the wording", () => {
    // The threshold changes; a stale £ figure on a legal form is exactly what we avoid.
    const uc = exemptionCategory("universal-credit");
    expect(uc).toBeTruthy();
    expect(uc!.label).not.toMatch(/£\s?\d/);
    expect(uc!.note?.toLowerCase()).toContain("threshold");
  });

  it("marks certificate-backed claims as requiring a certificate", () => {
    for (const key of ["pregnant", "new-mother", "nhs-tax-credit-cert", "hc2"]) {
      expect(exemptionCategory(key)?.requiresCertificate).toBe(true);
    }
  });
});

describe("the 'paying' opt-out", () => {
  it("is a valid declaration choice but NOT an exemption", () => {
    expect(isDeclarationChoice(PAYING_KEY)).toBe(true);
    expect(isExemptionKey(PAYING_KEY)).toBe(false);
    // It must never appear among the exemption categories themselves.
    expect(EXEMPTION_KEYS).not.toContain(PAYING_KEY);
  });

  it("has patient-facing wording and resolves via declarationChoiceLabel", () => {
    expect(PAYING_LABEL.length).toBeGreaterThan(0);
    expect(declarationChoiceLabel(PAYING_KEY)).toBe(PAYING_LABEL);
    expect(declarationChoiceLabel("under-18")).toBe(exemptionCategory("under-18")!.label);
    expect(declarationChoiceLabel("nonsense")).toBeUndefined();
  });
});

describe("choice guards", () => {
  it("accepts known exemption keys and rejects everything else", () => {
    expect(isExemptionKey("under-18")).toBe(true);
    expect(isExemptionKey("hc2")).toBe(true);
    expect(isExemptionKey("hc3")).toBe(false);
    expect(isExemptionKey("")).toBe(false);
    expect(isExemptionKey(null)).toBe(false);
    expect(isExemptionKey(42)).toBe(false);
  });

  it("isDeclarationChoice is exemptions ∪ {paying}", () => {
    expect(isDeclarationChoice("hc2")).toBe(true);
    expect(isDeclarationChoice("paying")).toBe(true);
    expect(isDeclarationChoice("hc3")).toBe(false);
    expect(isDeclarationChoice(undefined)).toBe(false);
  });
});
