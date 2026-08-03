import { describe, it, expect } from "vitest";
import {
  DECISION_SUPPORT_NOTICE,
  PerioDiagnosisError,
  describeDiagnosis,
  recordClinicianDiagnosis,
  stagingInputFromChart,
  suggestDiagnosis,
  suggestGrade,
  suggestStage,
} from "./diagnosis";
import type { GradingInput, StagingInput } from "./diagnosis";
import { SITE_IDS, buildPocketChart } from "./pocket-chart";
import type { PerioSiteId } from "./types";

const CLINICIAN = { id: "u-1", name: "Blerta Hoxha", gdcNumber: "123456" };
const AT = "2026-08-01T09:00:00.000Z";

function staging(over: Partial<StagingInput> = {}): StagingInput {
  return { worstInterproximalCalMm: 2, teethLostToPeriodontitis: 0, ...over };
}

function grading(over: Partial<GradingInput> = {}): GradingInput {
  return { ...over };
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

describe("suggestStage", () => {
  it("stages I, II and III from interdental attachment loss", () => {
    expect(suggestStage(staging({ worstInterproximalCalMm: 2 })).stage).toBe("I");
    expect(suggestStage(staging({ worstInterproximalCalMm: 4 })).stage).toBe("II");
    expect(suggestStage(staging({ worstInterproximalCalMm: 6 })).stage).toBe("III");
  });

  it("stages from radiographic bone loss when that is what was measured", () => {
    expect(suggestStage(staging({ worstInterproximalCalMm: null, boneLossPercent: 10 })).stage).toBe("I");
    expect(suggestStage(staging({ worstInterproximalCalMm: null, boneLossPercent: 25 })).stage).toBe("II");
    expect(suggestStage(staging({ worstInterproximalCalMm: null, boneLossPercent: 50 })).stage).toBe("III");
    expect(suggestStage(staging({ worstInterproximalCalMm: null, boneLossPercent: 80 })).stage).toBe("IV");
  });

  it("says a coronal-third description cannot separate stage I from stage II", () => {
    const s = suggestStage(
      staging({ worstInterproximalCalMm: null, boneLossPercent: null, boneLossExtent: "coronal-third" }),
    );
    expect(s.stage).toBe("I");
    expect(s.missing.join(" ")).toContain("separate stage I from stage II");
  });

  it("takes five or more teeth lost to periodontitis to stage IV, whatever the attachment loss says", () => {
    const s = suggestStage(staging({ worstInterproximalCalMm: 2, teethLostToPeriodontitis: 6 }));
    expect(s.stage).toBe("IV");
    expect(s.drivenBy).toContain("6 teeth lost to periodontitis");
  });

  it("takes one to four teeth lost to periodontitis to at least stage III", () => {
    expect(suggestStage(staging({ worstInterproximalCalMm: 2, teethLostToPeriodontitis: 1 })).stage).toBe("III");
  });

  it("lets complexity raise the stage and never lower it", () => {
    // 2mm of attachment loss is stage I severity. A 7mm pocket is stage III complexity.
    const s = suggestStage(staging({ worstInterproximalCalMm: 2, maxProbingDepthMm: 7 }));
    expect(s.stage).toBe("III");
    expect(s.workings.join(" ")).toContain("never lowers it");

    // And a complexity factor BELOW the severity finding cannot pull it back down.
    const severe = suggestStage(staging({ worstInterproximalCalMm: 8, maxProbingDepthMm: 4 }));
    expect(severe.stage).toBe("III");
  });

  it("treats vertical bone loss, furcation, mobility, tooth count and bite collapse as complexity", () => {
    expect(suggestStage(staging({ verticalBoneLossMm: 4 })).stage).toBe("III");
    expect(suggestStage(staging({ worstFurcation: 2 })).stage).toBe("III");
    expect(suggestStage(staging({ worstFurcation: 1 })).stage).toBe("I");
    expect(suggestStage(staging({ worstMobility: 2 })).stage).toBe("IV");
    expect(suggestStage(staging({ remainingTeeth: 18 })).stage).toBe("IV");
    expect(suggestStage(staging({ remainingTeeth: 28 })).stage).toBe("I");
    expect(suggestStage(staging({ masticatoryDysfunction: true })).stage).toBe("IV");
  });

  // -------------------------------------------------------------------------
  // DENTALLY'S SCALES IN THE DECISION-SUPPORT COPY.
  //
  // These sentences used to convert the number back into a roman numeral with a
  // ternary — `worstFurcation === 3 ? "III" : "II"` — which was correct only
  // while the scale stopped at 3. Under furcation grades 1–4 it renders the
  // WORST finding in the mouth as the milder one, in the sentence that justifies
  // the stage it raised. The tests below are about the WORDS, because the stage
  // was right the whole time and only the sentence was wrong.
  // -------------------------------------------------------------------------

  it("prints a grade 4 furcation as grade 4, not as the milder grade the old ternary produced", () => {
    const s = suggestStage(staging({ worstFurcation: 4 }));
    expect(s.stage).toBe("III");
    const said = s.workings.join(" ");
    expect(said).toContain("A grade 4 furcation");
    // The specific failure: a 4 rendered as a II. Both spellings are checked,
    // because the old code emitted "grade II" and a lazy fix would emit "grade 2".
    expect(said).not.toContain("grade II furcation");
    expect(said).not.toContain("A grade 2 furcation");
  });

  it("prints each furcation grade as itself", () => {
    for (const grade of [2, 3, 4] as const) {
      expect(suggestStage(staging({ worstFurcation: grade })).workings.join(" ")).toContain(
        `A grade ${grade} furcation`,
      );
    }
  });

  it("prints mobility as a stage on Dentally's 1–3 scale, and says which stage it means", () => {
    const s = suggestStage(staging({ worstMobility: 3 }));
    expect(s.stage).toBe("IV");
    const said = s.workings.join(" ");
    expect(said).toContain("Mobility of stage 3");
    expect(said).not.toContain("Miller");
    // The sentence carries two numbering systems — mobility stages 1–3 and
    // periodontitis stages I–IV — so it has to name the second one.
    expect(said).toContain("periodontitis stage IV");
  });

  it("never names a scale that is not on the hygienist's keyboard", () => {
    // `f` cycles grades 1–4 and `m` cycles stages 1–3. A working that says "Hamp"
    // or "Miller" sends a clinician looking for a control that does not exist.
    const said = suggestStage(
      staging({ worstFurcation: 4, worstMobility: 3, worstInterproximalCalMm: 6 }),
    ).workings.join(" ");
    expect(said).not.toMatch(/Hamp|Miller/);
  });

  it("still takes a grade 4 furcation to stage III and a stage 3 mobility to stage IV", () => {
    // The thresholds did NOT move: a Hamp II is a grade 2 and a Miller II is a
    // stage 2, so "2 or worse" still reads the same mouth. Pinned so a future
    // rescale cannot quietly drop grade 4 off the top.
    expect(suggestStage(staging({ worstFurcation: 4 })).stage).toBe("III");
    expect(suggestStage(staging({ worstFurcation: 1 })).stage).toBe("I");
    expect(suggestStage(staging({ worstMobility: 3 })).stage).toBe("IV");
    expect(suggestStage(staging({ worstMobility: 1 })).stage).toBe("I");
  });

  it("refuses to stage a mouth with no severity measurement at all", () => {
    const s = suggestStage({ maxProbingDepthMm: 8 });
    expect(s.stage).toBeNull();
    expect(s.missing).toContain("interdental attachment loss at the site of greatest loss");
    expect(s.workings.join(" ")).toContain("An absent measurement is not a mild result.");
  });

  it("does not stage a mouth with no interdental attachment loss", () => {
    const s = suggestStage(staging({ worstInterproximalCalMm: 0 }));
    expect(s.stage).toBeNull();
    expect(s.workings.join(" ")).toContain("does not meet the case definition of periodontitis");
  });

  it("reports extent separately from stage", () => {
    expect(suggestStage(staging({ percentTeethAffected: 15 })).extent).toBe("localised");
    expect(suggestStage(staging({ percentTeethAffected: 45 })).extent).toBe("generalised");
    expect(suggestStage(staging({ percentTeethAffected: 45, molarIncisorPattern: true })).extent).toBe(
      "molar-incisor",
    );
    expect(suggestStage(staging()).extent).toBeNull();
  });

  it("shows its working, one sentence per criterion", () => {
    const s = suggestStage(staging({ worstInterproximalCalMm: 6, maxProbingDepthMm: 7 }));
    expect(s.workings.some((w) => w.includes("6mm at the worst site"))).toBe(true);
    expect(s.workings.some((w) => w.includes("7mm is a stage III complexity factor"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

describe("suggestGrade", () => {
  it("grades A, B and C from bone loss over age", () => {
    expect(suggestGrade(grading({ boneLossPercent: 10, ageYears: 60 })).grade).toBe("A"); // 0.17
    expect(suggestGrade(grading({ boneLossPercent: 30, ageYears: 60 })).grade).toBe("B"); // 0.5
    expect(suggestGrade(grading({ boneLossPercent: 60, ageYears: 30 })).grade).toBe("C"); // 2.0
  });

  it("falls back to attachment loss over five years", () => {
    expect(suggestGrade(grading({ calChange5yrMm: 0 })).grade).toBe("A");
    expect(suggestGrade(grading({ calChange5yrMm: 1 })).grade).toBe("B");
    expect(suggestGrade(grading({ calChange5yrMm: 3 })).grade).toBe("C");
  });

  it("falls back to the case phenotype", () => {
    expect(suggestGrade(grading({ biofilm: "destruction-below-expected" })).grade).toBe("A");
    expect(suggestGrade(grading({ biofilm: "commensurate" })).grade).toBe("B");
    expect(suggestGrade(grading({ biofilm: "destruction-exceeds-expected" })).grade).toBe("C");
  });

  it("assumes grade B when nothing is known, and says it is an assumption", () => {
    const g = suggestGrade(grading());
    expect(g.grade).toBe("B");
    expect(g.baseAssumed).toBe(true);
    expect(g.workings.join(" ")).toContain("it is not a measurement");
    expect(g.missing.join(" ")).toContain("age");
  });

  it("raises to C for ten or more cigarettes a day", () => {
    const g = suggestGrade(
      grading({ boneLossPercent: 10, ageYears: 60, smoking: { smokes: true, cigarettesPerDay: 20 } }),
    );
    expect(g.baseGrade).toBe("A");
    expect(g.grade).toBe("C");
    expect(g.modifiersApplied).toEqual(["smoking"]);
  });

  it("raises to B for fewer than ten a day", () => {
    const g = suggestGrade(
      grading({ boneLossPercent: 10, ageYears: 60, smoking: { smokes: true, cigarettesPerDay: 5 } }),
    );
    expect(g.grade).toBe("B");
  });

  it("raises to B, not C, when the patient smokes but the amount is unknown", () => {
    const g = suggestGrade(grading({ boneLossPercent: 10, ageYears: 60, smoking: { smokes: true } }));
    expect(g.grade).toBe("B");
    expect(g.missing.join(" ")).toContain("how many cigarettes");
  });

  it("raises to C for an HbA1c of 7% or more, and to B below it", () => {
    expect(
      suggestGrade(
        grading({ boneLossPercent: 10, ageYears: 60, diabetes: { diabetic: true, hba1cPercent: 8.1 } }),
      ).grade,
    ).toBe("C");
    expect(
      suggestGrade(
        grading({ boneLossPercent: 10, ageYears: 60, diabetes: { diabetic: true, hba1cPercent: 6.2 } }),
      ).grade,
    ).toBe("B");
  });

  // THE RULE THAT MUST NOT BEND.
  it("never lowers a grade — a light smoker does not make a grade C case grade B", () => {
    const g = suggestGrade(
      grading({ boneLossPercent: 60, ageYears: 30, smoking: { smokes: true, cigarettesPerDay: 4 } }),
    );
    expect(g.baseGrade).toBe("C");
    expect(g.grade).toBe("C");
    expect(g.modifiersApplied).toEqual([]);
    expect(g.workings.join(" ")).toContain("a modifier never lowers a grade");
  });

  it("never lowers a grade for well-controlled diabetes either", () => {
    const g = suggestGrade(
      grading({ boneLossPercent: 60, ageYears: 30, diabetes: { diabetic: true, hba1cPercent: 6.0 } }),
    );
    expect(g.grade).toBe("C");
  });

  it("applies both modifiers without either one pulling the other down", () => {
    const g = suggestGrade(
      grading({
        boneLossPercent: 10,
        ageYears: 60,
        smoking: { smokes: true, cigarettesPerDay: 20 },
        diabetes: { diabetic: true, hba1cPercent: 6.0 },
      }),
    );
    expect(g.baseGrade).toBe("A");
    expect(g.grade).toBe("C");
    expect(g.modifiersApplied).toEqual(["smoking"]);
    expect(g.modifiers.map((m) => m.modifier)).toEqual(["smoking", "diabetes"]);
  });

  it("treats a non-smoker as the absence of a modifier, not as evidence of slow progression", () => {
    const g = suggestGrade(grading({ smoking: { smokes: false } }));
    expect(g.grade).toBe("B");
    expect(g.workings.join(" ")).toContain("not evidence of slow progression");
    expect(g.missing).not.toContain("smoking status");
  });

  it("records unknown risk factors as missing rather than assuming they are absent", () => {
    const g = suggestGrade(grading({ boneLossPercent: 10, ageYears: 60 }));
    expect(g.missing).toContain("smoking status");
    expect(g.missing).toContain("diabetes status and HbA1c");
  });
});

// ---------------------------------------------------------------------------
// The whole suggestion, and the clinician's own decision
// ---------------------------------------------------------------------------

describe("suggestDiagnosis", () => {
  it("returns a stage, a grade, the extent and every step of the reasoning", () => {
    const d = suggestDiagnosis({
      staging: staging({ worstInterproximalCalMm: 6, percentTeethAffected: 40 }),
      grading: grading({ boneLossPercent: 60, ageYears: 30 }),
    });
    expect(d.stage).toBe("III");
    expect(d.grade).toBe("C");
    expect(d.extent).toBe("generalised");
    expect(d.workings.length).toBeGreaterThan(2);
    expect(d.disclaimer).toBe(DECISION_SUPPORT_NOTICE);
    expect(describeDiagnosis(d)).toBe("Generalised periodontitis, stage III, grade C");
  });

  it("offers no grade at all where there is no stage — an ungraded nothing is not a diagnosis", () => {
    const d = suggestDiagnosis({ staging: {}, grading: grading({ calChange5yrMm: 3 }) });
    expect(d.stage).toBeNull();
    expect(d.grade).toBeNull();
    expect(describeDiagnosis(d)).toBeNull();
    expect(d.missing.length).toBeGreaterThan(0);
  });
});

describe("recordClinicianDiagnosis", () => {
  const suggestion = suggestDiagnosis({
    staging: staging({ worstInterproximalCalMm: 6 }),
    grading: grading({ boneLossPercent: 60, ageYears: 30 }),
  });

  it("records agreement without ceremony and keeps the suggestion beside it", () => {
    const d = recordClinicianDiagnosis(suggestion, {
      stage: "III",
      grade: "C",
      recorded: { clinician: CLINICIAN, at: AT },
    });
    expect(d.agreesWithSuggestion).toBe(true);
    expect(d.rationale).toBeNull();
    expect(d.suggestion.stage).toBe("III");
    expect(d.recorded.clinician.name).toBe("Blerta Hoxha");
  });

  it("lets the clinician override, and keeps what the platform suggested on the record", () => {
    const d = recordClinicianDiagnosis(suggestion, {
      stage: "IV",
      grade: "C",
      recorded: { clinician: CLINICIAN, at: AT },
      rationale: "Bite collapse and drifting of the upper anteriors, not captured in the chart.",
    });
    expect(d.stage).toBe("IV");
    expect(d.agreesWithSuggestion).toBe(false);
    expect(d.suggestion.stage).toBe("III");
    expect(d.rationale).toContain("Bite collapse");
  });

  it("requires a reason for a diagnosis that differs from the suggestion", () => {
    expect(() =>
      recordClinicianDiagnosis(suggestion, {
        stage: "I",
        grade: "A",
        recorded: { clinician: CLINICIAN, at: AT },
      }),
    ).toThrow(PerioDiagnosisError);
  });

  it("requires a named clinician and a date", () => {
    expect(() =>
      recordClinicianDiagnosis(suggestion, {
        stage: "III",
        grade: "C",
        recorded: { clinician: { id: "", name: "", gdcNumber: null }, at: "whenever" },
      }),
    ).toThrow(/4\.1\.4/);
  });
});

// ---------------------------------------------------------------------------
// What the chart can and cannot supply
// ---------------------------------------------------------------------------

describe("stagingInputFromChart", () => {
  function chartWith(sites: Partial<Record<PerioSiteId, { probingDepth: number; recession: number }>>) {
    return buildPocketChart({
      sextants: ["LR"],
      recorded: { clinician: CLINICIAN, at: AT },
      teeth: [
        {
          tooth: 46,
          mobility: 1,
          furcation: 2,
          sites: SITE_IDS.map((id) => ({
            site: id,
            probingDepth: sites[id]?.probingDepth ?? 3,
            recession: sites[id]?.recession ?? 0,
            bleeding: false,
            suppuration: false,
            plaque: false,
          })),
        },
      ],
    });
  }

  it("takes attachment loss from the INTERPROXIMAL sites, not from mid-buccal recession", () => {
    // 8mm of mid-buccal attachment loss is brushing recession, not interdental disease.
    const { input } = stagingInputFromChart(
      chartWith({ b: { probingDepth: 3, recession: 5 }, mb: { probingDepth: 4, recession: 1 } }),
    );
    expect(input.worstInterproximalCalMm).toBe(5);
    expect(input.maxProbingDepthMm).toBe(4);
    expect(input.worstFurcation).toBe(2);
    expect(input.worstMobility).toBe(1);
  });

  it("refuses to guess the two things a pocket chart cannot know", () => {
    const { input, caveats } = stagingInputFromChart(chartWith({}));
    expect(input.boneLossPercent).toBeUndefined();
    expect(input.teethLostToPeriodontitis).toBeUndefined();
    expect(caveats.join(" ")).toContain("read from the radiographs");
    expect(caveats.join(" ")).toContain("cannot tell why a tooth is missing");
  });

  it("says when the figures come from a partial chart", () => {
    expect(stagingInputFromChart(chartWith({})).caveats.join(" ")).toContain("partial chart");
  });

  it("says when no attachment loss could be computed at all", () => {
    const chart = buildPocketChart({
      sextants: ["LR"],
      recorded: { clinician: CLINICIAN, at: AT },
      teeth: [
        {
          tooth: 46,
          mobility: null,
          furcation: null,
          sites: SITE_IDS.map((id) => ({
            site: id,
            probingDepth: 4,
            recession: null,
            bleeding: false,
            suppuration: false,
            plaque: false,
          })),
        },
      ],
    });
    const { input, caveats } = stagingInputFromChart(chart);
    expect(input.worstInterproximalCalMm).toBeNull();
    expect(caveats.join(" ")).toContain("recession was not recorded");
  });

  it("feeds straight into the stager", () => {
    const { input } = stagingInputFromChart(chartWith({ mb: { probingDepth: 8, recession: 2 } }));
    const s = suggestStage(input);
    expect(input.worstInterproximalCalMm).toBe(10);
    expect(s.stage).toBe("III");
    expect(s.missing.join(" ")).toContain("teeth have been lost");
  });
});
