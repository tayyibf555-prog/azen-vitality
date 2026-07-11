import { describe, it, expect } from "vitest";
import { answerLines } from "./summary";
import { Q_TREATMENT, Q_TIMELINE, Q_BUDGET, Q_LOCATION } from "./quiz";

describe("answerLines", () => {
  it("maps answers to question => label lines in bank order", () => {
    const lines = answerLines({
      [Q_LOCATION]: "england",
      [Q_TIMELINE]: "asap",
      readiness: "book_now",
    });
    expect(lines).toEqual([
      "How soon would you like to get started? => As soon as possible",
      "When you find the right fit, how ready are you to book? => Ready to book a consultation now",
      "Where are you based? => England",
    ]);
  });

  it("skips the treatment question (passed separately) and the funding question (never prompt material)", () => {
    const lines = answerLines({
      [Q_TREATMENT]: "implants",
      [Q_BUDGET]: "covered",
      [Q_TIMELINE]: "asap",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("How soon");
  });

  it("skips unknown questions and unknown option values rather than guessing", () => {
    const lines = answerLines({ bogus_question: "x", [Q_TIMELINE]: "not_an_option" });
    expect(lines).toEqual([]);
  });

  it("is empty for a missing map", () => {
    expect(answerLines(null)).toEqual([]);
    expect(answerLines(undefined)).toEqual([]);
  });
});
