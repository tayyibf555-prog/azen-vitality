import { TRIAGE_BANK_BY_KEY, defaultConfigFor, INTEREST_QUESTION_KEY } from "./bank";
import { fundingTermIn, symptomTermIn } from "./forbidden";
import type {
  TriageBankConfig,
  TriageCustomQuestion,
  TriageFork,
  TriageQuestion,
} from "./types";

// ===========================================================================
// THE PROJECTION: a saved config + a fork -> the questions the patient is asked.
//
// PURE. No I/O, no clock. The public form renders what this returns and the
// submit route validates against what this returns, so the rendered form and the
// accepted answers cannot diverge — the same arrangement onboarding's resolveSteps
// has with its submit route, and for the same reason.
//
// ===========================================================================
// THIS FUNCTION IS WHERE THE CONTRACTUAL RULE LIVES.
// ===========================================================================
//
// "An NHS-plan patient is never asked a pain / symptom / treatment-need question"
// is not enforced by the default brief bank. It is enforced HERE, on every
// question, on every projection, for three reasons that are each sufficient on
// their own:
//
//   1. The banks are EDITABLE. The owner editor can switch any bank question on
//      for either fork; a default that can be edited is a suggestion.
//   2. The owner can write CUSTOM questions, which no default covers at all, and
//      can classify one however they like from a dropdown.
//   3. The config is a jsonb column. A corrupted, hand-edited or partially-written
//      row must not be able to produce a symptom question on the brief bank
//      either.
//
// So the brief projection applies TWO independent filters and a question must
// clear both:
//
//   (a) `kind !== "symptom"` — the classification;
//   (b) no FORBIDDEN_IN_BRIEF term in the LABEL or the HELP — the check on the
//       classification, because a question written as "Is anything hurting?" and
//       filed as "logistics" is a symptom question whatever the dropdown said.
//
// Break either one and `brief-bank-has-no-symptom-questions` in ./project.test.ts
// goes red. They are not redundant: (a) catches an honestly-classified question
// switched on by mistake, (b) catches a dishonestly- or carelessly-classified one,
// and neither catches the other's case.
//
// THE FULL BANK GETS NO SYMPTOM FILTER AT ALL, deliberately. Its whole purpose is
// to ask those questions.
//
// ---------------------------------------------------------------------------
// THE OTHER FILTER, WHICH APPLIES TO BOTH BANKS: no funding words.
// ---------------------------------------------------------------------------
// A custom question is owner-written free text rendered to a patient, which makes
// it the one place in this module where the funding-jargon rule could be broken by
// a person rather than by a model. A custom question naming NHS, private, a band
// or a payment plan is dropped from BOTH banks.
// ===========================================================================

/** A question as it will actually be rendered, with its required flag resolved. */
export interface ProjectedQuestion {
  key: string;
  label: string;
  type: TriageQuestion["type"];
  kind: TriageQuestion["kind"];
  options?: readonly { value: string; label: string }[];
  help?: string;
  required: boolean;
  /** True for a question the practice wrote itself. The form renders it the same. */
  custom: boolean;
}

/** Why a question the config named did not make it onto the form. */
export interface DroppedQuestion {
  key: string;
  label: string;
  reason: "unknown-key" | "symptom-on-brief" | "funding-word" | "malformed";
  /** The exact term that blocked it, where a term did. Shown to the owner. */
  matched: string | null;
}

export interface ProjectedBank {
  fork: TriageFork;
  questions: ProjectedQuestion[];
  /**
   * What was refused and why, so the OWNER EDITOR can say "this question is not
   * being asked, and here is the word that stopped it" instead of silently
   * showing a shorter form than the owner configured.
   *
   * A silent drop is how a guard gets reported as a bug and then removed. A drop
   * that explains itself gets the question rewritten.
   */
  dropped: DroppedQuestion[];
}

const MAX_QUESTIONS = 30;
const MAX_LABEL = 200;
const MAX_HELP = 300;

/**
 * The questions a patient on `fork` is asked, given the practice's saved config.
 *
 * A null / empty config falls back to this fork's shipped defaults, so a practice
 * that has never opened the editor gets the lists as designed.
 */
