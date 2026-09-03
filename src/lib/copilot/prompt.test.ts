import { describe, it, expect } from "vitest";
import { authoritiesBrief } from "@/lib/knowledge/authorities";
import type { ApprovedAuthority } from "@/lib/knowledge/types";
import { COPILOT_ACCESS_LEVELS } from "./clearance";
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

// ===========================================================================
// THE APPROVED-AUTHORITIES SEAM, AS THE PROMPT SEES IT.
//
// The seam's own rules (the size ceiling, the copyright refusal, the bound, the
// data-not-instructions preamble) are tested where they live, in
// src/lib/knowledge/authorities.test.ts. What is tested HERE is the join: that
// the default posture really does add nothing, that a configured list really
// does arrive with a citation rule attached, and that the rule is the same
// sentence for every login rather than four slightly different ones.
// ===========================================================================

const AUTHORITY: ApprovedAuthority = {
  id: "au1",
  clientId: "vitality",
  name: "Standards for the Dental Team",
  kind: "regulator",
  publisher: "General Dental Council",
  reference: "gdc-uk.org",
  summary: "The practice's own note on what the standards require of consent conversations.",
  principles: "Consent is a conversation, recorded, and it can be withdrawn.",
  status: "active",
  createdBy: "owner",
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: "2026-09-01T09:00:00Z",
};

describe("the knowledge base is not patient copy", () => {
  it("tells the owner's co-pilot to write its own words rather than paste internal wording", () => {
    const system = buildCopilotSystemPrompt();
    expect(system).toMatch(/NEVER PASTE THE KNOWLEDGE BASE INTO A PATIENT MESSAGE/);
    expect(system).toMatch(/written for the team, not for patients/i);
    // And it is honest about the enforcement: the floor refuses, it does not warn.
    expect(system).toMatch(/is refused and nothing is sent/i);
  });
});

describe("approved authorities in the system prompt", () => {
  it("THE DEFAULT IS PRACTICE DATA ONLY: an empty list adds not one character", () => {
    // Not a heading, not "no sources configured", not a preamble with nothing
    // under it. A section that announces an empty feature spends tokens and
    // invites the model to mention a list nobody made.
    const base = buildCopilotSystemPrompt({ label: "N15 Vitality Dental", isAllSites: false });
    const withEmpty = buildCopilotSystemPrompt({
      label: "N15 Vitality Dental",
      isAllSites: false,
      authorities: authoritiesBrief([]),
    });
    expect(withEmpty).toBe(base);
    expect(withEmpty).not.toMatch(/APPROVED AUTHORITIES/);
  });

  it("whitespace is the same as nothing, so a blank read cannot open a section", () => {
    const base = buildCopilotSystemPrompt({ label: "X", isAllSites: false });
    expect(buildCopilotSystemPrompt({ label: "X", isAllSites: false, authorities: "   \n  " })).toBe(base);
  });

  it("carries the practice's own words and the citation rule when a list exists", () => {
    const prompt = buildCopilotSystemPrompt({
      label: "N15 Vitality Dental",
      isAllSites: false,
      authorities: authoritiesBrief([AUTHORITY]),
    });
    expect(prompt).toMatch(/Standards for the Dental Team/);
    expect(prompt).toMatch(/General Dental Council/);
    expect(prompt).toMatch(/CITE IT BY NAME/);
    // NO LIVE INTERNET, and the model is told so in the terms that matter: it has
    // the practice's note about the source, never the source.
    expect(prompt).toMatch(/You have no access to the sources themselves/);
    expect(prompt).toMatch(/never invent a page, chapter, clause or guideline number/i);
  });

  it("says an authority never overrules the practice's own records", () => {
    const prompt = buildCopilotSystemPrompt({
      label: "X",
      isAllSites: false,
      authorities: authoritiesBrief([AUTHORITY]),
    });
    expect(prompt).toMatch(/never overrules this practice's own records/i);
  });

  it("says the same thing to every login, not four slightly different things", () => {
    // Four prompts, one citation rule. The alternative is the owner being told to
    // cite and the clinician not, which is the shape of a rule that quietly stops
    // applying.
    for (const access of COPILOT_ACCESS_LEVELS) {
      const prompt = buildCopilotSystemPrompt({
        label: "X",
        isAllSites: false,
        access,
        authorities: authoritiesBrief([AUTHORITY]),
      });
      expect(prompt, `${access} was not given the citation rule`).toMatch(/CITE IT BY NAME/);
      expect(prompt, `${access} was not given the authority`).toMatch(/Standards for the Dental Team/);
    }
  });
});
