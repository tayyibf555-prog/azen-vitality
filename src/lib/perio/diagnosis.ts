// ===========================================================================
// STAGING AND GRADING — 2017/18 classification, as DECISION SUPPORT.
//
// PURE. No I/O, no React, no clock.
//
// THIS MODULE NEVER DIAGNOSES ANYBODY. It reads the measurements the clinician
// entered, says which stage and grade those measurements point at, and shows
// every step of the reasoning so the clinician can disagree with a specific
// step rather than with a verdict. `recordClinicianDiagnosis` is how the
// disagreement is written down, and the suggestion is kept beside it rather
// than replaced — what the platform proposed and what the clinician decided are
// two different facts and the record needs both.
//
// THE THREE RULES THAT ARE NOT NEGOTIABLE:
//
//   1. STAGE IS THE HIGHEST STAGE ANY SINGLE CRITERION SUPPORTS. Complexity
//      factors — a 7mm pocket, a grade 2 furcation, fewer than 20 remaining
//      teeth — raise the stage and can never lower it. Averaging criteria, or
//      letting a mild CAL pull a complex case back down, understates a mouth
//      that needs referral.
//
//   2. GRADE MODIFIERS ONLY EVER RAISE. Smoking and diabetes shift a grade up.
//      A grade C case with a ten-a-day habit is still grade C; a non-smoker is
//      not evidence of slow progression, merely the absence of a modifier. A
//      modifier that lowered a grade would let a risk factor make a case look
//      safer, which is the exact inversion of what it means.
//
//   3. NO EVIDENCE IS NOT A MILD RESULT. Where the measurements needed to stage
//      a case are absent, `stage` is null and `missing` says what is needed.
//      A stage I returned because nothing was measured is a clean-looking
//      result on an unexamined mouth, which is the failure CHARTING.md §6.3
//      calls false completeness.
//
// The one convention that is deliberately generous: in the absence of direct or
// indirect evidence of progression, the framework itself says to ASSUME grade
// B. That is stated as an assumption in the workings, never presented as a
// finding, and `baseAssumed` carries it in the data too.
// ===========================================================================

import { INTERPROXIMAL_SITES, SITE_LABEL } from "./pocket-chart";
import type { PocketChartView } from "./pocket-chart";
// FURCATION GRADES 1–4 AND MOBILITY STAGES 1–3, which is what Dentally records
// and therefore what this module reasons over. It used to import HampFurcation
// (I–III) and MillerMobility (0–III) from the clinical literature. The numbers
// that survived the rescale kept their meaning — a Hamp II is a grade 2, a
// Miller II is a stage 2 — so the stage thresholds below are unchanged. What
// changed is that a grade 4 furcation now exists and a mobility of 0 does not,
// and the sentences this file prints have to be able to say "grade 4" out loud.
import type {
  FurcationGrade,
  GradeModifier,
  MobilityStage,
  PerioAttribution,
  PerioDiagnosisSuggestion,
  PerioGrade,
  PerioStage,
} from "./types";

export const DECISION_SUPPORT_NOTICE =
  "This is decision support, not a diagnosis: it restates the measurements that were entered and the classification they point at. The diagnosis is the treating clinician's, and so is the responsibility for it.";

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export type PerioExtent = "localised" | "generalised" | "molar-incisor";

export type BoneLossExtent = "coronal-third" | "mid-third" | "apical-third";

