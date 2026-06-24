import { describe, it, expect } from "vitest";
import { findTreatment, TREATMENTS } from "./catalog";

describe("findTreatment", () => {
  it("matches by name and common patient phrasing", () => {
    expect(findTreatment("Invisalign")?.key).toBe("invisalign");
    expect(findTreatment("how much is invisalign")?.key).toBe("invisalign");
    expect(findTreatment("scale and polish")?.key).toBe("hygiene");
    expect(findTreatment("I want an implant")?.key).toBe("implant");
    expect(findTreatment("teeth whitening")?.key).toBe("whitening");
  });

  it("returns null for unknown or too-short queries", () => {
    expect(findTreatment("spaceship repair")).toBeNull();
    expect(findTreatment("x")).toBeNull();
    expect(findTreatment("")).toBeNull();
  });

  it("every treatment has a from-price and patient-facing copy with no em-dash", () => {
    expect(TREATMENTS.length).toBeGreaterThan(0);
    for (const t of TREATMENTS) {
      expect(t.priceFrom).toBeGreaterThan(0);
      expect(t.summary).not.toContain("—");
      expect(t.usp).not.toContain("—");
    }
  });
});
