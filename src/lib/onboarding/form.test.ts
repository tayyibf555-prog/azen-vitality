import { describe, it, expect } from "vitest";
import { slugify, isValidSlug, normaliseFormConfig, EMPTY_FORM_CONFIG } from "./form";

describe("onboarding form slugify", () => {
  it("normalises names into url-safe slugs", () => {
    expect(slugify("New Patient Registration")).toBe("new-patient-registration");
    expect(slugify("  Spring  Offer!  ")).toBe("spring-offer");
    expect(slugify("Implants_&_Veneers")).toBe("implants-veneers");
    expect(slugify("café crème")).toBe("caf-crme");
  });

  it("returns empty string when nothing usable remains", () => {
    expect(slugify("")).toBe("");
    expect(slugify(null)).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("caps length at 60 and never ends on a dash", () => {
    const long = "a".repeat(80);
    const s = slugify(long);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("isValidSlug", () => {
  it("accepts a clean slug", () => {
    expect(isValidSlug("new-patients")).toBe(true);
  });

  it("rejects reserved, empty, or non-normalised slugs", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("onboard")).toBe(false); // reserved (would shadow the route)
    expect(isValidSlug("api")).toBe(false);
    expect(isValidSlug("New Patients")).toBe(false); // has spaces/caps -> not normalised
    expect(isValidSlug("has--double")).toBe(false); // collapses on normalise, so != itself
  });
});

describe("normaliseFormConfig", () => {
  it("coerces missing/empty/garbage into a valid config (never crashes resolveSteps)", () => {
    expect(normaliseFormConfig(undefined)).toEqual(EMPTY_FORM_CONFIG);
    expect(normaliseFormConfig(null)).toEqual(EMPTY_FORM_CONFIG);
    expect(normaliseFormConfig("nope")).toEqual(EMPTY_FORM_CONFIG);
    expect(normaliseFormConfig({})).toEqual(EMPTY_FORM_CONFIG);
  });

  it("keeps valid arrays and drops non-string enabled keys + falsy required flags", () => {
    const cfg = normaliseFormConfig({
      enabledKeys: ["first_name", 42, "phone", null],
      required: { first_name: true, phone: false, email: "yes" },
      custom: [{ key: "custom-x", label: "X", type: "text", category: "personal", required: false }, null, "bad"],
    });
    expect(cfg.enabledKeys).toEqual(["first_name", "phone"]);
    expect(cfg.required).toEqual({ first_name: true }); // only strict true survives
    expect(cfg.custom).toHaveLength(1);
  });
});