export interface StagingInput {
  /** Interdental clinical attachment loss at the site of GREATEST loss, in mm.
   *  Interdental, not buccal: recession from toothbrushing is attachment loss
   *  that is not periodontitis, and staging on it over-stages the case. */
  worstInterproximalCalMm?: number | null;
  /** Radiographic bone loss at the worst site, as a percentage of root length. */
  boneLossPercent?: number | null;
  /** Where the bone loss reaches, when no percentage was measured. */
  boneLossExtent?: BoneLossExtent | null;
  /** Teeth lost BECAUSE OF PERIODONTITIS. Not teeth lost to caries, trauma or
   *  orthodontics — counting those stages a healthy mouth as severe. */
  teethLostToPeriodontitis?: number | null;
  maxProbingDepthMm?: number | null;
  verticalBoneLossMm?: number | null;
  worstFurcation?: FurcationGrade | null;
  worstMobility?: MobilityStage | null;
  /** Remaining teeth in the mouth. Fewer than 20 (ten opposing pairs) is a
   *  stage IV complexity factor. */
  remainingTeeth?: number | null;
  /** Bite collapse, drifting, flaring, severe ridge defect, masticatory
   *  dysfunction. Any of them is stage IV. */
  masticatoryDysfunction?: boolean;
  /** Percentage of teeth showing attachment loss. Drives EXTENT, never stage. */
  percentTeethAffected?: number | null;
  molarIncisorPattern?: boolean;
}

export interface StagingSuggestion {
  stage: PerioStage | null;
  extent: PerioExtent | null;
  /** Whole sentences, in the order they were reasoned. */
  workings: string[];
  /** What would be needed to say more. Empty when nothing is missing. */
  missing: string[];
  /** The single criterion that produced the stage, named so a clinician can
   *  argue with it directly. */
  drivenBy: string | null;
}

const STAGE_ORDER: PerioStage[] = ["I", "II", "III", "IV"];

function higherStage(a: PerioStage, b: PerioStage): PerioStage {
  return STAGE_ORDER.indexOf(a) >= STAGE_ORDER.indexOf(b) ? a : b;
}

interface StageCandidate {
  stage: PerioStage;
  because: string;
  severity: boolean;
}

