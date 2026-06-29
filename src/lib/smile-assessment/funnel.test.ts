import { describe, it, expect } from "vitest";
import { candidateQuestions, shouldFinish, deterministicNext, answeredCount, MAX_QUESTIONS } from "./funnel";
import { Q_TREATMENT, Q_TIMELINE, Q_BUDGET } from "./quiz";

describe("candidateQuestions", () => {
  it("excludes answered questions", () => {
    const cands = candidateQuestions({ [Q_TREATMENT]: "implants" });
    expect(cands.some((q) => q.id === Q_TREATMENT)).toBe(false);
  });
  it("only includes a treatment-specific question for that treatment", () => {
    const forImplants = candidateQuestions({ [Q_TREATMENT]: "implants" }).map((q) => q.id);
    expect(forImplants).toContain("implant_scope");
    expect(forImplants).not.toContain("align_detail");
    expect(forImplants).not.toContain("cosmetic_goal");

    const forInvisalign = candidateQuestions({ [Q_TREATMENT]: "invisalign" }).map((q) => q.id);
    expect(forInvisalign).toContain("align_detail");
    expect(forInvisalign).not.toContain("implant_scope");
  });
  it("offers no scope question for a low-intent treatment but keeps the agnostic ones", () => {
    const ids = candidateQuestions({ [Q_TREATMENT]: "hygiene" }).map((q) => q.id);
    expect(ids).not.toContain("implant_scope");
    expect(ids).not.toContain("align_detail");
    expect(ids).toContain(Q_TIMELINE);
    expect(ids).toContain("readiness");
  });
  it("orders core/qualifying dimensions ahead of location", () => {
    const ids = candidateQuestions({ [Q_TREATMENT]: "implants" }).map((q) => q.id);
    expect(ids.indexOf(Q_TIMELINE)).toBeLessThan(ids.indexOf("location"));
  });
});

describe("shouldFinish", () => {
  it("is false right after the first answer", () => {
    expect(shouldFinish({ [Q_TREATMENT]: "implants" })).toBe(false);
  });
  it("is true once the core triad plus a depth answer are gathered", () => {
    expect(
      shouldFinish({ [Q_TREATMENT]: "implants", [Q_TIMELINE]: "asap", [Q_BUDGET]: "ready", readiness: "book_now" }),
    ).toBe(true);
  });
  it("keeps going if the core triad is done but no depth answer yet", () => {
    expect(shouldFinish({ [Q_TREATMENT]: "implants", [Q_TIMELINE]: "asap", [Q_BUDGET]: "ready" })).toBe(false);
  });
  it("stops at the hard cap even without the triad", () => {
    const answers: Record<string, string> = {
      [Q_TREATMENT]: "implants",
      readiness: "book_now",
      motivation: "event",
      experience: "comparing",
      implant_scope: "few",
      location: "site-cc",
    };
    expect(answeredCount(answers)).toBe(MAX_QUESTIONS);
    expect(shouldFinish(answers)).toBe(true);
  });
});

describe("deterministicNext", () => {
  it("returns an unanswered core question first (timeline/funding always covered)", () => {
    const next = deterministicNext({ [Q_TREATMENT]: "implants" });
    expect([Q_TIMELINE, Q_BUDGET]).toContain(next);
  });
  it("returns null when the funnel should finish", () => {
    expect(
      deterministicNext({ [Q_TREATMENT]: "implants", [Q_TIMELINE]: "asap", [Q_BUDGET]: "ready", readiness: "book_now" }),
    ).toBeNull();
  });
});
