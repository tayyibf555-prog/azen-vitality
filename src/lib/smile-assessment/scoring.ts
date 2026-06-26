// Pure, deterministic Smile Assessment scoring. Turns a set of selected answers
// into a 0-100 intent/fit score and a band. No I/O, fully unit-tested.
//
// INTENT and FIT only — never clinical suitability. The score reflects how ready
// and how good a fit the enquiry is, so the team knows who to contact first. It
// is NOT a judgement on whether a treatment is clinically right for the patient.

import { QUIZ_QUESTIONS, questionById } from "./quiz";

export type AssessmentBand = "high" | "medium" | "low";

/** Banding thresholds on the normalised 0-100 score. */
export const BAND_HIGH = 70;
export const BAND_MEDIUM = 40;

/**
 * The best possible raw total: for each question, its highest-weighted option.
 * Computed from the quiz so it stays correct if weights change. Used to normalise
 * any submission onto a stable 0-100 scale regardless of how many questions exist.
 */
export const MAX_RAW_TOTAL: number = QUIZ_QUESTIONS.reduce(
  (sum, q) => sum + Math.max(0, ...q.options.map((o) => o.weight)),
  0,
);

export function bandFor(score: number): AssessmentBand {
  if (score >= BAND_HIGH) return "high";
  if (score >= BAND_MEDIUM) return "medium";
  return "low";
}

/**
 * Score a set of responses. `responses` maps question id -> selected option value.
 * Unknown question ids and unknown/missing option values contribute nothing
 * (a partial submission simply scores lower), so this never throws on bad input.
 *
 * The raw weight sum is normalised against MAX_RAW_TOTAL so the score is a stable
 * 0-100 percentage of the best achievable intent/fit signal.
 */
export function scoreAssessment(
  responses: Record<string, string>,
): { rawScore: number; band: AssessmentBand } {
  let raw = 0;
  for (const [questionId, value] of Object.entries(responses)) {
    const question = questionById(questionId);
    if (!question) continue;
    const option = question.options.find((o) => o.value === value);
    if (!option) continue;
    raw += option.weight;
  }

  const rawScore =
    MAX_RAW_TOTAL > 0 ? Math.max(0, Math.min(100, Math.round((raw / MAX_RAW_TOTAL) * 100))) : 0;

  return { rawScore, band: bandFor(rawScore) };
}
