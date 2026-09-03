import type {
  InterestTreatment,
  TriageBankConfig,
  TriageFork,
  TriageQuestion,
} from "./types";

// ===========================================================================
// THE QUESTION BANK: the two default lists, as EDITABLE DEFAULTS.
//
// PURE. No I/O. Safe to import from a client component (the owner editor renders
// this list) and from the server (the public form resolves against it).
//
// CONTRACT: every `key` is stable. Stored answers are keyed by it and the summary
// reads by it, so a key that has shipped never changes — questions are added,
// never renamed. This is the same contract onboarding/library.ts states, for the
// same reason.
//
// ---------------------------------------------------------------------------
// WHICH LIST IS WHICH, AND WHY THE SHORT ONE IS SHORT.
// ---------------------------------------------------------------------------
//
// `banks` on each question says which default list it is in. The full list is the
// practice's own pre-visit triage; the brief list is interest and logistics only,
// because an NHS-plan patient must not be asked a pain / symptom / treatment-need
// question before their visit (see ./fork.ts).
//
// THE DEFAULTS ARE NOT THE GUARD. An owner can switch any question on for either
// bank from the editor. What stops a symptom question reaching the brief bank is
// ./project.ts, which filters on `kind` AND scans the label against
// FORBIDDEN_IN_BRIEF — so the rule holds against an edited config, a custom
// question, and a corrupted row alike. `banks` is a starting point; `projectBank`
// is the law.
//
// ---------------------------------------------------------------------------
// TONE.
// ---------------------------------------------------------------------------
// Warm, plain British English, no em-dash, no clinical framing, no funding word.
// A question is an invitation, never an instruction, and nothing here offers an
// opinion about the patient's mouth. `copy.test.ts` crawls every string in this
// file for a funding word and for an em-dash.
// ===========================================================================

/** The interest grid renders as ONE question with this key. */
export const INTEREST_QUESTION_KEY = "interest-grid";

