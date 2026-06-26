// The immutable Smile Assessment quiz definition. This is the practice IP: the
// questions, the answer options, and the weight each option carries.
//
// Scoring is INTENT and FIT only — how ready and how good a fit an enquiry is for
// the practice — and NEVER clinical suitability. A high score means "this person
// is ready to move and a good fit, contact them fast", not "this treatment is
// right for them". Clinical suitability is always decided by a clinician.
//
// Pure data: no logic lives here. scoring.ts consumes these weights. Keep the
// question ids stable — the submit endpoint validates against them and the
// stored responses key on them.

/** A single selectable answer. `weight` is its intent/fit contribution. */
export interface QuizOption {
  value: string;
  label: string;
  weight: number;
}

/** A single question: a prompt and the options a respondent picks one of. */
export interface QuizQuestion {
  id: string;
  prompt: string;
  options: QuizOption[];
}

// Question ids are referenced elsewhere by these constants so a rename is caught
// by the type-checker rather than silently breaking the bridge / denormalisation.
export const Q_TREATMENT = "treatment_interest";
export const Q_TIMELINE = "timeline";
export const Q_BUDGET = "budget_readiness";
export const Q_LOCATION = "location";

/**
 * The four qualifying questions. Weights are tuned so that "ready now + ready to
 * invest" answers score high and "just researching + not sure on funding" answers
 * score low, with treatment interest and a clear site preference adding modest
 * fit signal. The maximum achievable raw total is normalised to 0-100 in scoring.
 */
export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: Q_TREATMENT,
    prompt: "What are you most interested in?",
    options: [
      { value: "invisalign", label: "Straightening my teeth (Invisalign)", weight: 20 },
      { value: "implants", label: "Replacing missing teeth (implants)", weight: 20 },
      { value: "veneers", label: "Improving how my teeth look (veneers)", weight: 18 },
      { value: "whitening", label: "Whitening my teeth", weight: 12 },
      { value: "hygiene", label: "A check-up or hygiene visit", weight: 8 },
      { value: "other", label: "Something else", weight: 6 },
    ],
  },
  {
    id: Q_TIMELINE,
    prompt: "How soon would you like to get started?",
    options: [
      { value: "asap", label: "As soon as possible", weight: 30 },
      { value: "1_2_months", label: "In the next month or two", weight: 22 },
      { value: "3_6_months", label: "In the next few months", weight: 12 },
      { value: "researching", label: "Just researching for now", weight: 2 },
    ],
  },
  {
    id: Q_BUDGET,
    prompt: "How would you like to fund your treatment?",
    options: [
      { value: "ready", label: "I'm ready to go ahead and pay for it", weight: 30 },
      { value: "finance", label: "I'd like to spread the cost with finance", weight: 24 },
      { value: "covered", label: "I'd like it covered by a plan or scheme", weight: 8 },
      { value: "unsure", label: "I'm not sure yet", weight: 4 },
    ],
  },
  {
    id: Q_LOCATION,
    prompt: "Which of our practices is easiest for you?",
    options: [
      { value: "site-cc", label: "City Centre", weight: 10 },
      { value: "site-rv", label: "Riverside", weight: 10 },
      { value: "site-ng", label: "Northgate", weight: 10 },
      { value: "any", label: "Any of them works", weight: 8 },
    ],
  },
];

/** Lookup a question by id (used by validation + scoring). */
export function questionById(id: string): QuizQuestion | undefined {
  return QUIZ_QUESTIONS.find((q) => q.id === id);
}

/** The set of valid question ids, for fast validation of a submission. */
export const QUIZ_QUESTION_IDS: string[] = QUIZ_QUESTIONS.map((q) => q.id);
