import { describe, expect, it } from "vitest";
import { SUITABILITY_SEED } from "./suitability-seed";
import { capabilityFor, capabilityReason, isSuitable } from "./suitability";

describe("capabilityFor", () => {
  it("prefers an EXACT-site row over a null-site row", () => {
    // prac-2 cannot do implants in general, but the implant suite is at site-cc.
    expect(capabilityFor(SUITABILITY_SEED, "prac-2", null, "implant")).toBe("cannot");
    expect(capabilityFor(SUITABILITY_SEED, "prac-2", "site-rv", "implant")).toBe("cannot");
    expect(capabilityFor(SUITABILITY_SEED, "prac-2", "site-cc", "implant")).toBe("can");
  });

  it("falls back to the null-site row at any other site", () => {
    expect(capabilityFor(SUITABILITY_SEED, "prac-1", "site-cc", "restorative")).toBe("can");
    expect(capabilityFor(SUITABILITY_SEED, "prac-1", "site-ng", "restorative")).toBe("can");
  });

  it("returns 'unknown' for a practitioner with NO rows at all", () => {
    for (const family of ["hygiene", "surgical", "exam"] as const) {
      expect(capabilityFor(SUITABILITY_SEED, "prac-21", "site-ng", family)).toBe("unknown");
    }
  });

  it("returns 'unknown' for a family a known practitioner has no row for", () => {
    // prac-3 Jin Kim has no hygiene row: a partial record, not a permission.
    expect(capabilityFor(SUITABILITY_SEED, "prac-3", "site-cc", "hygiene")).toBe("unknown");
  });

  it("never coerces 'unknown' to 'can'", () => {
    expect(isSuitable(capabilityFor(SUITABILITY_SEED, "prac-21", "site-ng", "surgical"))).toBe(false);
    expect(isSuitable(capabilityFor(SUITABILITY_SEED, "prac-3", "site-cc", "hygiene"))).toBe(false);
  });

  it("reads the seeded hygienist as hygiene-only", () => {
    expect(capabilityFor(SUITABILITY_SEED, "prac-4", "site-cc", "hygiene")).toBe("can");
    expect(capabilityFor(SUITABILITY_SEED, "prac-4", "site-cc", "surgical")).toBe("cannot");
    expect(capabilityFor(SUITABILITY_SEED, "prac-4", "site-cc", "implant")).toBe("cannot");
  });

  it("reads the seeded 'supervised' row as supervised, which IS suitable", () => {
    expect(capabilityFor(SUITABILITY_SEED, "prac-3", "site-cc", "surgical")).toBe("supervised");
    expect(isSuitable("supervised")).toBe(true);
  });
});

describe("isSuitable", () => {
  it("admits only 'can' and 'supervised'", () => {
    expect(isSuitable("can")).toBe(true);
    expect(isSuitable("supervised")).toBe(true);
    expect(isSuitable("cannot")).toBe(false);
    expect(isSuitable("unknown")).toBe(false);
  });
});

describe("capabilityReason", () => {
  it("tells a missing record apart from a refusal, because they call for different actions", () => {
    expect(capabilityReason("cannot", "Extraction")).toBe("They do not do Extraction.");
    expect(capabilityReason("unknown", "Extraction")).toBe(
      "We do not have a record of who can do this treatment.",
    );
    expect(capabilityReason("can", "Extraction")).toBe("");
  });
});

describe("SUITABILITY_SEED", () => {
  it("is entirely seed data, so the source can switch wholesale", () => {
    expect(SUITABILITY_SEED.every((c) => c.source === "seed")).toBe(true);
  });

  it("leaves prac-21 out entirely, so 'unknown' is reachable", () => {
    expect(SUITABILITY_SEED.some((c) => c.practitionerId === "prac-21")).toBe(false);
  });
});