function has(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Stage I–IV from severity and complexity.
 *
 * Severity — attachment loss, bone loss, teeth lost to periodontitis — is what
 * makes a stage possible at all. Complexity can only move it upward.
 */
export function suggestStage(input: StagingInput): StagingSuggestion {
  const workings: string[] = [];
  const missing: string[] = [];
  const candidates: StageCandidate[] = [];

  const cal = input.worstInterproximalCalMm;
  if (has(cal)) {
    if (cal < 1) {
      workings.push(
        "The worst interdental attachment loss recorded is under 1mm, which does not meet the case definition of periodontitis. Nothing here is staged.",
      );
      return { stage: null, extent: null, workings, missing, drivenBy: null };
    }
    const stage: PerioStage = cal >= 5 ? "III" : cal >= 3 ? "II" : "I";
    candidates.push({
      stage,
      severity: true,
      because: `Interdental attachment loss of ${cal}mm at the worst site is stage ${stage} severity (1–2mm stage I, 3–4mm stage II, 5mm or more stage III).`,
    });
  } else {
    missing.push("interdental attachment loss at the site of greatest loss");
  }

  const bone = input.boneLossPercent;
  if (has(bone)) {
    const stage: PerioStage = bone > 66 ? "IV" : bone > 33 ? "III" : bone >= 15 ? "II" : "I";
    candidates.push({
      stage,
      severity: true,
      because: `Radiographic bone loss of ${bone}% of root length at the worst site is stage ${stage} severity (under 15% stage I, 15–33% stage II, the middle third stage III, the apical third stage IV).`,
    });
  } else if (input.boneLossExtent) {
    if (input.boneLossExtent === "coronal-third") {
      candidates.push({
        stage: "I",
        severity: true,
        because:
          "Bone loss confined to the coronal third is stage I or stage II; the two are told apart at 15% of root length, so a percentage is needed to say which.",
      });
      missing.push("radiographic bone loss as a percentage of root length, to separate stage I from stage II");
    } else if (input.boneLossExtent === "mid-third") {
      candidates.push({
        stage: "III",
        severity: true,
        because: "Bone loss extending into the middle third of the root is stage III severity.",
      });
    } else {
      candidates.push({
        stage: "IV",
        severity: true,
        because: "Bone loss extending into the apical third of the root is stage IV severity.",
      });
    }
  } else {
    missing.push("radiographic bone loss at the worst site");
  }

  const lost = input.teethLostToPeriodontitis;
  if (has(lost)) {
    if (lost >= 5) {
      candidates.push({
        stage: "IV",
        severity: true,
        because: `${lost} teeth lost to periodontitis is stage IV severity (five or more).`,
      });
    } else if (lost >= 1) {
      candidates.push({
        stage: "III",
        severity: true,
        because: `${lost} ${lost === 1 ? "tooth" : "teeth"} lost to periodontitis is stage III severity (one to four).`,
      });
    } else {
      workings.push("No teeth have been lost to periodontitis, which is consistent with stage I or II.");
    }
  } else {
    missing.push("how many teeth have been lost because of periodontitis");
  }

  if (has(input.maxProbingDepthMm) && input.maxProbingDepthMm >= 6) {
    candidates.push({
      stage: "III",
      severity: false,
      because: `A maximum probing depth of ${input.maxProbingDepthMm}mm is a stage III complexity factor (6mm or more).`,
    });
  }
  if (has(input.verticalBoneLossMm) && input.verticalBoneLossMm >= 3) {
    candidates.push({
      stage: "III",
      severity: false,
      because: `Vertical bone loss of ${input.verticalBoneLossMm}mm is a stage III complexity factor (3mm or more).`,
    });
  }
  // THE GRADE IS PRINTED, NOT RE-DERIVED. This used to read the number and write
  // a roman numeral back out of a ternary — `worstFurcation === 3 ? "III" : "II"`
  // — which under grades 1–4 renders the WORST finding in the mouth, a grade 4,
  // as the milder "grade II", inside the very sentence justifying the stage it
  // raised. The number the clinician typed is the number that prints.
  //
  // "periodontitis stage" rather than bare "stage" in both sentences below,
  // because these are the only two candidates carrying a competing numeric scale
  // of their own: a sentence containing both "stage 2 mobility" and "stage IV"
  // has to say which is which.
  if (has(input.worstFurcation) && input.worstFurcation >= 2) {
    candidates.push({
      stage: "III",
      severity: false,
      because: `A grade ${input.worstFurcation} furcation, on a scale of 1 to 4, is a periodontitis stage III complexity factor (grade 2 or worse).`,
    });
  }
  if (has(input.worstMobility) && input.worstMobility >= 2) {
    candidates.push({
      stage: "IV",
      severity: false,
      because: `Mobility of stage ${input.worstMobility}, on a scale of 1 to 3, indicates secondary occlusal trauma, which is a periodontitis stage IV complexity factor (stage 2 or worse).`,
    });
  }
  if (has(input.remainingTeeth) && input.remainingTeeth < 20) {
    candidates.push({
      stage: "IV",
      severity: false,
      because: `${input.remainingTeeth} remaining teeth is fewer than the ten opposing pairs that define masticatory function, a stage IV complexity factor.`,
    });
  }
  if (input.masticatoryDysfunction) {
    candidates.push({
      stage: "IV",
      severity: false,
      because:
        "Masticatory dysfunction — bite collapse, drifting or flaring — is a stage IV complexity factor.",
    });
  }

  const extent = suggestExtent(input);
  if (extent) {
    workings.push(
      extent === "molar-incisor"
        ? "The pattern is molar-incisor."
        : has(input.percentTeethAffected)
          ? `${input.percentTeethAffected}% of teeth show attachment loss, so the case is ${extent} (the line is drawn at 30%).`
          : `The case is recorded as ${extent}.`,
    );
  } else {
    missing.push("the percentage of teeth affected, which decides localised from generalised");
  }

  const severityCandidates = candidates.filter((c) => c.severity);
  for (const candidate of candidates) workings.push(candidate.because);

  if (severityCandidates.length === 0) {
    workings.push(
      "No severity measure — attachment loss, bone loss or teeth lost to periodontitis — was recorded, so no stage can be suggested. An absent measurement is not a mild result.",
    );
    return { stage: null, extent, workings, missing, drivenBy: null };
  }

  const stage = candidates.reduce<PerioStage>((acc, c) => higherStage(acc, c.stage), "I");
  const worstSeverity = severityCandidates.reduce<PerioStage>((acc, c) => higherStage(acc, c.stage), "I");
  const driver = candidates.find((c) => c.stage === stage) ?? null;

  if (stage !== worstSeverity) {
    workings.push(
      `Complexity raises the stage and never lowers it: the severity measurements alone give stage ${worstSeverity}, and the complexity factors above take the case to stage ${stage}.`,
    );
  }

  return {
    stage,
    extent,
    workings,
    missing,
    drivenBy: driver ? driver.because : null,
  };
}

function suggestExtent(input: StagingInput): PerioExtent | null {
  if (input.molarIncisorPattern) return "molar-incisor";
  const pct = input.percentTeethAffected;
  if (!has(pct)) return null;
  return pct >= 30 ? "generalised" : "localised";
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export interface SmokingStatus {
  smokes: boolean;
  /** Null when the patient smokes but the amount is unknown. The threshold is
   *  ten a day, so an unknown amount cannot reach grade C on its own. */
  cigarettesPerDay?: number | null;
}

export interface DiabetesStatus {
  diabetic: boolean;
  /** HbA1c as a percentage. The threshold is 7.0%. */
  hba1cPercent?: number | null;
}

export type BiofilmPhenotype =
  | "destruction-below-expected"
  | "commensurate"
  | "destruction-exceeds-expected";

export interface GradingInput {
  /** Direct evidence: bone loss as a percentage of root length, over age. */
  boneLossPercent?: number | null;
  ageYears?: number | null;
  /** Indirect evidence: change in attachment loss over five years, in mm. */
  calChange5yrMm?: number | null;
  /** Case phenotype, used only when neither of the above is available. */
  biofilm?: BiofilmPhenotype | null;
  /** Undefined or null means UNKNOWN, which applies no modifier and is recorded
   *  as missing. It does not mean "non-smoker". */
  smoking?: SmokingStatus | null;
  diabetes?: DiabetesStatus | null;
}

export interface GradeModifierApplied {
  modifier: GradeModifier;
  /** The lowest grade this risk factor allows. */
  floor: PerioGrade;
  /** True when it actually moved the grade. A modifier that did not move it is
   *  still reported, in the workings, so nobody thinks it was overlooked. */
  raised: boolean;
  because: string;
}

export interface GradingSuggestion {
  grade: PerioGrade | null;
  /** Before the modifiers. */
  baseGrade: PerioGrade | null;
  /** True when the base is the framework's default of B rather than a measured
   *  rate of progression. */
  baseAssumed: boolean;
  modifiers: GradeModifierApplied[];
  modifiersApplied: GradeModifier[];
  workings: string[];
  missing: string[];
}

const GRADE_ORDER: PerioGrade[] = ["A", "B", "C"];

/** The only direction a modifier moves a grade. */
function raiseGrade(current: PerioGrade, floor: PerioGrade): PerioGrade {
  return GRADE_ORDER.indexOf(floor) > GRADE_ORDER.indexOf(current) ? floor : current;
}

export function suggestGrade(input: GradingInput): GradingSuggestion {
  const workings: string[] = [];
  const missing: string[] = [];
  let baseGrade: PerioGrade | null = null;
  let baseAssumed = false;

  if (has(input.boneLossPercent) && has(input.ageYears) && input.ageYears > 0) {
    const ratio = input.boneLossPercent / input.ageYears;
    const rounded = Math.round(ratio * 100) / 100;
    baseGrade = ratio > 1 ? "C" : ratio >= 0.25 ? "B" : "A";
    workings.push(
      `Direct evidence: ${input.boneLossPercent}% bone loss at age ${input.ageYears} is a bone loss to age ratio of ${rounded}, which is grade ${baseGrade} (under 0.25 grade A, 0.25 to 1.0 grade B, above 1.0 grade C).`,
    );
  } else if (has(input.calChange5yrMm)) {
    const change = input.calChange5yrMm;
    baseGrade = change >= 2 ? "C" : change > 0 ? "B" : "A";
    workings.push(
      change <= 0
        ? "Indirect evidence: no attachment loss over five years is grade A."
        : `Indirect evidence: ${change}mm of attachment loss over five years is grade ${baseGrade} (under 2mm grade B, 2mm or more grade C).`,
    );
  } else if (input.biofilm) {
    baseGrade =
      input.biofilm === "destruction-exceeds-expected"
        ? "C"
        : input.biofilm === "commensurate"
          ? "B"
          : "A";
    workings.push(
      `Case phenotype: destruction is ${
        input.biofilm === "commensurate"
          ? "commensurate with the biofilm present, which is grade B"
          : input.biofilm === "destruction-exceeds-expected"
            ? "greater than the biofilm present would explain, which is grade C"
            : "less than the heavy biofilm present would explain, which is grade A"
      }.`,
    );
  } else {
    baseGrade = "B";
    baseAssumed = true;
    missing.push("radiographic bone loss and the patient's age, or attachment loss over five years");
    workings.push(
      "No direct or indirect evidence of the rate of progression was available. The 2017/18 framework starts from an assumption of grade B, so that is the assumption here — it is not a measurement.",
    );
  }

  const modifiers: GradeModifierApplied[] = [];

  if (input.smoking && input.smoking.smokes) {
    const perDay = input.smoking.cigarettesPerDay;
    if (has(perDay) && perDay >= 10) {
      modifiers.push({
        modifier: "smoking",
        floor: "C",
        raised: false,
        because: `Smoking ${perDay} a day is a grade C modifier (ten or more a day).`,
      });
    } else if (has(perDay)) {
      modifiers.push({
        modifier: "smoking",
        floor: "B",
        raised: false,
        because: `Smoking ${perDay} a day is a grade B modifier (fewer than ten a day).`,
      });
    } else {
      modifiers.push({
        modifier: "smoking",
        floor: "B",
        raised: false,
        because:
          "The patient smokes, which is at least a grade B modifier. Ten or more a day would make it grade C, and the amount is not recorded.",
      });
      missing.push("how many cigarettes a day the patient smokes");
    }
  } else if (input.smoking && !input.smoking.smokes) {
    workings.push("The patient does not smoke, so no smoking modifier applies. That is not evidence of slow progression.");
  } else {
    missing.push("smoking status");
  }

  if (input.diabetes && input.diabetes.diabetic) {
    const hba1c = input.diabetes.hba1cPercent;
    if (has(hba1c) && hba1c >= 7) {
      modifiers.push({
        modifier: "diabetes",
        floor: "C",
        raised: false,
        because: `Diabetes with an HbA1c of ${hba1c}% is a grade C modifier (7.0% or above).`,
      });
    } else if (has(hba1c)) {
      modifiers.push({
        modifier: "diabetes",
        floor: "B",
        raised: false,
        because: `Diabetes with an HbA1c of ${hba1c}% is a grade B modifier (below 7.0%).`,
      });
    } else {
      modifiers.push({
        modifier: "diabetes",
        floor: "B",
        raised: false,
        because:
          "The patient is diabetic, which is at least a grade B modifier. An HbA1c of 7.0% or above would make it grade C, and no HbA1c is recorded.",
      });
      missing.push("the patient's HbA1c");
    }
  } else if (input.diabetes && !input.diabetes.diabetic) {
    workings.push("The patient is not diabetic, so no diabetes modifier applies.");
  } else {
    missing.push("diabetes status and HbA1c");
  }

  let grade = baseGrade;
  for (const modifier of modifiers) {
    const next = raiseGrade(grade as PerioGrade, modifier.floor);
    modifier.raised = next !== grade;
    grade = next;
    workings.push(
      modifier.raised
        ? `${modifier.because} It raises the grade to ${grade}.`
        : `${modifier.because} The evidence already places this case at grade ${grade}, and a modifier never lowers a grade, so it stands at ${grade}.`,
    );
  }

  return {
    grade,
    baseGrade,
    baseAssumed,
    modifiers,
    modifiersApplied: modifiers.filter((m) => m.raised).map((m) => m.modifier),
    workings,
    missing,
  };
}

// ---------------------------------------------------------------------------
// The whole suggestion
// ---------------------------------------------------------------------------

export interface DiagnosisInput {
  staging: StagingInput;
  grading: GradingInput;
}

export interface DiagnosisSuggestion extends PerioDiagnosisSuggestion {
  extent: PerioExtent | null;
  staging: StagingSuggestion;
  grading: GradingSuggestion;
  missing: string[];
  /** Printed wherever the suggestion is. Not a tooltip. */
  disclaimer: string;
}

export function suggestDiagnosis(input: DiagnosisInput): DiagnosisSuggestion {
  const staging = suggestStage(input.staging);
  const grading = suggestGrade(input.grading);
  return {
    stage: staging.stage,
    grade: staging.stage === null ? null : grading.grade,
    extent: staging.extent,
    modifiersApplied: grading.modifiersApplied,
    workings: [...staging.workings, ...grading.workings],
    staging,
    grading,
    missing: [...staging.missing, ...grading.missing],
    disclaimer: DECISION_SUPPORT_NOTICE,
  };
}

/** "Generalised periodontitis, stage III grade C". Null when there is no stage,
 *  because "periodontitis, stage unknown" is not a phrase to put on a record. */
export function describeDiagnosis(suggestion: DiagnosisSuggestion): string | null {
  if (!suggestion.stage) return null;
  const extent =
    suggestion.extent === "molar-incisor"
      ? "Molar-incisor pattern periodontitis"
      : suggestion.extent
        ? `${suggestion.extent[0].toUpperCase()}${suggestion.extent.slice(1)} periodontitis`
        : "Periodontitis";
  const grade = suggestion.grade ? `, grade ${suggestion.grade}` : "";
  return `${extent}, stage ${suggestion.stage}${grade}`;
}

// ---------------------------------------------------------------------------
// The clinician's own decision
// ---------------------------------------------------------------------------

export interface ClinicianDiagnosisInput {
  stage: PerioStage | null;
  grade: PerioGrade | null;
  recorded: PerioAttribution;
  /** Required when the clinician's answer differs from the suggestion. Not
   *  because the clinician owes the software an explanation, but because the
   *  record has to show why the recorded diagnosis is what it is. */
  rationale?: string | null;
}

export interface ClinicianDiagnosis {
  stage: PerioStage | null;
  grade: PerioGrade | null;
  /** Kept, never replaced: what was proposed and what was decided are two
   *  separate facts and the record needs both. */
  suggestion: DiagnosisSuggestion;
  agreesWithSuggestion: boolean;
  rationale: string | null;
  recorded: PerioAttribution;
}

export class PerioDiagnosisError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join(" "));
    this.name = "PerioDiagnosisError";
    this.issues = issues;
  }
}

