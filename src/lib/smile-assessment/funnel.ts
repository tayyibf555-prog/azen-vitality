// Pure adaptive-funnel logic. The funnel asks one question at a time; after each
// answer the AI (in /api/smile-assessment/next) picks the next question from the
// candidates these helpers compute. The AI only SELECTS from the bank, so every
// path stays on-brand + scoreable. These helpers also provide a deterministic
// fallback so the funnel never stalls if the model call fails. No I/O, unit-tested.

import {
  QUIZ_QUESTIONS,
  questionById,
  Q_TREATMENT,
  Q_TIMELINE,
  Q_BUDGET,
  type QuizQuestion,
  type QuizDimension,
} from "./quiz";

/** Hard cap on funnel length: treatment + up to five more. Keeps it quick. */
export const MAX_QUESTIONS = 6;

/** The core dimensions that drive the score and must be covered before finishing. */
const CORE_IDS = [Q_TREATMENT, Q_TIMELINE, Q_BUDGET];

/** A "depth" answer (beyond the core triad) makes the lead meaningfully qualified. */
const DEPTH_DIMENSIONS: QuizDimension[] = ["readiness", "motivation", "scope", "experience"];

// Default ordering for the deterministic fallback (higher = asked sooner). The AI
// reorders adaptively; this is only the safety net.
const DIMENSION_PRIORITY: Record<QuizDimension, number> = {
  treatment: 200,
  timeline: 100,
  budget: 95,
  readiness: 80,
  scope: 72,
  motivation: 66,
  experience: 50,
  location: 30,
};

/** How many valid (known-question) answers have been given. */
export function answeredCount(answers: Record<string, string>): number {
  return Object.keys(answers).filter((id) => !!questionById(id) && !!answers[id]).length;
}

/**
 * Questions still unanswered AND relevant to the chosen treatment (a question with
 * `appliesTo` only shows for those treatments). Sorted by the fallback priority.
 */
export function candidateQuestions(answers: Record<string, string>): QuizQuestion[] {
  const treatment = answers[Q_TREATMENT];
  return QUIZ_QUESTIONS.filter((q) => {
    if (answers[q.id] !== undefined && answers[q.id] !== "") return false; // answered
    if (q.appliesTo && (!treatment || !q.appliesTo.includes(treatment))) return false;
    return true;
  }).sort((a, b) => DIMENSION_PRIORITY[b.dimension] - DIMENSION_PRIORITY[a.dimension]);
}

/**
 * Whether enough has been gathered to finish: the hard cap is hit, OR there are no
 * eligible questions left, OR the core triad plus at least one depth question are
 * answered (a qualified-enough lead, kept short so the funnel feels quick).
 */
export function shouldFinish(answers: Record<string, string>): boolean {
  if (answeredCount(answers) >= MAX_QUESTIONS) return true;
  if (candidateQuestions(answers).length === 0) return true;
  const coreDone = CORE_IDS.every((id) => answers[id] !== undefined && answers[id] !== "");
  const depthDone = QUIZ_QUESTIONS.some(
    (q) => DEPTH_DIMENSIONS.includes(q.dimension) && answers[q.id] !== undefined && answers[q.id] !== "",
  );
  return coreDone && depthDone;
}

/**
 * Deterministic next-question id (the safety net when the AI call fails), or null
 * to finish. Prefers an unanswered core question (so timeline + funding always get
 * covered), else the highest-priority candidate.
 */
export function deterministicNext(answers: Record<string, string>): string | null {
  if (shouldFinish(answers)) return null;
  const cands = candidateQuestions(answers);
  const core = cands.find((q) => CORE_IDS.includes(q.id));
  return (core ?? cands[0])?.id ?? null;
}
