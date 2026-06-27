import { describe, it, expect } from "vitest";
import { sanitiseUspText, uspPromptLine } from "./prompt";

describe("sanitiseUspText", () => {
  it("strips em/en dashes (forbidden in patient-facing copy)", () => {
    expect(sanitiseUspText("Open Saturdays — book anytime")).toBe("Open Saturdays, book anytime");
    expect(sanitiseUspText("Finance – 0% available")).toBe("Finance, 0% available");
    expect(sanitiseUspText("0% finance available")).not.toContain("—");
  });
  it("collapses whitespace and trims", () => {
    expect(sanitiseUspText("  Free   on-site   parking  ")).toBe("Free on-site parking");
  });
  it("caps length", () => {
    expect((sanitiseUspText("x".repeat(300)) ?? "").length).toBeLessThanOrEqual(140);
  });
  it("returns null for empty / punctuation-only input", () => {
    expect(sanitiseUspText("")).toBeNull();
    expect(sanitiseUspText("   ")).toBeNull();
    expect(sanitiseUspText("—")).toBeNull();
    expect(sanitiseUspText(null)).toBeNull();
  });
  it("never leaves a doubled space from a dash/comma boundary", () => {
    expect(sanitiseUspText("Finance, — flexible plans")).toBe("Finance, flexible plans");
    expect(sanitiseUspText("Saturday clinics — — and late nights")).not.toMatch(/ {2,}/);
    expect(sanitiseUspText("Multiple,,, commas")).not.toMatch(/ {2,}/);
  });
  it("never ends in a dangling comma even when the length cap truncates after one", () => {
    const out = sanitiseUspText("y".repeat(139) + " — z");
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(140);
    expect(out!.endsWith(",")).toBe(false);
  });
});

describe("uspPromptLine", () => {
  it("returns null when there are no USPs (prompt unchanged)", () => {
    expect(uspPromptLine([])).toBeNull();
    expect(uspPromptLine(null)).toBeNull();
    expect(uspPromptLine(["", "   "])).toBeNull();
  });
  it("joins USPs into one guarded line with no em-dash", () => {
    const line = uspPromptLine(["0% finance available", "Free parking", "Saturday appointments"]);
    expect(line).not.toBeNull();
    expect(line).toContain("0% finance available");
    expect(line).toContain("Free parking");
    expect(line).toContain("; "); // joined
    expect(line).not.toContain("—");
  });
  it("carries the no-overpromise / no-clinical-guarantee guardrail", () => {
    const line = uspPromptLine(["Award-winning implant team"])!;
    expect(line.toLowerCase()).toContain("never");
    expect(line.toLowerCase()).toContain("clinical guarantee");
    expect(line.toLowerCase()).toContain("over-promise");
  });
  it("sanitises each USP defensively even if a raw one slipped through", () => {
    const line = uspPromptLine(["Open late — every weekday"])!;
    expect(line).not.toContain("—");
    expect(line).toContain("Open late, every weekday");
  });
});