/**
 * Record what the clinician decided.
 *
 * Overriding is meant to be easy — the whole point is that the clinician owns
 * the diagnosis — so agreeing costs nothing and disagreeing costs one sentence.
 */
export function recordClinicianDiagnosis(
  suggestion: DiagnosisSuggestion,
  input: ClinicianDiagnosisInput,
): ClinicianDiagnosis {
  const issues: string[] = [];
  const clinician = input.recorded?.clinician;
  if (!clinician || clinician.id.trim() === "" || clinician.name.trim() === "") {
    issues.push("A diagnosis must name the clinician who made it (GDC Standard 4.1.4).");
  }
  if (typeof input.recorded?.at !== "string" || Number.isNaN(Date.parse(input.recorded.at))) {
    issues.push("A diagnosis must be dated, with an ISO-8601 instant supplied by the caller.");
  }
  const agrees = input.stage === suggestion.stage && input.grade === suggestion.grade;
  const rationale = (input.rationale ?? "").trim();
  if (!agrees && rationale === "") {
    issues.push(
      "This diagnosis differs from the suggestion, so the record has to say why. One sentence is enough.",
    );
  }
  if (issues.length > 0) throw new PerioDiagnosisError(issues);

  return {
    stage: input.stage,
    grade: input.grade,
    suggestion,
    agreesWithSuggestion: agrees,
    rationale: rationale === "" ? null : rationale,
    recorded: input.recorded,
  };
}