export function projectBank(
  fork: TriageFork,
  saved: TriageBankConfig | null | undefined,
): ProjectedBank {
  const config = usableConfig(fork, saved);
  const questions: ProjectedQuestion[] = [];
  const dropped: DroppedQuestion[] = [];
  const seen = new Set<string>();

  for (const key of config.enabledKeys) {
    if (typeof key !== "string" || seen.has(key)) continue;
    seen.add(key);
    const q = TRIAGE_BANK_BY_KEY.get(key);
    if (!q) {
      dropped.push({ key, label: "", reason: "unknown-key", matched: null });
      continue;
    }
    const verdict = admit(fork, q.kind, q.label, q.help ?? "");
    if (verdict) {
      dropped.push({ key, label: q.label, reason: verdict.reason, matched: verdict.matched });
      continue;
    }
    questions.push({
      key: q.key,
      label: q.label,
      type: q.type,
      kind: q.kind,
      options: q.options,
      help: q.help,
      required: q.requirable ? config.required[q.key] === true : false,
      custom: false,
    });
  }

  for (const c of config.custom) {
    const parsed = usableCustom(c);
    if (!parsed) {
      dropped.push({
        key: typeof c?.key === "string" ? c.key : "",
        label: typeof c?.label === "string" ? c.label.slice(0, MAX_LABEL) : "",
        reason: "malformed",
        matched: null,
      });
      continue;
    }
    if (seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    const verdict = admit(fork, parsed.kind, parsed.label, "");
    if (verdict) {
      dropped.push({ key: parsed.key, label: parsed.label, reason: verdict.reason, matched: verdict.matched });
      continue;
    }
    questions.push({
      key: parsed.key,
      label: parsed.label,
      type: parsed.type,
      kind: parsed.kind,
      options: parsed.options,
      required: parsed.required,
      custom: true,
    });
  }

  return { fork, questions: questions.slice(0, MAX_QUESTIONS), dropped };
}

/**
 * THE ADMISSION RULE, in one place, applied identically to bank and custom
 * questions.
 *
 * Returns null to admit, or the reason to refuse. Written as one function rather
 * than inlined twice because the bank path and the custom path diverging is
 * exactly how a custom question would end up on the brief bank.
 */
function admit(
  fork: TriageFork,
  kind: TriageQuestion["kind"],
  label: string,
  help: string,
): { reason: DroppedQuestion["reason"]; matched: string } | null {
  // BOTH banks: no funding word reaches a patient, ever.
  const funding = fundingTermIn(label) ?? fundingTermIn(help);
  if (funding) return { reason: "funding-word", matched: funding };

  if (fork !== "brief") return null;

  // (a) the classification.
  if (kind === "symptom") return { reason: "symptom-on-brief", matched: kind };
  // (b) the check on the classification.
  const term = symptomTermIn(label) ?? symptomTermIn(help);
  if (term) return { reason: "symptom-on-brief", matched: term };
  return null;
}

/**
 * Coerce a stored jsonb blob into a usable config, falling back to the fork's
 * defaults when there is nothing usable.
 *
 * A PARTIAL row falls back rather than being repaired: a config whose
 * `enabledKeys` array did not survive a write is not a practice that wants no
 * questions, it is a broken row, and rendering an empty form off it would look
 * exactly like a working one.
 */
export function usableConfig(
  fork: TriageFork,
  raw: unknown,
): TriageBankConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!obj) return defaultConfigFor(fork);
  const enabledKeys = Array.isArray(obj.enabledKeys)
    ? obj.enabledKeys.filter((k): k is string => typeof k === "string")
    : null;
  if (!enabledKeys || enabledKeys.length === 0) return defaultConfigFor(fork);

  const required: Record<string, boolean> = {};
  if (obj.required && typeof obj.required === "object" && !Array.isArray(obj.required)) {
    for (const [k, v] of Object.entries(obj.required as Record<string, unknown>)) {
      if (v === true) required[k] = true;
    }
  }
  const custom = Array.isArray(obj.custom)
    ? (obj.custom.filter((c) => !!c && typeof c === "object") as TriageCustomQuestion[])
    : [];
  return { enabledKeys, required, custom };
}

const CUSTOM_TYPES: readonly TriageQuestion["type"][] = ["text", "textarea", "choice", "yesno", "scale"];
const CUSTOM_KINDS: readonly TriageQuestion["kind"][] = ["symptom", "logistics", "cosmetic"];

/**
 * One custom question, validated. Null when it is not usable at all.
 *
 * `interest` is NOT an allowed custom type or kind: the grid is one fixed
 * question with one fixed renderer and one storage table, and a second "interest"
 * question would write nothing anywhere. A custom SCALE is allowed and is always
 * 0-10, because that is the only scale this module renders.
 */
export function usableCustom(raw: unknown): TriageCustomQuestion | null {
  const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!c) return null;
  const key = typeof c.key === "string" ? c.key.trim() : "";
  // The prefix is what makes a collision with a bank key impossible, so it is
  // required rather than added: a custom question that arrived without it is a
  // question from somewhere this code does not understand.
  if (!key.startsWith("custom-") || key.length < 8 || key.length > 64) return null;
  if (!/^custom-[a-z0-9-]+$/.test(key)) return null;
  const label = typeof c.label === "string" ? c.label.replace(/\s+/g, " ").trim() : "";
  if (label.length === 0 || label.length > MAX_LABEL) return null;
  const type = c.type as TriageQuestion["type"];
  if (!CUSTOM_TYPES.includes(type)) return null;
  const kind = c.kind as TriageQuestion["kind"];
  if (!CUSTOM_KINDS.includes(kind)) return null;

  let options: { value: string; label: string }[] | undefined;
  if (type === "choice") {
    const raws = Array.isArray(c.options) ? c.options : [];
    options = [];
    for (const o of raws.slice(0, 12)) {
      const oo = o && typeof o === "object" ? (o as Record<string, unknown>) : null;
      const value = oo && typeof oo.value === "string" ? oo.value.trim() : "";
      const optLabel = oo && typeof oo.label === "string" ? oo.label.trim() : "";
      if (!value || !optLabel || optLabel.length > MAX_HELP) continue;
      options.push({ value, label: optLabel });
    }
    // A choice question with nothing to choose is not a question.
    if (options.length < 2) return null;
  }

  return {
    key,
    label,
    type,
    kind,
    options,
    // Free text is never required, for the reason stated on TriageQuestion.
    required: (type === "text" || type === "textarea") ? false : c.required === true,
  };
}

/** The interest question, if this projection includes it. */
export function interestQuestion(bank: ProjectedBank): ProjectedQuestion | null {
  return bank.questions.find((q) => q.key === INTEREST_QUESTION_KEY) ?? null;
}
