import { INTEREST_TREATMENTS, TRIAGE_BANK_BY_KEY } from "./bank";
import { symptomTermIn } from "./forbidden";
import type {
  InterestAnswer,
  InterestTreatmentKey,
  TriageAnswer,
  TriageFieldType,
  TriageOption,
  TriageQuestionKind,
} from "./types";

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

/**
 * A practice's own questions, indexed by key — as much of one as the projection
 * needs, and every field is load-bearing somewhere.
 *
 *   label     the question on the screen, and the text the symptom scan below
 *             reads. Cosmetic in one use, a privacy check in the other.
 *   kind      the owner's classification. One of the opinions `resolveAnswerKind`
 *             weighs.
 *   type      what control it rendered as, which is the ONLY way the summary can
 *             know that a practice-written question was a 0-10 scale — the shipped
 *             bank cannot name a `custom-` key, so without this a patient who
 *             rated their discomfort 9 on the practice's own slider was recorded
 *             with `scale: null` and their number was printed in quotation marks
 *             as if they had typed it. Optional: a question the practice has since
 *             DELETED has no type anywhere, and an answer to it must still render.
 *   options   the choice list, so a custom choice answer renders the LABEL the
 *             patient tapped rather than its stored value, and so the scan below
 *             reads the same strings `admit` scans (ruling W3/3).
 */
export type CustomQuestionIndex = ReadonlyMap<
  string,
  {
    label: string;
    kind: TriageQuestionKind;
    type?: TriageFieldType;
    options?: readonly TriageOption[];
  }
>;

/**
 * What kind of question this stored answer was, across every source that knows.
 *
 * In order: the SHIPPED bank (in-code, and a shipped key's classification is not a
 * thing a database row may contradict), the kind STAMPED on the answer at submit,
 * the practice's CURRENT bank config, and — for a practice-written question only —
 * THE QUESTION'S OWN WORDS. If any of them says `symptom` the answer is `symptom`;
 * if none of them has an opinion at all the answer is UNKNOWN_ANSWER_KIND, which
 * is also `symptom`.
 *
 * ---------------------------------------------------------------------------
 * THE FOURTH OPINION, AND THE GAP IT CLOSES.
 * ---------------------------------------------------------------------------
 * `admit` in ./project.ts says it out loud: "a custom question the owner
 * classified as 'logistics' and wrote as 'Is anything hurting before you come in?'
 * is a symptom question whatever the dropdown said. The classification is the
 * owner's intent; this list is the check on it." That check ran on ONE FORK. It
 * sits behind `if (fork !== "brief") return null`, because on the brief bank the
 * consequence is contractual — an NHS-plan patient must not be ASKED — and on the
 * full bank there is nothing to refuse: the full bank exists to ask those
 * questions, and dropping it would be the wrong fix.
 *
 * But the classification feeds a SECOND consequence that is not fork-scoped at
 * all. It decides whether a patient's own words go on the screen the practice
 * manager reads (ruling W1-C/2). So on the full bank, a symptom question honestly
 * filed as logistics was admitted with no scan, resolved to logistics from all
 * three sources, and put "my back molar has been throbbing all week and the gum is
 * swollen" in the section the front desk reads — with `flaggedForClinician: 0`, so
 * the count that stands in for the words said there was nothing to read either.
 *
 * So the scan runs HERE too, where the consequence is, and it refuses nothing: it
 * only moves an answer into the restricted half. It reads exactly the strings
 * `admit` reads (the label and every option label and value — ruling W3/3), and
 * CUSTOM KEYS ONLY: a shipped question's kind is in-code and authoritative, and
 * running an over-broad word list over it could only re-classify the module's own
 * logistics questions against their own definition.
 *
 * TWO COSTS, BOTH ACCEPTED, and they are the costs this file already accepted for
 * the unknown-kind fallback. FORBIDDEN_IN_BRIEF is deliberately over-broad
 * ("problem", "issue", "trouble"), so a practice question like "Any problems with
 * parking?" is read as a symptom question and the manager sees a count instead of
 * the answer. And a question the practice has since DELETED has no label left to
 * scan, so the stamp written at submit is the last word for it — which is why the
 * submit route should stamp the RESOLVED kind rather than the projected one.
 */
