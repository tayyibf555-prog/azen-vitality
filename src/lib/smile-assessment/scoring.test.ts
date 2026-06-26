import { describe, it, expect } from "vitest";
import { scoreAssessment, bandFor, MAX_RAW_TOTAL, BAND_HIGH, BAND_MEDIUM } from "./scoring";
import {
  Q_TREATMENT,
  Q_TIMELINE,
  Q_BUDGET,
  Q_LOCATION,
} from "./quiz";

describe("MAX_RAW_TOTAL", () => {
  it("is the sum of each question's best option (intent/fit only)", () => {
    // treatment 20 + timeline 30 + budget 30 + location 10 = 90
    expect(MAX_RAW_TOTAL).toBe(90);
  });
});

describe("scoreAssessment", () => {
  it("scores a fully high-intent submission as high (max = 100)", () => {
    const { rawScore, band } = scoreAssessment({
      [Q_TREATMENT]: "invisalign", // 20
      [Q_TIMELINE]: "asap", // 30
      [Q_BUDGET]: "ready", // 30
      [Q_LOCATION]: "site-cc", // 10
    });
    expect(rawScore).toBe(100);
    expect(band).toBe("high");
  });

  it("scores a fully low-intent submission as low", () => {
    const { rawScore, band } = scoreAssessment({
      [Q_TREATMENT]: "other", // 6
      [Q_TIMELINE]: "researching", // 2
      [Q_BUDGET]: "unsure", // 4
      [Q_LOCATION]: "any", // 8
    });
    // 20 / 90 = 22
    expect(rawScore).toBe(22);
    expect(band).toBe("low");
  });

  it("scores a moderate submission as medium", () => {
    const { rawScore, band } = scoreAssessment({
      [Q_TREATMENT]: "hygiene", // 8
      [Q_TIMELINE]: "3_6_months", // 12
      [Q_BUDGET]: "covered", // 8
      [Q_LOCATION]: "site-cc", // 10
    });
    // 38 / 90 = 42
    expect(rawScore).toBe(42);
    expect(band).toBe("medium");
  });

  it("handles a partial submission (missing answers score lower, never throws)", () => {
    const { rawScore, band } = scoreAssessment({
      [Q_TIMELINE]: "asap", // 30, everything else missing
    });
    // 30 / 90 = 33
    expect(rawScore).toBe(33);
    expect(band).toBe("low");
  });

  it("ignores unknown question ids and unknown option values", () => {
    const { rawScore } = scoreAssessment({
      not_a_question: "asap",
      [Q_TIMELINE]: "not_an_option",
      [Q_BUDGET]: "ready", // 30 — the only valid contribution
    });
    // 30 / 90 = 33
    expect(rawScore).toBe(33);
  });

  it("scores an empty submission as 0 / low", () => {
    const { rawScore, band } = scoreAssessment({});
    expect(rawScore).toBe(0);
    expect(band).toBe("low");
  });

  it("treats a clear timeline + funding readiness without a strong treatment as high", () => {
    const { band } = scoreAssessment({
      [Q_TREATMENT]: "whitening", // 12
      [Q_TIMELINE]: "asap", // 30
      [Q_BUDGET]: "finance", // 24
      [Q_LOCATION]: "any", // 8
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
