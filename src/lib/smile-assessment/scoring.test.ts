import { describe, it, expect } from "vitest";
import { scoreAssessment, bandFor, MAX_RAW_TOTAL, BAND_HIGH, BAND_MEDIUM } from "./scoring";
import {
  Q_TREATMENT,
  Q_TIMELINE,
  Q_BUDGET,
  Q_LOCATION,
  QUIZ_QUESTIONS,
} from "./quiz";

describe("MAX_RAW_TOTAL", () => {
  it("is the best-option sum across the whole bank (reference, not the denominator)", () => {
    const expected = QUIZ_QUESTIONS.reduce(
      (s, q) => s + Math.max(...q.options.map((o) => o.weight)),
      0,
    );
    expect(MAX_RAW_TOTAL).toBe(expected);
  });
});

describe("scoreAssessment", () => {
  it("scores a fully high-intent submission as high (max = 100)", () => {
    const { rawScore, band } = scoreAssessment({
      [Q_TREATMENT]: "invisalign", // 20
      [Q_TIMELINE]: "asap", // 30
      [Q_BUDGET]: "ready", // 30
      [Q_LOCATION]: "england", // 8
    });
    expect(rawScore).toBe(100);
    expect(band).toBe("high");
  });

  it("scores a fully low-intent submission as low", () => {
    const { rawScore, band } = scoreAssessment({
      [Q_TREATMENT]: "other", // 6
      [Q_TIMELINE]: "researching", // 2
      [Q_BUDGET]: "unsure", // 4
      [Q_LOCATION]: "elsewhere", // 8
    });
    // 20 / 88 = 23 (location max is 8 now regions weigh equal)
    expect(rawScore).toBe(23);
    expect(band).toBe("low");
  });

  it("scores a moderate submission as medium", () => {
    const { rawScore, band } = scoreAssessment({
      [Q_TREATMENT]: "hygiene", // 8
      [Q_TIMELINE]: "3_6_months", // 12
      [Q_BUDGET]: "covered", // 8
      [Q_LOCATION]: "england", // 8
    });
    // 36 / 88 = 41
    expect(rawScore).toBe(41);
    expect(band).toBe("medium");
  });

  it("scores on the questions actually answered (adaptive path), never throws", () => {
    // Two questions answered: a top timeline + a weak budget.
    const { rawScore } = scoreAssessment({
      [Q_TIMELINE]: "asap", // 30 / 30
      [Q_BUDGET]: "unsure", // 4 / 30
    });
    // (30 + 4) / (30 + 30) = 57
    expect(rawScore).toBe(57);
    // A single top answer is 100% of that dimension.
    expect(scoreAssessment({ [Q_TIMELINE]: "asap" }).rawScore).toBe(100);
  });

  it("ignores unknown question ids and unknown option values", () => {
    const { rawScore } = scoreAssessment({
      not_a_question: "asap",
      [Q_TIMELINE]: "not_an_option",
      [Q_BUDGET]: "ready", // 30 / 30 — the only valid contribution
    });
    expect(rawScore).toBe(100); // scored only on the one valid answer
  });

  it("scores an empty submission as 0 / low", () => {
    const { rawScore, band } = scoreAssessment({});
    expect(rawScore).toBe(0);
    expect(band).toBe("low");
  });

  it("caps an under-covered submission at medium so a single crafted answer can't score 'high' (finding #22)", () => {
    // One favourable answer normalises to 100, but without the core trio (treatment,
    // timeline, budget) it must not reach "high" and trigger the auto-SMS bridge.
    const one = scoreAssessment({ [Q_TIMELINE]: "asap" });
    expect(one.rawScore).toBe(100);
    expect(one.band).toBe("medium"); // capped: core trio incomplete

    // Two of the three core questions is still incomplete.
    const two = scoreAssessment({ [Q_TIMELINE]: "asap", [Q_BUDGET]: "ready" });
    expect(two.band).not.toBe("high");

    // The full core trio unlocks "high" as before.
    const full = scoreAssessment({
      [Q_TREATMENT]: "invisalign",
      [Q_TIMELINE]: "asap",
      [Q_BUDGET]: "ready",
    });
    expect(full.band).toBe("high");
  });

  it("treats a clear timeline + funding readiness without a strong treatment as high", () => {
    const { band } = scoreAssessment({
      [Q_TREATMENT]: "whitening", // 12
      [Q_TIMELINE]: "asap", // 30
      [Q_BUDGET]: "finance", // 24
      [Q_LOCATION]: "elsewhere", // 8
    });
    // 74 / 90 = 82
    expect(band).toBe("high");
  });
});

describe("bandFor boundaries", () => {
  it("bands at and around the high threshold", () => {
    expect(bandFor(BAND_HIGH)).toBe("high"); // 70
    expect(bandFor(BAND_HIGH - 1)).toBe("medium"); // 69
  });

  it("bands at and around the medium threshold", () => {
    expect(bandFor(BAND_MEDIUM)).toBe("medium"); // 40
    expect(bandFor(BAND_MEDIUM - 1)).toBe("low"); // 39
  });

  it("bands the extremes", () => {
    expect(bandFor(0)).toBe("low");
    expect(bandFor(100)).toBe("high");
  });
});
