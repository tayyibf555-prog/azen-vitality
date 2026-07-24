import { describe, it, expect } from "vitest";
import { candidateQuestions, shouldFinish, deterministicNext, answeredCount, MAX_QUESTIONS } from "./funnel";
import { Q_TREATMENT, Q_TIMELINE, Q_BUDGET, Q_LOCATION, questionById } from "./quiz";

/**
 * Run the deterministic fallback to exhaustion, answering each question with its
 * first option, and return the ids it asked in order. The bounded loop is a
 * safety net: if the funnel ever failed to terminate, the assertion on length
 * should fail rather than the test hanging.
 */
function walkDeterministically(start: Record<string, string>): {
  asked: string[];
  answers: Record<string, string>;
} {
  const answers = { ...start };
  const asked: string[] = [];
  for (let i = 0; i < 20; i++) {
    const next = deterministicNext(answers);
    if (next === null) break;
    asked.push(next);
    const q = questionById(next);
    if (!q) break;
    answers[next] = q.options[0]!.value;
  }
  return { asked, answers };
}

describe("candidateQuestions", () => {
  it("excludes answered questions", () => {
    const cands = candidateQuestions({ [Q_TREATMENT]: "implants" });
    expect(cands.some((q) => q.id === Q_TREATMENT)).toBe(false);
  });
  it("only includes a treatment-specific question for that treatment", () => {
    const forImplants = candidateQuestions({ [Q_TREATMENT]: "implants" }).map((q) => q.id);
    expect(forImplants).toContain("implant_scope");
    expect(forImplants).not.toContain("align_detail");
    expect(forImplants).not.toContain("smile_concern");
    expect(forImplants).not.toContain("cosmetic_goal");

    const forInvisalign = candidateQuestions({ [Q_TREATMENT]: "invisalign" }).map((q) => q.id);
    expect(forInvisalign).toContain("align_detail");
    expect(forInvisalign).toContain("smile_concern");
    expect(forInvisalign).not.toContain("implant_scope");
  });
  it("offers no scope question for a low-intent treatment but keeps the agnostic ones", () => {
    const ids = candidateQuestions({ [Q_TREATMENT]: "hygiene" }).map((q) => q.id);
    expect(ids).not.toContain("implant_scope");
    expect(ids).not.toContain("align_detail");
    expect(ids).not.toContain("smile_concern");
    expect(ids).toContain(Q_TIMELINE);
    expect(ids).toContain("readiness");
  });
  it("puts the picture scope question ahead of the severity one on the aligners path", () => {
    // Both are dimension "scope", so DIMENSION_PRIORITY ties and the stable sort
    // falls back to bank order. smile_concern is listed first in quiz.ts on
    // purpose, so it is the preferred scope ask when the AI takes the top
    // candidate. Nothing forces the AI's hand — this only fixes the tie-break.
    const ids = candidateQuestions({ [Q_TREATMENT]: "invisalign" }).map((q) => q.id);
    expect(ids.indexOf("smile_concern")).toBeLessThan(ids.indexOf("align_detail"));
    // Still ranked below the core/qualifying dimensions, and above location.
    expect(ids.indexOf(Q_TIMELINE)).toBeLessThan(ids.indexOf("smile_concern"));
    expect(ids.indexOf("smile_concern")).toBeLessThan(ids.indexOf(Q_LOCATION));
  });
  it("drops each scope question as it is answered, without unlocking the other", () => {
    const afterPicture = candidateQuestions({
      [Q_TREATMENT]: "invisalign",
      smile_concern: "crowded",
    }).map((q) => q.id);
    expect(afterPicture).not.toContain("smile_concern");
    expect(afterPicture).toContain("align_detail");
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
  it("keeps going without the region answer, even with core triad + depth", () => {
    expect(
      shouldFinish({ [Q_TREATMENT]: "implants", [Q_TIMELINE]: "asap", [Q_BUDGET]: "ready", readiness: "book_now" }),
    ).toBe(false);
  });
  it("is true once the core triad, a depth answer and the region are gathered", () => {
    expect(
      shouldFinish({
        [Q_TREATMENT]: "implants",
        [Q_TIMELINE]: "asap",
        [Q_BUDGET]: "ready",
        readiness: "book_now",
        [Q_LOCATION]: "england",
      }),
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
  it("asks the region question once only it blocks finishing", () => {
    expect(
      deterministicNext({ [Q_TREATMENT]: "implants", [Q_TIMELINE]: "asap", [Q_BUDGET]: "ready", readiness: "book_now" }),
    ).toBe(Q_LOCATION);
  });
  it("returns null when the funnel should finish", () => {
    expect(
      deterministicNext({
        [Q_TREATMENT]: "implants",
        [Q_TIMELINE]: "asap",
        [Q_BUDGET]: "ready",
        readiness: "book_now",
        [Q_LOCATION]: "england",
      }),
    ).toBeNull();
  });
});

// The aligners path now has TWO scope questions in its pool (the picture question
// and the severity one). These pin down that the extra candidate cannot lengthen a
// run past the cap or leave the region unasked.
describe("the aligners path with two scope questions in the pool", () => {
  it("terminates within the hard cap, covering the core triad and the region", () => {
    const { asked, answers } = walkDeterministically({ [Q_TREATMENT]: "invisalign" });
    expect(deterministicNext(answers)).toBeNull();
    expect(shouldFinish(answers)).toBe(true);
    expect(answeredCount(answers)).toBeLessThanOrEqual(MAX_QUESTIONS);
    for (const id of [Q_TIMELINE, Q_BUDGET, Q_LOCATION]) expect(answers[id]).toBeTruthy();
    // Never asks the same question twice.
    expect(new Set(asked).size).toBe(asked.length);
  });

  it("never asks both scope questions in one deterministic run", () => {
    const { asked } = walkDeterministically({ [Q_TREATMENT]: "invisalign" });
    const scopeAsks = asked.filter((id) => id === "smile_concern" || id === "align_detail");
    expect(scopeAsks.length).toBeLessThanOrEqual(1);
  });

  it("still terminates when the picture question is the depth answer", () => {
    const { answers } = walkDeterministically({
      [Q_TREATMENT]: "invisalign",
      smile_concern: "crossbite",
    });
    expect(shouldFinish(answers)).toBe(true);
    expect(answeredCount(answers)).toBeLessThanOrEqual(MAX_QUESTIONS);
    expect(answers[Q_LOCATION]).toBeTruthy();
  });

  it("counts the picture question as the depth answer shouldFinish requires", () => {
    expect(
      shouldFinish({
        [Q_TREATMENT]: "invisalign",
        [Q_TIMELINE]: "asap",
        [Q_BUDGET]: "ready",
        smile_concern: "crowded",
        [Q_LOCATION]: "england",
      }),
    ).toBe(true);
  });

  it("stops at the hard cap even if both scope questions get answered", () => {
    const answers: Record<string, string> = {
      [Q_TREATMENT]: "invisalign",
      [Q_TIMELINE]: "asap",
      [Q_BUDGET]: "ready",
      smile_concern: "crowded",
      align_detail: "noticeable",
      motivation: "event",
    };
    expect(answeredCount(answers)).toBe(MAX_QUESTIONS);
    expect(shouldFinish(answers)).toBe(true);
    expect(deterministicNext(answers)).toBeNull();
  });
});
