// ===========================================================================
// TWO FORBIDDEN-TERM LISTS, AND THEY GUARD TWO DIFFERENT THINGS.
//
// PURE. No I/O. Both lists are applied by ./project.ts (to questions) and by
// ./copy.ts (to the outbound message), and both are asserted directly by tests
// rather than only through their callers.
// ===========================================================================

/**
 * 1. THE SYMPTOM LIST: what may never be ASKED on the brief bank.
 *
 * The brief bank exists because an NHS-plan patient must not be asked a pain /
 * symptom / treatment-need question before their visit — asking is what creates
 * the contractual obligation. The DEFAULT brief bank contains no such question,
 * but a default is not a guard: the bank is editable, so an owner could switch a
 * symptom question on, or write a custom one, or a corrupted config row could
 * name one. Every route into the brief bank runs through `projectBank`, and
 * `projectBank` drops anything that matches this list.
 *
 * IT SCANS THE LABEL, NOT ONLY THE `kind` FIELD, and that is the point. A custom
 * question the owner classified as "logistics" and wrote as "Is anything hurting
 * before you come in?" is a symptom question whatever the dropdown said. The
 * classification is the owner's intent; this list is the check on it.
 *
 * DELIBERATELY OVER-BROAD. A false positive costs the practice one question it
 * could have asked and which it can rephrase; a false negative costs it a course
 * of treatment it did not price. Words like "problem", "worry" and "trouble" are
 * in because "any problems with your teeth?" is a symptom question wearing a
 * friendly coat.
 *
 * Word-boundary anchored so "painting" does not match "pain" and "broken
 * appointment" does not match "broken"… except that "broken appointment" SHOULD
 * be caught by a list this conservative, and is: see the note on the veto in
 * project.ts, where a match is reported to the editor rather than swallowed, so
 * the owner is told exactly which word blocked their question and can rewrite it.
 */
export const FORBIDDEN_IN_BRIEF: readonly RegExp[] = [
  // Pain and discomfort, in every register a form might use.
  /\bpain(?:ful|s)?\b/i,
  /\bhurt(?:s|ing)?\b/i,
  /\bache(?:s|ing)?\b/i,
  /\baching\b/i,
  /\bsore(?:ness)?\b/i,
  /\bdiscomfort\b/i,
  /\btender(?:ness)?\b/i,
  /\bthrob(?:s|bing)?\b/i,
  /\bsensitiv(?:e|ity)\b/i,
  /\btwinge/i,

  // Signs a patient would report.
  /\bbleed(?:s|ing)?\b/i,
  /\bswell(?:ing|s|ed)?\b/i,
  /\bswollen\b/i,
  /\bulcer/i,
  /\babscess/i,
  /\binfect(?:ion|ed)\b/i,
  /\bpus\b/i,
  /\blump\b/i,
  /\bnumb(?:ness)?\b/i,
  /\bwobbl(?:y|e|ing)\b/i,
  /\bloose\b/i,
  /\bbad breath\b/i,
  /\bhalitosis\b/i,

  // Damage and decay.
  /\bchip(?:ped|s)?\b/i,
  /\bbroke(?:n)?\b/i,
  /\bcrack(?:ed|s)?\b/i,
  /\bdecay(?:ed)?\b/i,
  /\bcavit(?:y|ies)\b/i,
  /\bhole\b/i,
  /\bfell out\b/i,
  /\bfall(?:en|ing)? out\b/i,
  /\bmissing tooth\b/i,
  /\bmissing teeth\b/i,

  // "What is wrong" in all its polite forms.
  /\bsymptom/i,
  /\bproblem(?:s)?\b/i,
  /\bissue(?:s)?\b/i,
  /\btrouble(?:d|s)?\b/i,
  /\bcomplain(?:t|ts|ing)?\b/i,
  /\bconcern(?:s|ed)?\b/i,
  /\bworr(?:y|ied|ies)\b/i,
  /\bwrong\b/i,
  /\bbother(?:ing|s|ed)?\b/i,
  /\bnot right\b/i,
  /\banything up\b/i,

  // Treatment NEED, as opposed to treatment interest. "Would you like to hear
  // about whitening" is fine for everybody; "do you need a filling" is not.
  //
  // ANCHORED ON THE OBJECT, NOT ON THE WORD "need", and this is the one place in
  // this file where over-breadth was actually wrong rather than merely cautious. A
  // bare /\bneed\b/ reads as conservative and is not: it blocks "if you need a
  // different time, tell us here" and "needing someone with you", which are the
  // practice's own LOGISTICS copy and exactly what the short list is for. A list
  // that refuses the questions the short bank exists to ask is not a strict guard,
  // it is a broken one, and the pressure to relax it would fall on the whole list.
  //
  // The genuinely dangerous form is need + a clinical object, and it is caught
  // twice over: here, and by the bare treatment words below, which are refused on
  // their own whatever verb precedes them.
  /\bneed(?:s|ed|ing)? (?:any |some |a |an |the |more )?(?:treatment|work|dental work|attention|seeing|looking at|sorting|fixing|doing|done)\b/i,
  /\bneed to be seen\b/i,
  /\brequire(?:s|d)? (?:any |some )?(?:treatment|work|attention)\b/i,
  /\bemergenc(?:y|ies)\b/i,
  /\burgent(?:ly)?\b/i,
  /\bfilling(?:s)?\b/i,
  /\bextraction(?:s)?\b/i,
  /\broot canal\b/i,
  /\bdenture(?:s)?\b/i,
  /\bcrown(?:s)?\b/i,
  /\bdiagnos/i,
  /\btreatment (?:you|they) (?:need|require)/i,
];

/**
 * 2. THE FUNDING LIST: what may never appear in ANYTHING a patient reads.
 *
 * PRODUCT.md's rule, applied to this module's own strings rather than only to
 * agent output. `checkAgentReply` (src/lib/agent/guardrail.ts) already enforces
 * the same rule on messages, and ./copy.ts calls it; this list additionally
 * covers question labels, help text, interest blurbs and every screen the patient
 * sees, which no agent guardrail ever looks at.
 *
 * Narrower than the guardrail's on purpose: it is applied to hand-written form
 * copy and to owner-written custom questions, not to model output, so it catches
 * the funding vocabulary itself rather than trying to catch a model's paraphrase.
 */
export const FORBIDDEN_PATIENT_WORDS: readonly RegExp[] = [
  /\bnhs\b/i,
  /\bprivate(?:ly)?\b/i,
  /\bband [123]\b/i,
  /\bfunding\b/i,
  /\bpayment plan\b/i,
  /\bexempt(?:ion)?\b/i,
  /\bfee scale\b/i,
];

/**
 * The first symptom term in `text`, or null. Returned rather than a boolean so
 * the editor can tell the owner WHICH word blocked their question — a refusal
 * that names its reason gets rewritten; a silent drop gets reported as a bug.
 */
export function symptomTermIn(text: string): string | null {
  return firstMatch(text, FORBIDDEN_IN_BRIEF);
}

/** The first funding term in `text`, or null. Same reasoning as symptomTermIn. */
export function fundingTermIn(text: string): string | null {
  return firstMatch(text, FORBIDDEN_PATIENT_WORDS);
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  const value = text ?? "";
  if (value.trim() === "") return null;
  for (const re of patterns) {
    const m = re.exec(value);
    if (m) return m[0];
  }
  return null;
}
