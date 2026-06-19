import { describe, it, expect } from "vitest";
import { buildClassifyPrompt, stripEmDash, parseClassification, failClosed } from "./classify";

describe("stripEmDash", () => {
  it("replaces em and en dashes with commas", () => {
    expect(stripEmDash("book in — then confirm – politely")).not.toMatch(/[—–]/);
    expect(stripEmDash("a — b")).toBe("a, b");
  });
});

describe("buildClassifyPrompt", () => {
  it("lists the branches and embeds the raw note", () => {
    const { system, user } = buildClassifyPrompt("Reset the autoclave nightly", ["Reception", "Operations"]);
    expect(system).toMatch(/JSON/);
    expect(system).toMatch(/no em-dash/i);
    expect(user).toMatch(/Reception/);
    expect(user).toMatch(/Reset the autoclave nightly/);
  });
});

describe("parseClassification", () => {
  it("parses a confident result", () => {
    const json = JSON.stringify({
      branch: "Operations", branchIsNew: false, title: "Autoclave nightly reset",
      body: "Reset the autoclave each night.", tier: 1, tags: ["autoclave", "sop"],
      confidence: 0.9, reasoning: "Routine SOP.",
    });
    const r = parseClassification(json);
    expect(r.branch).toBe("Operations");
    expect(r.tier).toBe(1);
    expect(r.needsReview).toBe(false);
    expect(r.tags).toEqual(["autoclave", "sop"]);
  });

  it("fails closed to tier 4 + needs review when confidence is low", () => {
    const json = JSON.stringify({
      branch: "Back office", branchIsNew: false, title: "Maybe finances",
      body: "Unclear note.", tier: 2, tags: [], confidence: 0.2, reasoning: "Unsure.",
    });
    const r = parseClassification(json);
    expect(r.tier).toBe(4);
    expect(r.needsReview).toBe(true);
  });

  it("strips em-dashes from title and body", () => {
    const json = JSON.stringify({
      branch: "Reception", branchIsNew: false, title: "Call back — same day",
      body: "Ring the patient — within the hour.", tier: 1, tags: ["calls"],
      confidence: 0.8, reasoning: "ok",
    });
    const r = parseClassification(json);
    expect(r.title).not.toMatch(/[—–]/);
    expect(r.body).not.toMatch(/[—–]/);
  });

  it("fails closed on malformed JSON", () => {
    const r = parseClassification("not json at all");
    expect(r.needsReview).toBe(true);
    expect(r.tier).toBe(4);
    expect(r.confidence).toBe(0);
  });

  it("clamps an out-of-range tier", () => {
    const json = JSON.stringify({ branch: "Sales", title: "x", body: "y", tier: 9, confidence: 0.9, tags: [] });
    const r = parseClassification(json);
    expect([1, 2, 3, 4]).toContain(r.tier);
  });
});

describe("failClosed", () => {
  it("produces a tier 4 needs-review result from raw text", () => {
    const r = failClosed("some long captured note about the kettle");
    expect(r.tier).toBe(4);
    expect(r.needsReview).toBe(true);
    expect(r.body).toContain("kettle");
    expect(r.title.length).toBeGreaterThan(0);
  });
});
