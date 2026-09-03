import type { Role } from "@/lib/types";
import { INTEREST_TREATMENTS, TRIAGE_BANK_BY_KEY, INTEREST_QUESTION_KEY } from "./bank";
import { FORK_LABEL, FORK_NOTE } from "./fork";
import { resolveAnswerKind } from "./kind";
import type { CustomQuestionIndex } from "./kind";
import { SCALE_MAX, SCALE_MIN } from "./types";
import type { TriageQuestionKind, TriageResponse } from "./types";

// ===========================================================================
// THE DENTIST'S PRE-VISIT SUMMARY: what the patient shared, structured.
//
// PURE. No I/O, no clock. It takes a stored response and a viewer's role and
// returns the sections to render, so the same projection can be asserted directly
// and cannot drift from what the screen shows.
//
// ===========================================================================
// WHO SEES WHAT, AND WHY THE PRACTICE MANAGER SEES A FLAG RATHER THAN THE WORDS.
// ===========================================================================
//
// Four roles can reach a patient record at all (the record is gated on the
// "patients" module, which `client_staff` does not hold): agency_admin,
// client_owner, client_coordinator and client_clinician.
//
// This module splits the summary in two:
//
//   LOGISTICS + INTEREST   are you coming, has your health changed, is there
//                          anything that would make the visit easier, what you
//                          would change about your smile, and the treatment grid.
//                          EVERY role that can open the record sees these.
//
//   WHAT THEY SAID ABOUT THEIR MOUTH   the reason for the visit, the concern in
//                          their own words, how long, the discomfort score,
//                          sensitivity, bleeding gums, chips and breaks, and how
//                          they feel about coming. CLINICIAN + OWNER + AGENCY.
//
// THE COORDINATOR IS NOT SHOWN NOTHING. They get a FLAG — "this patient answered
// the discomfort questions" — with a count and no content. That is the part of
// the decision worth defending, because both alternatives are worse:
//
//   Show them everything. The charter asked for logistics-only, and there is a
//   real difference between a record a coordinator reads BECAUSE they are booking
//   around it (the chart, the medical history — which they do read, deliberately;
//   see CLINICAL_WRITE_ROLES in src/lib/patient/roles.ts) and a free-text answer a
//   patient wrote in the belief that the person examining them would read it.
//
//   Show them nothing at all. Worse, and it is the option this file refuses. The
//   coordinator is the person who answers the phone, triages the day and decides
//   who gets the cancellation slot. A front desk that cannot tell that a patient
//   has reported discomfort will book them a fortnight out, and the practice will
//   have collected the information and then failed to act on it. That is a worse
//   outcome than either privacy position.
//
// So: the fact, not the words. `flaggedForClinician` is what the coordinator sees,
// and it is enough to pick up the phone and enough to escalate, and it carries no
// symptom the patient described.
//
// THIS IS A REVERSIBLE DECISION, ON PURPOSE. It is one constant —
// CLINICAL_SUMMARY_ROLES — and it is asserted by name in ./summary.test.ts, so
// widening or narrowing it is a one-line change with a test that says out loud
// what changed.
// ===========================================================================

/**
 * The roles that may read what the patient said about their mouth.
 *
 * CONFIRMED AS BUILT by the practice owner: the manager sees the COUNT and the
 * discomfort FLAG, never the words. The reasoning, on the record:
 *
 *   The coordinator's existing clinical read — the chart, the medical history —
 *   covers records the PRACTICE AUTHORED. A patient's own words about their own
 *   symptoms are more sensitive than that: they were written by the patient, to
 *   the person who would examine them, and nobody at the practice has checked
 *   them. And the manager's OPERATIONAL need is fully met without them: she needs
 *   to know there is something to read (the count) and whether to ring today
 *   rather than book a fortnight out (the flag), and she has both.
 *
 * Deliberately the SAME shape as CLINICAL_WRITE_ROLES (src/lib/patient/roles.ts)
 * and deliberately not imported from it: that list governs AUTHORSHIP of the
 * clinical record and this one governs READING one free-text answer. They agree
 * today by coincidence of reasoning, not by dependency, and folding them together
 * would mean a future change to who may chart a tooth silently changed who may
 * read a patient's own words.
 */
export const CLINICAL_SUMMARY_ROLES: readonly Role[] = [
  "agency_admin",
  "client_owner",
  "client_clinician",
] as const;

