// ===========================================================================
// THE MEDICAL-HISTORY QUESTION BANK — pure, versioned, tested.
//
// Blerta's requirement, verbatim: "a set of yes/no questions." This is that set,
// the standard UK dental medical-history screen, expressed as data rather than as
// markup so the same bank drives the patient-facing form, the read-only record
// screen and the stored answer set — one source, no drift.
//
// IT IS VERSIONED, and the version is load-bearing. A stored answer set records
// QUESTION_BANK_VERSION, so a record read years later can be understood against
// the exact questions the patient was actually shown. Changing a prompt, adding a
// question or removing one is a NEW version, never an edit in place — the old
// answers were given against the old wording and must stay legible as such.
//
// PURE. No I/O, no clock, no funding framing. These are clinical screening
// questions a patient answers about their own body; nothing here says NHS or
// private, and nothing here is a claim about a specific patient.
// ===========================================================================

/**
 * The current bank version. BUMP THIS whenever the questions below change in any
 * way a reader of a stored answer set would need to know about. A date-stamped
 * string rather than an integer so the version itself says when it was fixed.
 */
export const QUESTION_BANK_VERSION = "uk-dental-mh-2026-08-14";

// Re-exported so a form or a screen importing the bank gets the answer vocabulary
// from one place; the type itself is owned by types.ts.
export type { MedicalAnswerValue } from "./types";

/** The clinical grouping a question belongs to. Display only — the answer key is
 *  what identifies a question, never its group. */
export type MedicalQuestionGroup =
  | "cardiovascular"
  | "medication"
  | "endocrine"
  | "respiratory"
  | "neurological"
  | "allergy"
  | "bleeding"
  | "infection"
  | "pregnancy"
  | "general";

export interface MedicalQuestion {
  /** Stable key. NEVER reused for a different meaning, and NEVER changed once
   *  shipped — a stored answer references it. New meaning, new key. */
  key: string;
  /** The yes/no question, as the patient reads it. A whole question, not a label. */
  prompt: string;
  group: MedicalQuestionGroup;
  /** When true, a "yes" invites free text (e.g. which allergy, which medicine).
   *  The detail is optional even then: a patient who ticks yes and writes nothing
   *  is still a recorded yes. */
  invitesDetail: boolean;
}

/**
 * The bank. Ordered as a clinician would read it: heart first, then the drugs
 * that change how we treat, then the systemic conditions, then allergies,
 * bleeding, infection, pregnancy, and the catch-all.
 *
 * These are yes/no screening prompts. The two big free-text fields — the full
 * medications list and the full allergies list — are captured SEPARATELY on the
 * questionnaire (medicationsText / allergiesText) because a list is not a yes/no
 * answer; the yes/no prompts here flag that there is something to read there.
 */
export const MEDICAL_QUESTIONS: readonly MedicalQuestion[] = [
  {
    key: "heart_condition",
    prompt: "Do you have any heart condition, high blood pressure, or a heart murmur?",
    group: "cardiovascular",
    invitesDetail: true,
  },
  {
    key: "heart_surgery_or_stent",
    prompt: "Have you ever had heart surgery, a stent, a pacemaker, or a replacement heart valve?",
    group: "cardiovascular",
    invitesDetail: true,
  },
  {
    key: "anticoagulants",
    prompt: "Do you take any blood-thinning medicine (for example warfarin, apixaban, rivaroxaban or clopidogrel)?",
    group: "medication",
    invitesDetail: true,
  },
  {
    key: "bisphosphonates",
    prompt: "Have you ever taken bisphosphonates or other bone-strengthening medicine (for osteoporosis or cancer)?",
    group: "medication",
    invitesDetail: true,
  },
  {
    key: "steroids",
    prompt: "Are you taking, or have you recently taken, steroids (for example prednisolone)?",
    group: "medication",
    invitesDetail: true,
  },
  {
    key: "diabetes",
    prompt: "Do you have diabetes?",
    group: "endocrine",
    invitesDetail: true,
  },
  {
    key: "asthma_or_breathing",
    prompt: "Do you have asthma or any other breathing problem?",
    group: "respiratory",
    invitesDetail: true,
  },
  {
    key: "epilepsy_or_fainting",
    prompt: "Do you have epilepsy, seizures, or a tendency to faint?",
    group: "neurological",
    invitesDetail: true,
  },
  {
    key: "allergy_penicillin",
    prompt: "Are you allergic to penicillin or any other antibiotic?",
    group: "allergy",
    invitesDetail: true,
  },
  {
    key: "allergy_latex",
    prompt: "Are you allergic to latex?",
    group: "allergy",
    invitesDetail: false,
  },
  {
    key: "allergy_other",
    prompt: "Do you have any other allergies (for example to medicines, metals, foods or anaesthetic)?",
    group: "allergy",
    invitesDetail: true,
  },
  {
    key: "bleeding_disorder",
    prompt: "Do you have any bleeding disorder, or do you bleed for a long time after a cut or an extraction?",
    group: "bleeding",
    invitesDetail: true,
  },
  {
    key: "blood_borne_infection",
    prompt: "Have you ever had hepatitis, tuberculosis, or any other infectious disease?",
    group: "infection",
    invitesDetail: true,
  },
  {
    key: "pregnant_or_breastfeeding",
    prompt: "Are you currently pregnant or breastfeeding?",
    group: "pregnancy",
    invitesDetail: false,
  },
  {
    key: "other_condition",
    prompt: "Do you have any other medical condition, or have you had any operation, that your dentist should know about?",
    group: "general",
    invitesDetail: true,
  },
] as const;

/** Every question key in the bank. Deduped by construction — keys are unique. */
export function questionKeys(): string[] {
  return MEDICAL_QUESTIONS.map((q) => q.key);
}

const KEY_SET: ReadonlySet<string> = new Set(MEDICAL_QUESTIONS.map((q) => q.key));

/** Whether a key belongs to the current bank. An answer with an unknown key is
 *  dropped rather than stored, so a stale or forged key cannot bloat a record. */
export function isKnownQuestionKey(key: string): boolean {
  return KEY_SET.has(key);
}

/** The question for a key, or null when the key is not in the bank. */
export function questionForKey(key: string): MedicalQuestion | null {
  return MEDICAL_QUESTIONS.find((q) => q.key === key) ?? null;
}
