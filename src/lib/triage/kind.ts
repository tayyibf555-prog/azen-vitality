import { TRIAGE_BANK_BY_KEY } from "./bank";
import type { TriageAnswer, TriageQuestionKind } from "./types";

// ===========================================================================
// WHAT KIND OF QUESTION WAS THIS? — decided in ONE place, and it fails RESTRICTED.
//
// PURE. No I/O, no clock.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS (the defect it was written to close).
// ---------------------------------------------------------------------------
// Ruling W1-C/2: the practice manager sees a symptom COUNT and a discomfort FLAG,
// never the patient's own symptom words. `projectSummary` implements that by
// splitting the answers on their KIND — `symptom` goes in the restricted half,
// everything else goes in the half every role reads.
//
// So the whole ruling rests on the projection knowing each answer's real kind, and
// the projection used to guess. It looked the key up in the SHIPPED bank and, for
// anything it did not find, fell back to `logistics` — the UNRESTRICTED class. An
// OWNER-AUTHORED question (`custom-...`, classified `symptom` by the owner in the
// bank editor) is not in the shipped bank, so the patient's answer to "where does
// it hurt?" was landing in the section the front desk reads. The one class the
// ruling protects was the one class the fallback could not name.
//
// Two things changed, and they are independent on purpose:
//
//   1. THE KIND NOW TRAVELS WITH THE ANSWER. It is stamped at submit, from the
//      SAME projection that rendered the form and validated the answer (see
//      parseAnswers in src/app/api/previsit/submit/route.ts), and it is a REQUIRED
//      field on TriageAnswer — so a caller that stores an answer without saying
//      what kind of question it was does not compile. That is what makes an
//      owner-authored question's classification survive into the summary, and it
//      keeps surviving after the owner has DELETED the question, when no config
//      anywhere can still say what it was.
//
//   2. AN UNKNOWN KIND IS `symptom`, never `logistics`. Whatever is missing,
//      corrupted, hand-written into the jsonb column or simply older than this
//      file resolves to the RESTRICTED class. The cost of the safe direction is
//      that the manager may see "the patient also answered 1 question" for
//      something harmless; the cost of the unsafe one is a patient's own words
//      about their mouth on a screen the ruling says they may not appear on.
//
// MOST-RESTRICTIVE WINS across every source that has an opinion, because the
// sources can disagree honestly: the owner may re-classify a question AFTER a
// patient answered it, in either direction, and neither answer to "which one is
// current?" is safe on its own. If any of them says `symptom`, it is `symptom`.
// ===========================================================================

/** Every kind, listed once so a fifth one cannot be added without meeting this file. */
export const TRIAGE_QUESTION_KINDS: readonly TriageQuestionKind[] = [
  "symptom",
  "logistics",
  "cosmetic",
  "interest",
] as const;

const KIND_SET: ReadonlySet<string> = new Set<string>(TRIAGE_QUESTION_KINDS);

/** True for a value that really is one of the four kinds. Guards the jsonb read. */
export function isTriageQuestionKind(value: unknown): value is TriageQuestionKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/**
 * The kind an answer gets when NOTHING can say what it was.
 *
 * `symptom` — the restricted class. Named as a constant rather than written inline
 * so that the fail direction is a thing a reviewer can find, and so that the
 * mutation test that flips it to "logistics" has one line to flip.
 */
export const UNKNOWN_ANSWER_KIND: TriageQuestionKind = "symptom";

/** A practice's own questions, indexed by key. Label for the screen, kind for this. */
export type CustomQuestionIndex = ReadonlyMap<string, { label: string; kind: TriageQuestionKind }>;

/**
 * What kind of question this stored answer was, across every source that knows.
 *
 * In order: the SHIPPED bank (in-code, and a shipped key's classification is not a
 * thing a database row may contradict), the kind STAMPED on the answer at submit,
 * and the practice's CURRENT bank config. If any of them says `symptom` the answer
 * is `symptom`; if none of them has an opinion at all the answer is
 * UNKNOWN_ANSWER_KIND, which is also `symptom`.
 */
export function resolveAnswerKind(
  answer: TriageAnswer,
  custom?: CustomQuestionIndex,
): TriageQuestionKind {
  const known: TriageQuestionKind[] = [];
  const shipped = TRIAGE_BANK_BY_KEY.get(answer.key)?.kind;
  if (shipped) known.push(shipped);
  // Runtime-checked even though the type says it is present: this value has been
  // through a jsonb column, and the type is a promise about our own code, not
  // about the row that comes back.
  if (isTriageQuestionKind(answer.kind)) known.push(answer.kind);
  const authored = custom?.get(answer.key)?.kind;
  if (isTriageQuestionKind(authored)) known.push(authored);

  if (known.length === 0) return UNKNOWN_ANSWER_KIND;
  if (known.includes("symptom")) return "symptom";
  return known[0];
}

/**
 * The stored `answers` jsonb as answers this module will trust.
 *
 * THE ONE PLACE an unvalidated column becomes TriageAnswer[]. It used to be a
 * cast, which is how a row with no `kind` at all — one written before the field
 * existed, or by hand — reached the projection claiming to be a well-formed
 * answer. An entry with no usable key is dropped; an entry whose kind is missing
 * or is not one of the four resolves to UNKNOWN_ANSWER_KIND.
 */
export function readStoredAnswers(raw: unknown): TriageAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: TriageAnswer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    if (key === "") continue;
    out.push({
      key,
      value: typeof row.value === "string" ? row.value : "",
      kind: isTriageQuestionKind(row.kind) ? row.kind : UNKNOWN_ANSWER_KIND,
    });
  }
  return out;
}
