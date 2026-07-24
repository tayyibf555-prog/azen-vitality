// The Smile Assessment question bank. This is the practice IP: the questions, the
// answer options, and the intent/fit weight each option carries.
//
// The bank is the material the ADAPTIVE funnel draws from: the AI picks the next
// question from here based on the answers so far (it never invents questions), so
// every path stays on-brand, safe, and scoreable. Each question carries a
// `dimension` (what it measures) and optional `appliesTo` (which treatments it is
// relevant to) so the funnel can branch.
//
// Scoring is INTENT and FIT only (how ready + how good a fit the enquiry is) and
// NEVER clinical suitability. A high score means "ready to move, contact fast",
// not "this treatment is right for them". A clinician always decides suitability.
//
// Pure data: no logic here. funnel.ts selects, scoring.ts weighs. Keep ids stable.

/** A single selectable answer. `weight` is its intent/fit contribution. */
export interface QuizOption {
  value: string;
  label: string;
  weight: number;
}

/** What a question measures, used by the funnel to branch + avoid repetition. */
export type QuizDimension =
  | "treatment"
  | "timeline"
  | "budget"
  | "location"
  | "scope"
  | "motivation"
  | "readiness"
  | "experience";

export interface QuizQuestion {
  id: string;
  prompt: string;
  dimension: QuizDimension;
  /** Treatment values this question is relevant to. Undefined = relevant to all. */
  appliesTo?: string[];
  options: QuizOption[];
}

// Stable ids referenced elsewhere (the bridge denormalises treatment; the submit
// endpoint validates against these).
export const Q_TREATMENT = "treatment_interest";
export const Q_TIMELINE = "timeline";
export const Q_BUDGET = "budget_readiness";
export const Q_LOCATION = "location";

