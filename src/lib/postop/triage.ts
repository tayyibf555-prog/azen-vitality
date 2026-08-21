// THE SYMPTOM CLASSIFIER. Pure, no I/O, and the single most safety-critical
// function in this module.
//
// ===========================================================================
// IT IS AN ALLOW-LIST, NOT A DENY-LIST, AND THAT IS THE WHOLE DESIGN.
// ===========================================================================
//
// The obvious way to build this is a list of symptom words: pain, swelling,
// bleeding, and escalate on a hit. That design fails open, and it fails open on
// exactly the messages that matter most. "My face has ballooned", "I've not slept
// a wink", "it's killing me", "mi fa molto male", "😭😭" — none of them contain a
// listed symptom word, and a deny-list would answer "no symptoms found" and hand
// the conversation to a booking agent.
//
// So the polarity is inverted. NOTHING escalates by exception; everything
// escalates by default, and a reply leaves this function as an all-clear ONLY if
// it survives every one of the following:
//
//   1. it is readable at all (not empty, not media-only, not emoji-only, written
//      in the Latin script we can actually assess);
//   2. it is short enough to be an all-clear;
//   3. it asks us nothing;
//   4. it contains no concern signal of any kind;
//   5. EVERY word in it is on a short allow-list of benign words; and
//   6. at least one of those words is a positive ("fine", "good", "healing").
//
// Rule 5 is the one that carries the weight. A message this module has never seen
// the vocabulary of cannot pass, whatever it says, which is why an unlisted
// symptom, a foreign language written in Latin letters, a typo, or a sentence
// about something else entirely all come out as `escalate`. The deny-lists below
// exist ON TOP of that, and they buy exactly one thing: a better REASON on the
// task a human picks up. They are not what makes this safe.
//
// THE COST, STATED RATHER THAN HIDDEN. This over-escalates. "No pain at all
// thanks" escalates, because `pain` is a concern token and this function will not
// try to parse the negation of a symptom. So does "much better thanks", because
// `better` implies there was something to be better than. Both produce a phone
// call to a patient who is fine. That is the trade this module is FOR: of the two
// errors available, one costs the practice two minutes and the other is a patient
// with a spreading infection being told by software that they sound fine.
//
// NOTHING HERE PRODUCES TEXT. The verdict selects one of two fixed sentences in
// copy.ts. There is no branch, in this file or any file it can reach, that can
// tell a patient what their symptom means, what to take for it, or that it is
// normal.

/** What the practice does next. Two outcomes, and only one of them is quiet. */
export type TriageOutcome = "escalate" | "all_clear";

/**
 * Why a reply escalated. This is the label on the task a human picks up, NOT a
 * severity grade: grading how serious a symptom is would be the clinical
 * judgement this module exists to avoid making. Every escalation is urgent.
 */
export type EscalationReason =
  /** A named symptom, a body-part complaint, or a medication word. */
  | "symptom"
  /** Distress, a negation, worsening, or an urgency word. */
  | "distress"
  /** The patient asked us something. Answering it would be advice. */
  | "question"
  /** They sent a photo. Somebody has to look at it. */
  | "media"
  /** Nothing assessable: empty, emoji-only, or not in a script we can read. */
  | "unreadable"
  /** Readable, and not positively an all-clear. The default. */
  | "ambiguous"
  /** Longer than an all-clear can be. */
  | "too_long";

export interface TriageVerdict {
  outcome: TriageOutcome;
  /** Null only on an all-clear. */
  reason: EscalationReason | null;
  /** The evidence, for the task row. Never shown to the patient. */
  matched: string | null;
  /**
   * Always true for an escalation. A constant rather than a computed field, so
   * there is no code path that can decide a symptom is "not urgent enough".
   */
  urgent: boolean;
}

/**
 * The placeholder the Twilio inbound webhook substitutes for a message that
 * carried media and no text. A photo of a healing socket is a clinical image and
 * only a person may look at it.
 */
export const MEDIA_PLACEHOLDER = "[Patient sent a photo or attachment]";

/**
 * Longest a reply can be and still be read as an all-clear.
 *
 * "All good thanks" is 14 characters. Somebody writing 200 characters is telling
 * us something, and a long message that happens to use only benign words (a
 * rambling thank-you that mentions a symptom in passing) must not slip through on
 * vocabulary alone.
 */
