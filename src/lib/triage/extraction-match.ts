// ===========================================================================
// "DID THIS APPOINTMENT INVOLVE AN EXTRACTION?"  PURE, no I/O.
//
// ---------------------------------------------------------------------------
// WHY THIS IS NOT `classifyProcedure` FROM src/lib/postop/flag.ts.
// ---------------------------------------------------------------------------
//
// That function answers a DIFFERENT question, and reusing it here would have been
// a quiet defect rather than a shortcut. It decides "should we text this patient
// an aftercare check tomorrow", so its `NOT_A_PROCEDURE` veto fires first and
// discards anything whose text contains consult, assess, review, plan, follow-up,
// scan, x-ray or cancel. That is exactly right for post-op: texting somebody about
// an extraction they only discussed would be alarming, and its own comment says it
// "errs quiet".
//
// This module answers "has this patient had a tooth out". A record reading
// "Extraction review" or "Post extraction follow-up" is EVIDENCE that an
// extraction happened, and the post-op veto throws it away. Borrowing the function
// would have produced a list that was silently short in a way nobody could see,
// on a screen whose whole job is to state honestly what it covers.
//
// So this file keeps post-op's extraction VOCABULARY (which is good, and hard won)
// and replaces its veto with a much narrower one: only text that says the
// extraction did NOT happen. The two files do not import each other, and that is
// deliberate — a shared list would drag one module's tuning into the other's the
// next time either is adjusted.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT.
// ---------------------------------------------------------------------------
// It is a REGEX OVER FREE TEXT A HUMAN TYPED INTO A DIARY. It will miss an
// extraction recorded as a bare code, and it will match a note about an
// extraction that was only ever discussed. It produces a list of PEOPLE WORTH
// ASKING, and every screen that renders that list says so in those words
// (MINING_CAVEATS). It is not a clinical record of extractions and it is not, in
// any sense, an assessment of who is suitable for an implant.
// ===========================================================================

/**
 * The extraction vocabulary. UK dental diary shorthand included, because that is
 * what is actually in the field: XLA, exo, "UR6 out".
 */
const EXTRACTION_PATTERNS: readonly RegExp[] = [
  /\bextraction(?:s)?\b/i,
  /\bextract(?:ed|ing|ion)?\b/i,
  /\bxla?\b/i,
  /\bexo\b/i,
  /\bsurgical removal\b/i,
  /\bremoval of (?:tooth|teeth|ur|ul|lr|ll)\b/i,
  /\b(?:tooth|teeth) (?:out|removed|extracted|taken out)\b/i,
  /\bwisdom (?:tooth|teeth)\b/i,
  /\bthird molar/i,
  /\bde-?coronat/i,
];

/**
 * The ONLY veto. Text that says the extraction did not happen.
 *
 * Deliberately tiny next to post-op's. "Review", "plan", "assessment" and
 * "consult" are all ABSENT, because in a mining context each of them is a
 * reference to an extraction that did happen, not a reason to discard the record.
 * What is here is the language of an extraction that was cancelled, declined,
 * deferred, or explicitly not carried out.
 *
 * `isAttendedState` on the appointment already excludes cancellations and
 * did-not-attends at the CALLER, so this list is the belt to that braces: a
 * completed appointment whose text says "extraction not done, patient declined"
 * must not put the patient on an implant list.
 */
const DID_NOT_HAPPEN: readonly RegExp[] = [
  /\bnot (?:done|carried out|completed|performed|proceed(?:ed|ing)?)\b/i,
  /\bno extraction\b/i,
  /\bdeclin(?:e|ed|ing)\b/i,
  /\bdeferred?\b/i,
  /\bpostponed?\b/i,
  /\bre-?scheduled?\b/i,
  /\bcancel(?:led|ed)?\b/i,
  /\bdid not attend\b/i,
  /\bdna\b/i,
  /\bfailed to attend\b/i,
  /\bavoid(?:ed|ing)? extraction\b/i,
  /\bsave the tooth\b/i,
  /\binstead of (?:an )?extraction\b/i,
];

export interface ExtractionMatch {
  /** The pattern text that matched, so a reader can see WHY a row is on the list. */
  matched: string;
  /** The sanitised source text, for the same reason. Never sent to a patient. */
  source: string;
}

/**
 * The first extraction term in this appointment's free text, or null.
 *
 * `reason` is the field that carries plain-English procedure text on
 * /v1/appointments; `treatment` is read defensively because some payloads carry
 * it and reading it costs nothing.
 *
 * THE TEXT IS SANITISED BEFORE IT IS STORED OR SHOWN. Dentally free text is data,
 * never instructions (the funding-jargon rule's sibling): it is used here as a
 * CATALOGUE LOOKUP KEY, the answer is this module's own vocabulary, and the
 * sanitised original is kept only so a person can see what produced the match.
 * Nothing from this field ever reaches a patient or a prompt.
 */
export function matchExtraction(input: {
  reason?: string | null;
  treatment?: string | null;
}): ExtractionMatch | null {
  const source = sanitiseFreeText(`${input.reason ?? ""} ${input.treatment ?? ""}`);
  if (source === "") return null;
  for (const veto of DID_NOT_HAPPEN) {
    if (veto.test(source)) return null;
  }
  for (const re of EXTRACTION_PATTERNS) {
    const m = re.exec(source);
    if (m) return { matched: m[0], source };
  }
  return null;
}

/**
 * Dentally free text, made safe to store and to print.
 *
 * Collapses whitespace, strips control characters and the characters that could
 * turn a stored string into structure somewhere else (angle brackets, braces,
 * backticks), and caps the length. The cap is the important one: this is a field a
 * human types into, and a 4,000-character paste belongs nowhere near a list view.
 */
export function sanitiseFreeText(raw: string, max = 160): string {
  return (raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[<>{}`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Whole years between a date of birth and an instant, or null when the date of
 * birth cannot be read.
 *
 * NULL IS NOT ZERO AND IT IS NOT "ADULT". A patient with no readable date of
 * birth is EXCLUDED from the candidate list and COUNTED as excluded, because the
 * owner's rule is "18 and over" and a patient whose age we do not know does not
 * satisfy it. The screen prints that count: a list that quietly dropped people
 * would be a list nobody could reconcile against the practice's own numbers.
 */
export function ageAt(dateOfBirth: string | null | undefined, at: Date): number | null {
  if (!dateOfBirth) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dob = new Date(Date.UTC(y, mo - 1, d));
  if (dob.getUTCFullYear() !== y || dob.getUTCMonth() !== mo - 1 || dob.getUTCDate() !== d) return null;
  let age = at.getUTCFullYear() - y;
  const beforeBirthday =
    at.getUTCMonth() < mo - 1 || (at.getUTCMonth() === mo - 1 && at.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/** The owner's rule, stated once. */
export const MINING_MIN_AGE = 18;
