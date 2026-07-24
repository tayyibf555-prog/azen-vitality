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

  it("forbids quoting or naming the knowledge entry titles and the 'based on our playbook' framing", () => {
    const system = buildCopilotSystemPrompt();
    expect(system).toMatch(/never quote, list or name the knowledge entry titles/i);
    expect(system).toMatch(/based on our playbook/i);
    // the old instruction that told it to cite titles must be gone
    expect(system).not.toMatch(/citing the titles/i);
  });

  it("documents create_patient: the tool, the two-step confirm, never guessing, and the existing-match rule", () => {
    const system = buildCopilotSystemPrompt();
    expect(system).toMatch(/create_patient/);
    expect(system).toMatch(/CREATING A PATIENT/i);
    // Two steps, never in the same turn.
    expect(system).toMatch(/call create_patient again with confirm true/i);
    expect(system).toMatch(/Never set confirm true in the same turn/i);
    // Never invent a detail.
    expect(system).toMatch(/NEVER invent or assume any detail/i);
    expect(system).toMatch(/never guess gender/i);
    // A likely existing patient must not be duplicated without an explicit "different person".
    expect(system).toMatch(/do NOT create anyone, unless the owner explicitly says it is a different person/i);
  });
});