const CLINICAL_SET: ReadonlySet<string> = new Set<string>(CLINICAL_SUMMARY_ROLES);

/** True when this role may read the symptom half of a pre-visit summary. */
export function canReadClinicalSummary(role: string | null | undefined): boolean {
  // A NULL ROLE IS THE UNENFORCED PILOT (no service-role key, so no sessions), and
  // it resolves to TRUE to match every other guard in this codebase: requireUser,
  // requireClientAccess and requireModuleApiAccess are all no-ops with enforcement
  // off, and a projection that alone stayed shut would make the local build look
  // broken rather than safe. Enforcement turns on with the key, all at once.
  if (role === null || role === undefined) return true;
  return CLINICAL_SET.has(role);
}

/**
 * The practice's own questions, indexed by key. Re-exported from ./kind.ts, which
 * owns it, so a caller of `projectSummary` has one import rather than two.
 */
export type { CustomQuestionIndex };

/** One answer, ready to render. */
export interface SummaryLine {
  key: string;
  /** The question, as the patient read it. */
  question: string;
  /** The answer, as a reader should see it. Never the raw stored value. */
  answer: string;
  kind: TriageQuestionKind;
  /** True when the patient typed this themselves. The screen sets it in quotes. */
  freeText: boolean;
  /**
   * A number a reader should notice, 0-10, or null. Only the discomfort scale
   * sets it, and it is passed separately from `answer` so the screen can weight
   * it without parsing a string back into a number.
   */
  scale: number | null;
}

export interface SummarySection {
  title: string;
  lines: SummaryLine[];
}

export interface PreVisitSummary {
  responseId: string;
  submittedAt: string;
  /** Which list this patient was asked, in staff words. Never a funding word. */
  forkLabel: string;
  forkNote: string;
  /** Always shown, to every role that can open the record. */
  logistics: SummarySection;
  /** The treatment grid. Always shown. */
  interest: Array<{ treatment: string; label: string; answer: "yes" | "not_now" }>;
  /**
   * What the patient said about their mouth. NULL for a viewer who may not read
   * it — null rather than an empty section, so a screen cannot render an empty
   * heading that reads as "the patient said nothing".
   */
  clinical: SummarySection | null;
  /**
   * How many clinical answers exist, for EVERY viewer including one who may not
   * read them. This is the coordinator's flag: the fact, never the words.
   */
  flaggedForClinician: number;
  /**
   * True when the patient reported discomfort above the notice threshold. Shown to
   * every role, again as a fact with no content: it is the difference between
   * "book them in a fortnight" and "ring them today", which is a front-desk
   * decision and therefore front-desk information.
   *
   * It is NOT a clinical grading and this module never acts on it: nothing is sent
   * differently, nothing is escalated automatically, and no appointment moves. A
   * person reads it and decides.
   */
  discomfortReported: boolean;
}

/**
 * The threshold at which a discomfort score is surfaced as a flag.
 *
 * Seven, and it is a UI threshold rather than a clinical one. The scale's own
 * anchors are the patient's ("0 is completely fine, 10 is the worst you can
 * imagine"), so this says only "the patient put themselves near the top of their
 * own scale", which is a reason for a person to look. Nothing in this platform
 * treats it as a finding.
 */
export const DISCOMFORT_NOTICE_THRESHOLD = 7;

const DISCOMFORT_KEY = "pain-now";

/**
 * Project a stored response into the summary a viewer with this role may read.
 *
 * `customQuestions` supplies the practice's OWN questions — the ones written in
 * the owner editor, whose text lives in the bank config rather than in the shipped
 * bank. It is used for two different things and only one of them is cosmetic:
 *
 *   THE LABEL is cosmetic. A custom answer whose label cannot be resolved renders
 *   under its key rather than being dropped: an answer the patient gave must not
 *   disappear because the practice later deleted the question.
 *
 *   THE KIND IS NOT. It decides whether the patient's words go in the half the
 *   practice manager may read (ruling W1-C/2), so it is resolved by
 *   `resolveAnswerKind` across the shipped bank, the kind STAMPED ON THE ANSWER at
 *   submit, and this map — most restrictive wins, and an answer no source can name
 *   is `symptom`. That is why this argument is still OPTIONAL: omitting it can now
 *   only over-restrict, never under-restrict. It used to be the only source of a
 *   custom question's kind, no caller passed it, and the missing-kind fallback was
 *   `logistics` — so an owner-authored symptom question read out to the front desk.
 *
 * Server callers should prefer `previsitSummaryFor` (./summary-read.ts), which
 * resolves this map from the practice's saved banks so the labels are real.
 */
