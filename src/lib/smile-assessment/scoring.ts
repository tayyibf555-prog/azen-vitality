// Pure, deterministic Smile Assessment scoring. Turns a set of selected answers
// into a 0-100 intent/fit score and a band. No I/O, fully unit-tested.
//
// INTENT and FIT only — never clinical suitability. The score reflects how ready
// and how good a fit the enquiry is, so the team knows who to contact first. It
// is NOT a judgement on whether a treatment is clinically right for the patient.

import { QUIZ_QUESTIONS, questionById, Q_TREATMENT, Q_BUDGET } from "./quiz";
import { goalTreatment, budgetMatches } from "./campaign";

export type AssessmentBand = "high" | "medium" | "low";

/**
 * Campaign tuning. When a submission comes through a targeted campaign, a match on
 * the campaign's goal treatment and/or its target budget band adds a bounded bonus
 * so "high / ideal fit" reflects what THAT campaign is trying to book. Omitted (the
 * generic quiz) => pure base scoring, unchanged.
 */
export interface ScoreTuning {
  goal?: string | null; // campaign goal key (campaign.ts), or null/undefined for general
  targetBudget?: string | null; // 'ready' | 'finance' | 'flexible' | 'any'
}

/** Bonus added when the respondent's treatment matches the campaign's goal. */
export const GOAL_MATCH_BONUS = 10;
/** Bonus added when the respondent's funding answer is in the target budget band. */
export const BUDGET_MATCH_BONUS = 5;

/** Banding thresholds on the normalised 0-100 score. */
export const BAND_HIGH = 70;
export const BAND_MEDIUM = 40;

/**
 * The best possible raw total if EVERY question in the bank were answered with its
 * top option. The adaptive funnel only asks a subset, so this is not the scoring
 * denominator (see below) — it is kept for reference/diagnostics.
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
 * Unknown question ids and unknown/missing option values contribute nothing, so
 * this never throws on bad input.
 *
 * The funnel is ADAPTIVE: each lead answers a different subset of the bank. So the
 * score is the raw weight sum normalised against the best achievable total for the
 * questions ACTUALLY ANSWERED (per-answered max), not the whole bank. That keeps
 * the 0-100 scale meaningful regardless of which path the AI took. When all four
 * original core questions are answered the denominator is the same as before, so
 * the static-form scores are unchanged.
 */
export function scoreAssessment(
  responses: Record<string, string>,
  tuning?: ScoreTuning,
): { rawScore: number; band: AssessmentBand } {
  let raw = 0;
  let maxRaw = 0;
  for (const [questionId, value] of Object.entries(responses)) {
    const question = questionById(questionId);
    if (!question) continue;
    const option = question.options.find((o) => o.value === value);
    if (!option) continue;
    raw += option.weight;
    maxRaw += Math.max(0, ...question.options.map((o) => o.weight));
  }

  let rawScore =
    maxRaw > 0 ? Math.max(0, Math.min(100, Math.round((raw / maxRaw) * 100))) : 0;

  // Campaign tuning: additive, bounded bonuses for matching the campaign's goal
  // treatment and target budget band. Re-clamped to 0-100 so the scale is stable.
  if (tuning) {
    let bonus = 0;
    const wantTreatment = goalTreatment(tuning.goal);
    if (wantTreatment && responses[Q_TREATMENT] === wantTreatment) bonus += GOAL_MATCH_BONUS;
    if (budgetMatches(tuning.targetBudget, responses[Q_BUDGET])) bonus += BUDGET_MATCH_BONUS;
    rawScore = Math.min(100, rawScore + bonus);
  }

  return { rawScore, band: bandFor(rawScore) };
}
