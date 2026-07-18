import { describe, it, expect } from "vitest";
import { buildRecreatePrompt, PLACEHOLDER_BRAND_COLOURS } from "./recreate";
import { scanBannedText } from "@/lib/landing/compliance";

const BASE = {
  practiceName: "Vitality Dental",
  brandColours: PLACEHOLDER_BRAND_COLOURS,
  locationsLine: "N15, N17 and Romford Road, London",
  treatmentName: "Teeth whitening",
  fromPriceGBP: 350,
  angle: "Outcome-first (event-led)",
  format: "reel" as const,
};

describe("buildRecreatePrompt: brand-true, compliant text", () => {
  it("weaves in the real practice name, treatment, locations, angle and brand colours", () => {
    const prompt = buildRecreatePrompt(BASE);
    expect(prompt).toContain("Vitality Dental");
    expect(prompt).toContain("Teeth whitening");
    expect(prompt).toContain("N15, N17 and Romford Road, London");
    expect(prompt).toContain("Outcome-first (event-led)");
    expect(prompt).toContain("#16559a");
  });

  it("reflects the format in the aspect ratio (reel -> 9:16)", () => {
    expect(buildRecreatePrompt(BASE)).toContain("9:16");
    expect(buildRecreatePrompt({ ...BASE, format: "image" })).toContain("1:1");
  });

  it("omits the locations clause when there is no locations line", () => {
    const prompt = buildRecreatePrompt({ ...BASE, locationsLine: null });
    expect(prompt).not.toContain(" in N15");
  });

  it("only shows the real from-price when the owner opts in", () => {
    expect(buildRecreatePrompt(BASE)).not.toContain("From £350");
    const withPrice = buildRecreatePrompt({ ...BASE, includeFromPrice: true });
    expect(withPrice).toContain("From £350");
  });

  it("never shows a price it does not have, even if opted in", () => {
    const prompt = buildRecreatePrompt({ ...BASE, fromPriceGBP: null, includeFromPrice: true });
    expect(prompt).not.toContain("From £");
  });

  it("instructs brand-safe, honest imagery (no fabricated real patients, no before/after)", () => {
    const prompt = buildRecreatePrompt(BASE).toLowerCase();
    expect(prompt).toContain("never present anyone as a named or actual patient");
    expect(prompt).toContain("before and after");
  });

  it("produces a prompt that passes the banned-text compliance lint", () => {
    // The template itself must carry zero banned tokens (the scanner is a blunt word
    // match, so the negative instructions are phrased without the banned words).
    expect(scanBannedText(buildRecreatePrompt(BASE))).toEqual([]);
    expect(scanBannedText(buildRecreatePrompt({ ...BASE, includeFromPrice: true }))).toEqual([]);
  });

  it("lets the lint catch a banned claim injected via owner angle notes", () => {
    // This is the property the route relies on: whatever the owner types flows into
    // the prompt, and the SAME lint that guards landing pages rejects a banned claim.
    const prompt = buildRecreatePrompt({ ...BASE, angleNotes: "we are the best, pain-free dentist" });
    const hits = scanBannedText(prompt);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.category)).toEqual(expect.arrayContaining(["superlative", "pain"]));
  });
});