// The funnel always opens with treatment (deterministic, so the first screen is
// instant and the rest of the path can branch off it).
export const FIRST_QUESTION_ID = Q_TREATMENT;

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: Q_TREATMENT,
    prompt: "What are you most interested in?",
    dimension: "treatment",
    options: [
      { value: "invisalign", label: "Straightening my teeth (Invisalign)", weight: 20 },
      { value: "implants", label: "Replacing missing teeth (implants)", weight: 20 },
      { value: "veneers", label: "Improving how my teeth look (veneers)", weight: 18 },
      { value: "bonding", label: "Fixing chips, gaps or shape (bonding)", weight: 17 },
      { value: "whitening", label: "Whitening my teeth", weight: 12 },
      { value: "hygiene", label: "A check-up or hygiene visit", weight: 8 },
      { value: "other", label: "Something else", weight: 6 },
    ],
  },
  {
    id: Q_TIMELINE,
    prompt: "How soon would you like to get started?",
    dimension: "timeline",
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
    dimension: "budget",
    options: [
      { value: "ready", label: "I'm ready to go ahead and pay for it", weight: 30 },
      { value: "finance", label: "I'd like to spread the cost with finance", weight: 24 },
      { value: "covered", label: "I'd like it covered by a plan or scheme", weight: 8 },
      { value: "unsure", label: "I'm not sure yet", weight: 4 },
    ],
  },
  {
    id: "readiness",
    prompt: "When you find the right fit, how ready are you to book?",
    dimension: "readiness",
    options: [
      { value: "book_now", label: "Ready to book a consultation now", weight: 24 },
      { value: "soon", label: "Soon, once I know a bit more", weight: 14 },
      { value: "info", label: "Just gathering information for now", weight: 4 },
    ],
  },
  {
    id: "motivation",
    prompt: "What's prompting you to look into this now?",
    dimension: "motivation",
    options: [
      { value: "event", label: "I have an event or occasion coming up", weight: 20 },
      { value: "long_time", label: "I've been meaning to sort it for a while", weight: 13 },
      { value: "recommended", label: "It was recommended to me", weight: 15 },
      { value: "exploring", label: "Just exploring my options", weight: 5 },
    ],
  },
  {
    id: "experience",
    prompt: "Have you looked into this before?",
    dimension: "experience",
    options: [
      { value: "consulted_deciding", label: "I've had a consultation and I'm deciding", weight: 16 },
      { value: "comparing", label: "I'm comparing a few practices", weight: 12 },
      { value: "first_time", label: "This is the first time I'm looking", weight: 10 },
    ],
  },
  {
    id: "implant_scope",
    prompt: "How many teeth are you looking to replace?",
    dimension: "scope",
    appliesTo: ["implants"],
    options: [
      { value: "one", label: "Just one", weight: 14 },
      { value: "few", label: "A few", weight: 18 },
      { value: "many", label: "Several, or a full denture", weight: 20 },
      { value: "unsure", label: "I'm not sure yet", weight: 9 },
    ],
  },
  {
    // The PICTURE question: the Guided style renders each of these options as a
    // 3D-model tile (see src/components/assess/option-images.ts), which is why the
    // values are concrete conditions rather than a severity scale. Deliberately a
    // SEPARATE question from align_detail below, not a replacement: align_detail
    // measures HOW MUCH ("slight" -> "significant"), this one measures WHAT, and
    // its values/weights are new so nothing already scored or validated moves.
    //
    // Both are dimension "scope" + appliesTo invisalign, so both sit in the
    // invisalign candidate pool. That is intentional and safe: DIMENSION_PRIORITY
    // ranks the pool, the AI picks one question at a time from it, and
    // shouldFinish/MAX_QUESTIONS cap the run — so a patient gets at most a couple
    // of scope questions, never both-plus-everything. This entry is listed BEFORE
    // align_detail so that on the priority tie (both "scope") the stable sort puts
    // the picture question first, making it the preferred scope ask for aligners.
    id: "smile_concern",
    prompt: "Which of these best describes your teeth?",
    dimension: "scope",
    appliesTo: ["invisalign"],
    options: [
      { value: "crowded", label: "Crowded or overlapping", weight: 17 },
      { value: "gaps", label: "Gaps between my teeth", weight: 17 },
      { value: "open_bite", label: "My front teeth don't meet", weight: 18 },
      { value: "overbite", label: "My top teeth sit too far over", weight: 18 },
      { value: "underbite", label: "My bottom teeth sit further forward", weight: 18 },
      { value: "crossbite", label: "Some top teeth sit inside the bottom ones", weight: 18 },
      { value: "even", label: "My bite looks fairly even", weight: 13 },
      { value: "unsure", label: "I'm not sure", weight: 9 },
    ],
  },
  {
    id: "align_detail",
    prompt: "How would you describe your teeth at the moment?",
    dimension: "scope",
    appliesTo: ["invisalign"],
    options: [
      { value: "slight", label: "Slight gaps or crowding", weight: 13 },
      { value: "noticeable", label: "Fairly noticeable", weight: 17 },
      { value: "significant", label: "Quite significant", weight: 18 },
      { value: "unsure", label: "I'm not sure", weight: 9 },
    ],
  },
  {
    id: "cosmetic_goal",
    prompt: "What would make the biggest difference for you?",
    dimension: "scope",
    appliesTo: ["veneers", "whitening", "bonding"],
    options: [
      { value: "brighter", label: "A brighter colour", weight: 12 },
      { value: "shape", label: "Fixing chips, gaps or shape", weight: 17 },
      { value: "makeover", label: "A full smile makeover", weight: 20 },
      { value: "unsure", label: "I'm not sure yet", weight: 9 },
    ],
  },
  {
    id: Q_LOCATION,
    prompt: "Where are you based?",
    dimension: "location",
    // Coarse region ONLY, on purpose (owner decision): a new enquiry should never
    // be asked to pick between practices they have not heard of. The booking
    // agent asks for their town or area in conversation and points them at the
    // most convenient practice. Equal weights on purpose: region is routing
    // information, not a fit signal, so no region scores hotter than another.
    options: [
      { value: "england", label: "England", weight: 8 },
      { value: "scotland", label: "Scotland", weight: 8 },
      { value: "elsewhere", label: "Somewhere else", weight: 8 },
    ],
  },
];

/** Lookup a question by id (used by validation + scoring + the funnel). */
export function questionById(id: string): QuizQuestion | undefined {
  return QUIZ_QUESTIONS.find((q) => q.id === id);
}

/** The set of valid question ids, for fast validation of a submission. */
export const QUIZ_QUESTION_IDS: string[] = QUIZ_QUESTIONS.map((q) => q.id);
