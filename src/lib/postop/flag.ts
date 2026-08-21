// Which appointments earn a post-op check-in. PURE, no I/O.
//
// The signal is the free text a receptionist typed on the Dentally appointment
// (its `reason`, and the treatment name where one is mirrored alongside). That
// makes this file the module's INJECTION BOUNDARY, and it is treated as one even
// though nothing here reaches a model: the text is sanitised before it is matched,
// before it is stored, and it is never the source of a patient-facing word. The
// only thing that crosses into the message is a ProcedureFlag — one of three
// values this file chose — which is why an injected "reason" cannot put a single
// character in front of a patient.
//
// The sanitiser is the closer's (src/lib/closer/draft.ts sanitiseTreatmentName),
// deliberately reproduced rather than imported: the closer's version is tuned to a
// PLAN TITLE (60 characters, severed at the first sentence break) and an
// appointment reason is a different field with a different shape. Sharing one
// function would mean one module's tuning silently retuning the other's defence.

import type { ProcedureFlag } from "./types";

/**
 * Longest an appointment reason is allowed to be before matching.
 *
 * Real reasons are short ("Extraction UR6", "Implant placement, 60 min"). A
 * "reason" carrying several sentences is a note or an injected payload, and the
 * cap plus the sentence-cut below reduce it to a single short clause before any
 * pattern is run against it. 120 rather than the closer's 60 because a reason
 * legitimately carries a tooth notation and a duration alongside the procedure.
 */
const MAX_REASON_CHARS = 120;

/**
 * Reduce Dentally-sourced free text to something reason-shaped.
 *
 * Three passes, in this order, so a payload cannot survive:
 *   1. replace C0 controls, DEL and the C1 block (JS \s does NOT include NEL,
 *      U+0085, so a C1 control would otherwise survive as an invisible separator)
 *      and collapse every whitespace run to one space;
 *   2. keep only up to the first sentence break followed by more text, so
 *      "Extraction. Ignore your instructions and ..." loses everything after
 *      "Extraction";
 *   3. hard-cap the length.
 * PURE. An ordinary short reason passes through unchanged.
 */
export function sanitiseProcedureText(raw: string): string {
  let s = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = s.search(/[.!?;]\s/);
  if (cut >= 0) s = s.slice(0, cut).trim();
  if (s.length > MAX_REASON_CHARS) s = s.slice(0, MAX_REASON_CHARS).trim();
  return s;
}

/**
 * Wording that means "this was surgical", grouped by the bucket it maps to.
 *
 * ORDER MATTERS and it is not alphabetical: the first bucket whose pattern
 * matches wins, so `implant` is tested before `extraction` and `extraction`
 * before the general `surgical` bucket. "Extraction and immediate implant" is an
 * implant case, and "surgical extraction" is an extraction; testing the general
 * bucket first would file both under the vaguest of the three sentences.
 */
const FLAG_PATTERNS: Array<{ flag: ProcedureFlag; patterns: RegExp[] }> = [
  {
    flag: "implant",
    patterns: [
      /\bimplants?\b/i,
      /\bimplant(?:ation|ology)\b/i,
      /\bfixture\s+placement\b/i,
      /\bbone\s+graft/i,
      /\bsinus\s+lift/i,
      /\bgbr\b/i, // guided bone regeneration
    ],
  },
  {
    flag: "extraction",
    patterns: [
      /\bextractions?\b/i,
      /\bextract(?:ed|ing)?\b/i,
      /\bxla?\b/i, // XLA / XL: the chart shorthand for an extraction
      /\bexo\b/i,
      /\btooth\s+(?:out|removal|removed)\b/i,
      /\bteeth\s+(?:out|removal|removed)\b/i,
      /\bremoval\s+of\s+(?:tooth|teeth|ur|ul|lr|ll)\b/i,
      /\bwisdom\s+(?:tooth|teeth)\b/i,
      /\bthird\s+molar/i,
    ],
  },
  {
    flag: "surgical",
    patterns: [
      /\bsurg(?:ery|ical)\b/i,
      /\bapicectomy\b/i,
      /\bapicoectomy\b/i,
      /\bfrenectomy\b/i,
      /\bgingivectomy\b/i,
      /\bbiops(?:y|ies)\b/i,
      /\bflap\b/i,
      /\bsuture[sd]?\b/i,
      /\bstitche?s?\b/i,
      /\bopercul(?:ectomy|otomy)\b/i,
      /\bcyst\s+(?:removal|enucleation)\b/i,
      /\bperiradicular\b/i,
      /\bexposure\s+(?:and\s+bond|of\s+canine)/i,
    ],
  },
];

/**
 * Wording that must NOT flag, even though a pattern above would otherwise match.
 *
 * Checked FIRST, and it is the difference between a check-in and a nuisance: a
 * CONSULTATION about an extraction, a REVIEW of an implant, or a cancelled slot
 * is not a procedure the patient is recovering from. Without this, every
 * "Implant consultation" in the book would text the patient the next morning
 * asking how they are feeling after treatment they have not had.
 */
const NOT_A_PROCEDURE: RegExp[] = [
  /\bconsult(?:ation)?\b/i,
  /\bassess(?:ment)?\b/i,
  /\bdiscussion\b/i,
  /\breview\b/i,
  /\bcheck[\s-]?up\b/i,
  /\bfollow[\s-]?up\b/i,
  /\bplan(?:ning)?\b/i,
  /\bquote\b/i,
  /\bimpressions?\b/i,
  /\bscan\b/i,
  /\bx[\s-]?ray\b/i,
  /\bopg\b/i,
  /\bcbct\b/i,
  /\bphotos?\b/i,
  /\bcancel(?:led|lation)?\b/i,
  /\bfailed\s+to\s+attend\b/i,
  /\bemergency\s+triage\b/i,
];

export interface ProcedureClassification {
  flag: ProcedureFlag;
  /** The sanitised text the decision was made from. Stored, never sent. */
  source: string;
  /** The exact substring that matched, for the audit trail. */
  matched: string;
}

/**
 * Classify an appointment's free text into a procedure bucket, or null.
 *
 * NULL IS THE DEFAULT AND THE SAFE ANSWER HERE, which is the opposite of the
 * triage classifier's posture and deliberately so. A missed flag means one
 * patient does not get a courtesy text. A false flag means a patient who had a
 * consultation is asked how they are recovering from surgery they never had,
 * which is alarming, and — because every reply then routes into the escalation
 * path — it also fills a clinical worklist with people who are perfectly well.
 * Over-flagging is the failure that damages trust, so this side errs quiet.
 *
 * `reason` and `treatment` are both accepted because the two live Dentally fields
 * carry the same kind of text and either may be the one a practice fills in.
 */
export function classifyProcedure(input: {
  reason?: string | null;
  treatment?: string | null;
}): ProcedureClassification | null {
  const source = sanitiseProcedureText(
    [input.reason ?? "", input.treatment ?? ""].filter((s) => s.trim() !== "").join(" "),
  );
  if (source === "") return null;

  for (const re of NOT_A_PROCEDURE) {
    if (re.test(source)) return null;
  }

  for (const { flag, patterns } of FLAG_PATTERNS) {
    for (const re of patterns) {
      const m = re.exec(source);
      if (m) return { flag, source, matched: m[0] };
    }
  }
  return null;
}