export function resolveAnswerKind(
  answer: TriageAnswer,
  custom?: CustomQuestionIndex,
): TriageQuestionKind {
  const known: TriageQuestionKind[] = [];
  const shipped = TRIAGE_BANK_BY_KEY.get(answer.key);
  if (shipped) known.push(shipped.kind);
  // Runtime-checked even though the type says it is present: this value has been
  // through a jsonb column, and the type is a promise about our own code, not
  // about the row that comes back.
  if (isTriageQuestionKind(answer.kind)) known.push(answer.kind);
  const authored = custom?.get(answer.key);
  const authoredKind = authored?.kind;
  if (isTriageQuestionKind(authoredKind)) known.push(authoredKind);
  // The check on the owner's dropdown, custom questions only. See the note above.
  if (!shipped && authored && symptomTermIn(questionText(authored)) !== null) {
    known.push("symptom");
  }

  if (known.length === 0) return UNKNOWN_ANSWER_KIND;
  if (known.includes("symptom")) return "symptom";
  return known[0];
}

/**
 * Every string a practice-written question puts in front of a patient, joined.
 *
 * THE SAME LIST `admit` BUILDS, deliberately: the label, and every option label
 * and value. Joined with a newline rather than a space so two strings cannot form
 * a phrase across the join that neither one contains.
 */
function questionText(q: { label: string; options?: readonly TriageOption[] }): string {
  const parts = [q.label];
  for (const o of q.options ?? []) parts.push(o.label, o.value);
  return parts.join("\n");
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
const INTEREST_KEY_SET: ReadonlySet<string> = new Set<string>(
  INTEREST_TREATMENTS.map((t) => t.key as string),
);

/** The two answers the grid offers. "not_now" is a real answer, not a blank. */
const INTEREST_ANSWER_SET: ReadonlySet<string> = new Set<string>(["yes", "not_now"]);

/** One row of the treatment grid, as this module will trust it. */
export type StoredInterestRow = { treatment: InterestTreatmentKey; answer: InterestAnswer };

/**
 * The stored `interest` jsonb as grid rows this module will trust.
 *
 * THE SIBLING OF `readStoredAnswers`, AND IT EXISTS FOR THE SAME REASON. `interest`
 * is a jsonb column on `previsit_response`, and `rowToResponse` used to cast it
 * whole behind an `Array.isArray` check — so a null element, an element that was
 * not an object, a treatment key the catalogue does not have, or an answer that is
 * neither "yes" nor "not_now" all reached `projectSummary` claiming to be a row a
 * patient filled in. Three things came out of that: a clinician's summary naming a
 * treatment nobody offers ("veneers", "maybe"), the co-pilot's `previsit_summary`
 * tool handing the same pair to a model, and — for a null element — a TypeError
 * thrown out of a pure projection, past two callers that catch only the row read,
 * which takes down the record tab's server render rather than degrading.
 *
 * The submit route validates all of this on the way IN (`parseInterest`), so a row
 * like that has to come from a hand edit, a partial restore or a future writer.
 * That is exactly the argument `readStoredAnswers` was written against: the type is
 * a promise about our own code, not about the row that comes back.
 *
 * A ROW THAT CANNOT BE READ IS DROPPED, not repaired and not rendered raw. The two
 * columns disagree in strictness otherwise — `treatment_interest` carries a CHECK
 * on both of its columns and this copy of the same fact carries none — and a
 * treatment name a reader could act on is the wrong thing to guess at.
 */
export function readStoredInterest(raw: unknown): StoredInterestRow[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredInterestRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const treatment = typeof row.treatment === "string" ? row.treatment.trim() : "";
    const answer = typeof row.answer === "string" ? row.answer.trim() : "";
    if (!INTEREST_KEY_SET.has(treatment) || !INTEREST_ANSWER_SET.has(answer)) continue;
    out.push({
      treatment: treatment as InterestTreatmentKey,
      answer: answer as InterestAnswer,
    });
  }
  return out;
}

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