export function projectSummary(
  response: TriageResponse,
  viewerRole: Role | null,
  customQuestions: CustomQuestionIndex = new Map(),
): PreVisitSummary {
  const logistics: SummaryLine[] = [];
  const clinical: SummaryLine[] = [];

  for (const answer of response.answers) {
    if (answer.key === INTEREST_QUESTION_KEY) continue; // rendered by its own list
    const bank = TRIAGE_BANK_BY_KEY.get(answer.key);
    const custom = customQuestions.get(answer.key);
    const question = bank?.label ?? custom?.label ?? answer.key;
    const kind = resolveAnswerKind(answer, customQuestions);
    const type = bank?.type;
    const line: SummaryLine = {
      key: answer.key,
      question,
      answer: renderAnswer(answer.value, bank?.options),
      kind,
      freeText: type === "textarea" || type === "text" || !bank,
      scale: type === "scale" ? clampScale(answer.value) : null,
    };
    (kind === "symptom" ? clinical : logistics).push(line);
  }

  const discomfort = clinical.find((l) => l.key === DISCOMFORT_KEY)?.scale ?? null;
  const labelByKey = new Map(INTEREST_TREATMENTS.map((t) => [t.key as string, t.label]));

  return {
    responseId: response.id,
    submittedAt: response.submittedAt,
    forkLabel: FORK_LABEL[response.fork],
    forkNote: FORK_NOTE[response.fork],
    logistics: { title: "Before the visit", lines: logistics },
    interest: response.interest.map((row) => ({
      treatment: row.treatment,
      label: labelByKey.get(row.treatment) ?? row.treatment,
      answer: row.answer,
    })),
    clinical: canReadClinicalSummary(viewerRole)
      ? { title: "What they told us", lines: clinical }
      : null,
    flaggedForClinician: clinical.length,
    discomfortReported: discomfort !== null && discomfort >= DISCOMFORT_NOTICE_THRESHOLD,
  };
}

/**
 * The stored value as a reader should see it.
 *
 * A CHOICE answer renders its LABEL, not its value: "Something is bothering me",
 * never "something-bothering". A value the bank no longer offers renders raw
 * rather than being dropped, because what the patient chose is a fact even after
 * the practice has edited the question.
 */
function renderAnswer(value: string, options?: readonly { value: string; label: string }[]): string {
  const raw = (value ?? "").trim();
  if (raw === "") return "No answer";
  if (options) {
    const hit = options.find((o) => o.value === raw);
    if (hit) return hit.label;
  }
  if (raw === "yes") return "Yes";
  if (raw === "no") return "No";
  if (raw === "unsure" || raw === "unknown") return "Not sure";
  return raw;
}

function clampScale(value: string): number | null {
  const n = Number((value ?? "").trim());
  if (!Number.isFinite(n)) return null;
  if (n < SCALE_MIN || n > SCALE_MAX) return null;
  return Math.round(n);
}

/**
 * The line the screen prints above a summary. Kept here rather than in JSX
 * because it is a claim about what this record IS, and getting it wrong turns a
 * patient's phone answers into something a reader could mistake for a clinical
 * assessment.
 */
export const SUMMARY_COPY = {
  heading: "What the patient shared before this visit",
  provenance:
    "These are the patient's own answers, given on their phone before they came in. They have not been checked by anyone at the practice and they are not a clinical assessment.",
  /** For a viewer who may not read the clinical half. States the omission plainly. */
  restricted: (n: number) =>
    n === 1
      ? "The patient also answered one question about how they are feeling. A clinician can see what they said on this record."
      : `The patient also answered ${n} questions about how they are feeling. A clinician can see what they said on this record.`,
  /** The discomfort flag, for every role. A prompt to act, never a finding. */
  discomfort:
    "The patient rated their discomfort near the top of the scale. Worth a call before their appointment.",
  /** Nothing captured. Never phrased as a fact about the patient. */
  none:
    "No pre-visit answers have been captured for this patient. This is not a finding that they had nothing to tell us.",
  /** A read that failed. Explicitly not the same as "none captured". */
  readFailed:
    "This patient's pre-visit answers could not be read. This is a failure to read them, not a finding that there are none.",
} as const;