// ---------------------------------------------------------------------------
// What a six-point chart can and cannot tell you
// ---------------------------------------------------------------------------

export interface StagingInputFromChart {
  input: StagingInput;
  /** What the chart could not supply, in whole sentences. Staging needs
   *  radiographs and a history; a pocket chart is only part of the evidence. */
  caveats: string[];
}

/**
 * Pull out of a six-point chart the parts of a staging input it can honestly
 * supply, and say plainly what it cannot.
 *
 * A chart holds attachment loss, probing depths, furcation and mobility. It
 * does NOT hold radiographic bone loss, and it does not know WHY a tooth is
 * missing — a tooth lost to caries stages a mouth as severely as one lost to
 * periodontitis if nobody checks, which is why that field is never guessed here.
 */
export function stagingInputFromChart(chart: PocketChartView): StagingInputFromChart {
  const caveats: string[] = [];
  let worstInterproximalCal: number | null = null;
  let worstInterproximalAt: string | null = null;
  let maxDepth: number | null = null;
  let worstFurcation: FurcationGrade | null = null;
  let worstMobility: MobilityStage | null = null;

  for (const tooth of chart.teeth) {
    for (const site of tooth.sites) {
      if (!site.recorded) continue;
      const depth = site.probingDepth as number;
      if (maxDepth === null || depth > maxDepth) maxDepth = depth;
      if (
        site.cal !== null &&
        (INTERPROXIMAL_SITES as readonly string[]).includes(site.site) &&
        (worstInterproximalCal === null || site.cal > worstInterproximalCal)
      ) {
        worstInterproximalCal = site.cal;
        worstInterproximalAt = `tooth ${tooth.tooth}, ${SITE_LABEL[site.site]}`;
      }
    }
    if (tooth.furcation !== null && (worstFurcation === null || tooth.furcation > worstFurcation)) {
      worstFurcation = tooth.furcation;
    }
    if (tooth.mobility !== null && (worstMobility === null || tooth.mobility > worstMobility)) {
      worstMobility = tooth.mobility;
    }
  }

  if (chart.coverage === "partial") {
    caveats.push(
      "These figures come from a partial chart, so the site of greatest attachment loss may not have been probed at all.",
    );
  }
  if (worstInterproximalCal === null) {
    caveats.push(
      "No interdental attachment loss could be computed: recession was not recorded alongside the probing depths, and attachment loss is depth plus recession.",
    );
  } else {
    caveats.push(
      `The worst interdental attachment loss in this chart is ${worstInterproximalCal}mm, at ${worstInterproximalAt}.`,
    );
  }
  caveats.push(
    "Radiographic bone loss is not in this chart and has to be read from the radiographs.",
  );
  caveats.push(
    "Teeth lost to periodontitis have to be counted by the clinician: this platform cannot tell why a tooth is missing, and counting one lost to caries would over-stage the case.",
  );

  return {
    input: {
      worstInterproximalCalMm: worstInterproximalCal,
      maxProbingDepthMm: maxDepth,
      worstFurcation,
      worstMobility,
    },
    caveats,
  };
}
