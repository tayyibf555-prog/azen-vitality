import { describe, it, expect } from "vitest";
import { buildCopilotSystemPrompt } from "./prompt";

describe("buildCopilotSystemPrompt", () => {
  it("treats the knowledge base as the practice's own expertise and forbids attributing advice to external sources", () => {
    const system = buildCopilotSystemPrompt();
    expect(system).toMatch(/the practice's own operational expertise/i);
    expect(system).toMatch(/never attribute advice to named consultants, programmes, courses or external sources/i);
  });

  it("keeps the line regardless of site scope", () => {
    const scoped = buildCopilotSystemPrompt({ label: "N15 Vitality Dental", isAllSites: false });
    expect(scoped).toMatch(/never attribute advice to named consultants, programmes, courses or external sources/i);
  });
});