export const TRIAGE_BANK: readonly TriageQuestion[] = [
  // -------------------------------------------------------------------------
  // LOGISTICS. Both banks. Nothing here asks about the patient's mouth.
  // -------------------------------------------------------------------------
  {
    key: "attending",
    label: "Are you still able to come to your appointment?",
    type: "choice",
    kind: "logistics",
    banks: ["full", "brief"],
    options: [
      { value: "yes", label: "Yes, I'll be there" },
      { value: "unsure", label: "I'm not sure yet" },
      { value: "no", label: "No, I need to change it" },
    ],
    help: "If you need a different time, tell us here and we'll ring you.",
    requirable: true,
  },
  {
    key: "health-changed",
    // "Anything about your health" rather than "medical history": the patient is
    // being asked to flag a change so a person can check the record, not to fill
    // in a medical history. The medical-history questionnaire is its own form,
    // its own consent and its own tab (src/lib/patient-medical), and this question
    // must never read as a substitute for it.
    label: "Has anything about your health or your medicines changed since we last saw you?",
    type: "yesno",
    kind: "logistics",
    banks: ["full", "brief"],
    help: "A yes or a no is enough. We'll go through the details with you at your visit.",
    requirable: true,
  },
  {
    key: "anything-helpful",
    label: "Is there anything that would make your visit easier?",
    type: "textarea",
    kind: "logistics",
    banks: ["full", "brief"],
    help: "Anything at all. Getting in and out, timing, needing someone with you.",
    // Free text is never requirable — see TriageQuestion.requirable.
    requirable: false,
  },

  // -------------------------------------------------------------------------
  // COSMETIC. Both banks. An aspiration, not a complaint.
  //
  // THIS IS THE ONE QUESTION ON THE BRIEF BANK THAT COULD DRIFT INTO A SYMPTOM
  // QUESTION, and the phrasing is doing real work. "If you could change one thing
  // about your smile" invites a want. "Is there anything you don't like about your
  // teeth" invites a complaint, and a complaint about a tooth is a symptom report.
  // The first is asked of everybody; the second would have to be full-bank only.
  // -------------------------------------------------------------------------
  {
    key: "smile-change",
    label: "If you could change one thing about your smile, what would it be?",
    type: "textarea",
    kind: "cosmetic",
    banks: ["full", "brief"],
    help: "Only if you'd like to. There's no right answer and you can leave it blank.",
    requirable: false,
  },

  // -------------------------------------------------------------------------
  // INTEREST. Both banks. The tick-grid, rendered by its own component.
  //
  // REQUIRABLE, and required by default, which is the one place this module makes
  // a patient answer something. It is required-but-refusable: "Not right now" is
  // always offered, is one tap, and is laid out as an equal choice. See
  // ./project.ts (the refusal is structural) and interest-grid.tsx.
  // -------------------------------------------------------------------------
  {
    key: INTEREST_QUESTION_KEY,
    label: "Would you like to hear more about any of these?",
    type: "interest",
    kind: "interest",
    banks: ["full", "brief"],
    help: "Saying yes just means someone will have a chat with you about it. Nothing is booked and nothing is charged.",
    requirable: true,
  },

  // -------------------------------------------------------------------------
  // SYMPTOM. FULL BANK ONLY. Every question below is one an NHS-plan patient
  // must not be asked before their visit.
  // -------------------------------------------------------------------------
  {
    key: "visit-reason",
    label: "What's bringing you in this time?",
    type: "choice",
    kind: "symptom",
    banks: ["full"],
    options: [
      { value: "checkup", label: "A routine check-up" },
      { value: "hygiene", label: "A clean with the hygienist" },
      { value: "something-bothering", label: "Something is bothering me" },
      { value: "cosmetic", label: "I'd like to change how my teeth look" },
      { value: "continuing", label: "Continuing treatment I've already started" },
      { value: "other", label: "Something else" },
    ],
    requirable: true,
  },
  {
    key: "concern-words",
    label: "In your own words, what would you like us to look at?",
    type: "textarea",
    kind: "symptom",
    banks: ["full"],
    help: "However you'd say it. You don't need to use any particular words.",
    requirable: false,
  },
  {
    key: "how-long",
    label: "How long has it been going on?",
    type: "choice",
    kind: "symptom",
    banks: ["full"],
    options: [
      { value: "days", label: "A few days" },
      { value: "weeks", label: "A few weeks" },
      { value: "months", label: "A few months" },
      { value: "longer", label: "Longer than that" },
      { value: "n/a", label: "It doesn't apply" },
    ],
    requirable: false,
  },
  {
    key: "pain-now",
    // A 0-10 scale, and the anchors are the patient's own experience rather than a
    // clinical grading. The number is DECISION SUPPORT for the clinician and for
    // the front desk (a 9 is a reason to ring the patient today); it is never a
    // triage verdict this module acts on by itself, and nothing in this module
    // messages a patient differently because of it.
    label: "Right now, how uncomfortable is it?",
    type: "scale",
    kind: "symptom",
    banks: ["full"],
    help: "0 is completely fine and 10 is the worst you can imagine.",
    requirable: false,
  },
  {
    key: "sensitivity",
    label: "Do hot or cold drinks set anything off?",
    type: "yesno",
    kind: "symptom",
    banks: ["full"],
    requirable: false,
  },
  {
    key: "gums-bleed",
    label: "Do your gums bleed when you brush?",
    type: "yesno",
    kind: "symptom",
    banks: ["full"],
    requirable: false,
  },
  {
    key: "chipped-broken",
    label: "Has anything chipped or broken?",
    type: "yesno",
    kind: "symptom",
    banks: ["full"],
    requirable: false,
  },
  {
    key: "anxiety",
    // THE ONE QUESTION WHOSE FORK PLACEMENT IS THE PRACTICE'S CALL, NOT THIS
    // CODEBASE'S, and it is deliberately arranged so that both halves are true:
    //
    //   DEFAULT   `banks: ["full"]` only, so the shipped short list does not ask
    //             it. That is the safe reading, and it is the owner's stated rule
    //             until they say otherwise.
    //   ENABLEABLE `kind: "logistics"` and a label + help that clear the
    //             forbidden-term scan, so an owner who decides to ask it can
    //             switch it on for the short bank and `projectBank` will ADMIT it
    //             rather than silently dropping it.
    //
    // Classifying it `symptom` would have made the second half impossible: the
    // kind filter would refuse it whatever the owner configured, and the editor
    // would show a refusal the owner could not act on. `logistics` is also the
    // honest classification — operationally this books a longer slot and warns the
    // team, and it asks how the patient EXPERIENCES treatment rather than asking
    // them to report a clinical problem.
    //
    // The decision itself is the practice's to take with their contract adviser,
    // so `ownerNote` says so in the editor. That note is OWNER-facing and may name
    // the funding regime; `help` is patient-facing and may not.
    label: "How do you feel about coming to the dentist?",
    type: "choice",
    kind: "logistics",
    banks: ["full"],
    options: [
      { value: "fine", label: "Completely fine" },
      { value: "bit-nervous", label: "A bit nervous" },
      { value: "very-nervous", label: "Very nervous" },
      { value: "dread", label: "I really struggle with it" },
    ],
    // "There's no wrong answer" was the original phrasing and it cannot be used:
    // "wrong" is on the forbidden-term list, so the question would have been
    // refused on the short bank by the very scan that is meant to let it through.
    // This keeps the reassurance and loses the blocked word.
    help: "Whatever you tell us is fine. It helps us look after you properly.",
    ownerNote:
      "Asks about experience, not symptoms. Confirm with your contract adviser before enabling for NHS-plan patients.",
    requirable: false,
  },
];

