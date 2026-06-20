import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./prompt";

const ctx = { patientId: "pat-010", siteId: "site-cc", patientName: "Harold Pemberton", treatment: "Invisalign", fundingType: "private" as const };

describe("buildSystemPrompt", () => {
  it("includes the patient context and core guardrails, with no em-dash", () => {
    const s = buildSystemPrompt(ctx);
    expect(s).toContain("Harold Pemberton");
    expect(s).toContain("Invisalign");
    expect(s.toLowerCase()).toContain("no em-dash");
    expect(s.toLowerCase()).toContain("clinical");
    expect(s.toLowerCase()).toContain("find_slots");
    expect(s.toLowerCase()).toContain("confirm");
    expect(s).not.toContain("—");
    expect(s).toContain("£");
  });
});