const MAX_ALL_CLEAR_CHARS = 90;

// ---------------------------------------------------------------------------
// 1. Normalisation.
// ---------------------------------------------------------------------------

/**
 * Strip C0/DEL/C1 controls and zero-width characters, collapse whitespace, lower
 * case. The zero-width strip matters: the four letters of "pain" with a U+200C
 * zero-width non-joiner between each pair read as "pain" to a human and defeat a
 * word-boundary pattern, so the whole U+200B..U+200F block plus U+2060 and the BOM
 * are removed before anything is matched.
 */
function normalise(raw: string): string {
  return (raw ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    // Curly apostrophes to straight ones. Every iPhone in the country sends
    // "I\u2019m fine"; without this the token is not the one the allow-list holds and a
    // perfectly clear all-clear escalates as ambiguous.
    .replace(/[\u2018\u2019\u201b\u00b4`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Any letter from a script other than Latin. A reply we cannot read is a reply we
 *  cannot clear, so Arabic, Cyrillic, CJK, Devanagari and the rest all escalate. */
const NON_LATIN_LETTER = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/** At least one Latin letter: otherwise there is no text here to assess. */
const HAS_LATIN_LETTER = /\p{Script=Latin}/u;

// ---------------------------------------------------------------------------
// 2. The deny-lists. These do not make the function safe (the allow-list does);
//    they make the ESCALATION REASON useful to the person who picks up the task.
// ---------------------------------------------------------------------------

/** Named symptoms, body-part complaints, and medication words. */
const SYMPTOM_PATTERNS: RegExp[] = [
  // Pain.
  /\bpain(?:ful|s)?\b/,
  /\bhurt(?:s|ing)?\b/,
  /\bsore(?:ness)?\b/,
  /\bach(?:e|es|ing|y)\b/,
  /\bagony\b/,
  /\bthrob(?:s|bing)?\b/,
  /\bkilling me\b/,
  /\bexcruciating\b/,
  /\btender(?:ness)?\b/,
  /\bsensitiv(?:e|ity)\b/,
  /\bsting(?:s|ing)\b/,
  /\bburn(?:s|ing)\b/,
  /\bsharp\b/,
  /\bdiscomfort\b/,
  /\buncomfortable\b/,
  // Swelling.
  /\bswell(?:s|ing|ed)?\b/,
  /\bswollen\b/,
  /\bpuff(?:y|ed)\b/,
  /\bballoon(?:ed|ing)?\b/,
  /\binflam(?:ed|mation)\b/,
  /\blump\b/,
  /\bbump\b/,
  // Bleeding.
  /\bbleed(?:s|ing)?\b/,
  /\bbled\b/,
  /\bblood(?:y)?\b/,
  /\bclot(?:s|ting)?\b/,
  /\boozing\b/,
  /\bseeping\b/,
  /\bweeping\b/,
  /\bgushing\b/,
  /\bsocket\b/,
  // Numbness.
  /\bnumb(?:ness)?\b/,
  /\btingl(?:e|es|ing)\b/,
  /\bpins and needles\b/,
  /\b(?:can'?t|cannot|cant) feel\b/,
  /\bno feeling\b/,
  /\bstill frozen\b/,
  /\bdead\b/,
  // Fever and infection.
  /\bfever(?:ish)?\b/,
  /\btemperature\b/,
  /\bchills?\b/,
  /\bshiver(?:s|ing)?\b/,
  /\bsweat(?:s|ing|y)?\b/,
  /\bunwell\b/,
  /\bpoorly\b/,
  /\bill\b/,
  /\bsick(?:ly)?\b/,
  /\bnause(?:a|ous)\b/,
  /\bvomit(?:ed|ing)?\b/,
  /\bthrow(?:ing)? up\b/,
  /\binfect(?:ed|ion)\b/,
  /\bpus\b/,
  /\babscess\b/,
  /\bsmell(?:s|y|ing)?\b/,
  /\btaste[sd]?\b/,
  /\bfoul\b/,
  // Function.
  /\b(?:can'?t|cannot|cant) (?:eat|sleep|open|close|chew|drink|swallow|talk|speak)\b/,
  /\bstruggl(?:e|es|ing)\b/,
  /\block ?jaw\b/,
  /\bjaw (?:stuck|locked)\b/,
  /\bbreath(?:e|ing)\b/,
  // Structural.
  /\bstitch(?:es)?\b/,
  /\bsuture[sd]?\b/,
  /\bcame (?:out|off|away)\b/,
  /\bfell (?:out|off)\b/,
  /\bfall(?:en|ing)? out\b/,
  /\bloose\b/,
  /\bwobbl(?:e|y|ing)\b/,
  /\bdry socket\b/,
  /\bhole\b/,
  /\bcrack(?:ed)?\b/,
  /\bchip(?:ped)?\b/,
  /\bbroke(?:n)?\b/,
  /\bsplinter\b/,
  /\bfragment\b/,
  /\bsharp bit\b/,
  // Medication. Answering any of these is a dosage conversation.
  /\bpainkiller(?:s)?\b/,
  /\bibuprofen\b/,
  /\bparacetamol\b/,
  /\bnurofen\b/,
  /\bcalpol\b/,
  /\bcodeine\b/,
  /\bco-?codamol\b/,
  /\baspirin\b/,
  /\bantibiotic(?:s)?\b/,
  /\bamoxicillin\b/,
  /\bmetronidazole\b/,
  /\bmedication\b/,
  /\btablets?\b/,
  /\bdosages?\b/,
  /\bmouthwash\b/,
  /\bsalt ?water\b/,
  /\bcorsodyl\b/,
];

/** Distress, negation, worsening, urgency. Not a symptom name, but never quiet. */
const DISTRESS_PATTERNS: RegExp[] = [
  /\bnot (?:great|good|ok|okay|right|well|brilliant|brill|fine|so good|too good|the best)\b/,
  /\bno better\b/,
  /\bnot (?:any |much |really )?better\b/,
  /\bwors(?:e|ening|ened)\b/,
  /\bgetting worse\b/,
  /\bterrible\b/,
  /\bawful\b/,
  /\bhorrible\b/,
  /\bhorrid\b/,
  /\brough\b/,
  /\bgrim\b/,
  /\bmiserable\b/,
  /\bunbearable\b/,
  /\bnightmare\b/,
  /\bworr(?:y|ied|ying|ies)\b/,
  /\bconcerned\b/,
  /\bscared\b/,
  /\bfrightened\b/,
  /\bpanic(?:king)?\b/,
  /\bhelp\b/,
  /\burgent(?:ly)?\b/,
  /\bemergency\b/,
  /\basap\b/,
  /\ba ?& ?e\b/,
  /\bhospital\b/,
  /\bwalk[- ]?in\b/,
  /\b111\b/,
  /\b999\b/,
  /\bout of hours\b/,
  /\bbad\b/,
  /\bnot happy\b/,
  /\bcomplain(?:t|ts|ing)?\b/,
  /\bsomething(?:'s| is)? (?:wrong|not right)\b/,
  // `problem` and `issue` NOT as bare words: "no problems thanks" is an all-clear
  // and this gate runs before the allow-list, so a bare pattern would escalate the
  // most common good-news reply there is. Only the non-negated shapes appear here;
  // the negated ones are handled by NEGATED_CONCERN at gate 7.
  /\b(?:having|had|got|getting|some|a few|few|lots of|loads of|major|real|big|slight) (?:problems?|issues?)\b/,
  /\bproblems? with\b/,
  /\bissues? with\b/,
];

/**
 * Distress emoji. A patient who answers "how are you feeling" with 😭 has told us
 * something, and no words are needed to know it is not "fine".
 *
 * Listed as characters rather than a Unicode range on purpose: a range would also
 * catch 😀 and 🎉, and the point of this list is that it names a MEANING.
 */
const DISTRESS_EMOJI = [
  "😭", "😢", "😥", "😰", "😨", "😱", "😖", "😣", "😫", "😩", "😞", "😔", "🙁", "☹", "😟",
  "🤒", "🤕", "🥵", "🥶", "🤢", "🤮", "😷", "🩸", "💉", "🚑", "🏥", "😵", "🥴", "😪", "👎",
];

/**
 * A question, with or without a question mark.
 *
 * "Is this normal" is the single most common post-op reply there is, and it is the
 * exact thing this module must not answer: every honest answer to it is clinical
 * advice about a specific patient's specific mouth.
 */
const QUESTION_PATTERNS: RegExp[] = [
  /\?/,
  /\bis (?:this|that|it|they|these|my|the) [a-z ]*\bnormal\b/,
  /\b(?:is|are) (?:this|that|it|they|these) (?:normal|ok|okay|right|alright|fine|expected|usual|meant to)\b/,
  /\bnormal\b/,
  /\bshould i\b/,
  /\bshould it\b/,
  /\bcan i\b/,
  /\bcould i\b/,
  /\bdo i (?:need|have to)\b/,
  /\bis it (?:worth|possible)\b/,
  /\bhow (?:long|much|often|do|should|can|many)\b/,
  /\bwhat (?:should|do|is|are|can|happens)\b/,
  /\bwhen (?:can|should|will|do|does)\b/,
  /\bwhy (?:is|are|do|does|am|has)\b/,
  /\bwonder(?:ed|ing)\b/,
  /\bjust checking\b/,
  /\bquick question\b/,
  /\bany advice\b/,
  /\blet me know\b/,
  /\bring me\b/,
  /\bcall me\b/,
  /\bcome in\b/,
  /\bappointment\b/,
];

// ---------------------------------------------------------------------------
// 3. The allow-list. This is what actually makes the function fail safe.
// ---------------------------------------------------------------------------

/**
 * A word that, on its own, says the patient is fine. An all-clear must contain at
 * least one of these; without the requirement, "no thanks" and "hi" would clear.
 *
 * `better` is deliberately ABSENT. "Much better thanks" is probably fine and
 * "no better" certainly is not, and this function does not attempt to tell them
 * apart: the first escalates as ambiguous and somebody spends two minutes on the
 * phone with a patient who is recovering well.
 */
const POSITIVE_CORE = new Set([
  "ok", "okay", "okey", "oki", "kk",
  "fine", "good", "great", "grand", "well", "alright", "allright", "alrite", "aight",
  "healing", "healed", "nicely", "smooth", "smoothly", "sorted", "settled", "settling",
  "perfect", "perfectly", "brilliant", "brill", "lovely", "fab", "fantastic",
  "excellent", "wonderful", "champion", "peachy", "tip-top", "dandy",
]);

/**
 * Words that may appear alongside a positive without changing what it means:
 * greetings, glue, intensifiers and thanks. Anything NOT in this set or in
 * POSITIVE_CORE makes the reply ambiguous, which is the default escalation.
 */
const FILLER = new Set([
  // Greetings and sign-offs.
  "hi", "hiya", "hello", "hey", "heya", "morning", "afternoon", "evening", "night",
  "thanks", "thank", "thankyou", "thanx", "thx", "ty", "ta", "cheers", "appreciate",
  "appreciated", "much", "you", "u", "team", "guys", "all", "everyone", "doc", "dr",
  "x", "xx", "xxx", "xoxo",
  // Glue.
  "i", "im", "i'm", "iam", "i've", "ive", "is", "it", "it's", "its", "am", "are",
  "was", "been", "being", "be", "the", "a", "an", "my", "me", "mine", "and", "so",
  "far", "very", "really", "quite", "pretty", "just", "still", "now", "today",
  "yesterday", "everything", "thing", "things", "feel", "feels", "feeling", "felt",
  "doing", "going", "goes", "went", "seem", "seems", "seemed", "look", "looks",
  "getting", "got", "get", "on", "at", "in", "of", "to", "with", "for", "as", "yet",
  "absolutely", "totally", "completely", "all's", "alls", "everythings",
  // Assent.
  "yes", "yeah", "yep", "yup", "yh", "ye", "aye", "sure", "definitely",
  // Negated-concern glue. `no` alone never clears: POSITIVE_CORE is still required.
  "no", "none", "nothing", "nope", "nowt",
  "problem", "problems", "issue", "issues", "complaint", "complaints", "worries",
  "dramas", "bother", "trouble", "troubles",
  // Positive-only emoji. Nothing ambiguous is here: 🙏 (thanks OR please help) and
  // 💪 (well OR enduring it) are both left out on purpose.
  "👍", "👌", "😊", "🙂", "😀", "😃", "😄", "😁", "❤", "❤️", "🥰", "😍", "🙌", "✅",
]);

/**
 * "No problems" and its cousins count as a positive core in their own right.
 *
 * Without this, "no problems thanks" would escalate as ambiguous. Note that
 * `problem` and `issue` are ALSO distress patterns, and the distress check runs
 * first — so this only ever gets its chance on the exact negated forms named here,
 * and "having problems" still escalates.
 */
const NEGATED_CONCERN = /^(?:no|none|nothing|nowt|zero) (?:problems?|issues?|complaints?|worries|dramas|bother)\b/;

/** Split a normalised message into comparable word tokens, keeping emoji whole. */
function tokenise(text: string): string[] {
  return text
    // Punctuation that never carries meaning here. Apostrophes are KEPT so "it's"
    // and "i'm" match the allow-list as written, and hyphens are kept for "tip-top".
    .replace(/[.,!;:()"“”…\/\\]/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "");
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

function escalate(reason: EscalationReason, matched: string | null): TriageVerdict {
  return { outcome: "escalate", reason, matched, urgent: true };
}

/**
 * Triage one inbound reply to a post-op check-in.
 *
 * FAILS SAFE. Every return in this function except the last one is an escalation,
 * and the last one is reachable only after six independent gates have all passed.
 * Delete any single gate and a category of unsafe message clears; that is what the
 * mutation battery in triage.test.ts checks, one gate at a time.
 */
export function triageReply(raw: string): TriageVerdict {
  // Gate 0: media. Checked on the RAW string, before normalisation lower-cases the
  // placeholder, and before anything else: a photo needs a person whatever else the
  // message says.
  if ((raw ?? "").includes(MEDIA_PLACEHOLDER)) return escalate("media", MEDIA_PLACEHOLDER);

  const text = normalise(raw);

  // Gate 1: is there anything here to read?
  if (text === "") return escalate("unreadable", "");
  if (!HAS_LATIN_LETTER.test(text)) {
    // Emoji-only, digits-only, punctuation-only. A distress emoji is named as
    // distress so the task says why; anything else is simply unreadable.
    const emoji = DISTRESS_EMOJI.find((e) => text.includes(e));
    return emoji ? escalate("distress", emoji) : escalate("unreadable", text.slice(0, 40));
  }
  const foreign = NON_LATIN_LETTER.exec(text);
  if (foreign && !DISTRESS_EMOJI.some((e) => text.includes(e))) {
    return escalate("unreadable", foreign[0]);
  }

  // Gate 2: distress emoji anywhere, even amongst perfectly cheerful words.
  const emoji = DISTRESS_EMOJI.find((e) => text.includes(e));
  if (emoji) return escalate("distress", emoji);

  // Gate 3: length. Runs before the pattern checks so a long message gets the
  // reason that is actually true of it.
  if (text.length > MAX_ALL_CLEAR_CHARS) return escalate("too_long", `${text.length} chars`);

  // Gate 4: a named symptom or a medication word.
  const symptom = firstMatch(text, SYMPTOM_PATTERNS);
  if (symptom) return escalate("symptom", symptom);

  // Gate 5: distress, negation, urgency.
  const distress = firstMatch(text, DISTRESS_PATTERNS);
  if (distress) return escalate("distress", distress);

  // Gate 6: they asked us something.
  const question = firstMatch(text, QUESTION_PATTERNS);
  if (question) return escalate("question", question);

  // Gate 7: THE ALLOW-LIST. Every token must be benign vocabulary, and at least one
  // must be a positive. This is the gate that catches everything the lists above
  // have never heard of.
  const tokens = tokenise(text);
  if (tokens.length === 0) return escalate("unreadable", "");
  const unknown = tokens.find((t) => !POSITIVE_CORE.has(t) && !FILLER.has(t));
  if (unknown) return escalate("ambiguous", unknown);
  const hasPositive = tokens.some((t) => POSITIVE_CORE.has(t)) || NEGATED_CONCERN.test(text);
  if (!hasPositive) return escalate("ambiguous", text.slice(0, 40));

  return { outcome: "all_clear", reason: null, matched: null, urgent: false };
}