export const TRIAGE_BANK_BY_KEY: ReadonlyMap<string, TriageQuestion> = new Map(
  TRIAGE_BANK.map((q) => [q.key, q]),
);

export function isKnownBankKey(key: string): boolean {
  return TRIAGE_BANK_BY_KEY.has(key);
}

/**
 * The interest grid. FOUR rows, in the order the practice asked for them.
 *
 * No price, no "from £", no claim about a result. A row is an invitation to a
 * conversation, and the blurbs say so.
 */
export const INTEREST_TREATMENTS: readonly InterestTreatment[] = [
  {
    key: "whitening",
    label: "Whitening",
    blurb: "Making your teeth lighter than they are now.",
    catalogueKeys: ["whitening"],
  },
  {
    key: "straightening",
    label: "Straightening",
    blurb: "Clear aligners that move your teeth into line, without metal braces.",
    catalogueKeys: ["invisalign"],
  },
  {
    key: "implants",
    label: "Implants",
    blurb: "A fixed replacement for a tooth that isn't there any more.",
    catalogueKeys: ["implant"],
  },
  {
    key: "veneers-bonding",
    label: "Veneers and bonding",
    blurb: "Reshaping the front of a tooth to change how it looks.",
    catalogueKeys: ["veneers", "bonding"],
  },
];

export const INTEREST_KEYS: readonly string[] = INTEREST_TREATMENTS.map((t) => t.key);

export function isKnownInterestKey(key: string): boolean {
  return INTEREST_KEYS.includes(key);
}

/**
 * The DEFAULT config for a fork: every bank question whose `banks` names it, and
 * the requirable ones that ship required.
 *
 * Returned rather than stored, so a practice that has never opened the editor is
 * running the shipped defaults and a practice that HAS is running its own — and
 * "reset to defaults" is this function rather than a migration.
 */
export function defaultConfigFor(fork: TriageFork): TriageBankConfig {
  const questions = TRIAGE_BANK.filter((q) => q.banks.includes(fork));
  const required: Record<string, boolean> = {};
  for (const q of questions) {
    if (q.requirable && DEFAULT_REQUIRED_KEYS.has(q.key)) required[q.key] = true;
  }
  return {
    enabledKeys: questions.map((q) => q.key),
    required,
    custom: [],
  };
}

/**
 * Which questions ship REQUIRED.
 *
 * Three, and the restraint is deliberate. A pre-visit form the patient abandons
 * halfway tells the clinician nothing, so the only things worth forcing are the
 * ones the practice will act on the same day: are you coming, has your health
 * changed, and the interest grid (which is required-but-refusable — see
 * INTEREST_QUESTION_KEY). Everything else is an invitation.
 *
 * `visit-reason` is required on the FULL bank only, and it is in this set rather
 * than hard-coded per fork because defaultConfigFor already filters by `banks`:
 * the key simply does not appear in the brief bank's config.
 */
const DEFAULT_REQUIRED_KEYS: ReadonlySet<string> = new Set([
  "attending",
  "health-changed",
  INTEREST_QUESTION_KEY,
  "visit-reason",
]);
