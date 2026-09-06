import { checkAgentReply } from "@/lib/agent/guardrail";
import { fundingTermIn } from "./forbidden";
import { gsm7LengthUnits } from "./sms-cost";

// ===========================================================================
// EVERY PATIENT-FACING WORD THIS MODULE SENDS. PURE, no I/O, no model.
//
// THERE IS NO DRAFTER HERE, and that is deliberate — the same decision post-op
// made, for the same reason. A pre-visit message has to say one thing to
// everybody: here is a short form, please fill it in before you come. There is
// nothing to personalise beyond a first name and the practice name, so the module
// composes from a fixed template instead of generating, which removes
// structurally rather than by scanning every failure a drafter has: a jailbreak
// through an injected appointment reason, a model volunteering a clinical
// opinion, a hallucinated price, a preamble before the greeting.
//
// The scan below therefore exists as a PROOF rather than as a filter. It is run
// over the template itself by copy.test.ts, so the rules the platform enforces on
// a model's output are enforced here on the words a human wrote.
//
// ---------------------------------------------------------------------------
// THE ONE-CREDIT CEILING, AND WHY IT DECIDED THE LINK DESIGN.
// ---------------------------------------------------------------------------
// The brief was one SMS credit. One credit is 160 GSM-7 characters TOTAL,
// including the link. A signed patient token (the medical-history / FP17 idiom)
// is ~170 characters on its own, so a token-linked message cannot be one credit
// at any length of greeting. That is why ./link.ts mints a 22-character database
// id instead, and it is why MAX_CHARS below is a real constraint rather than a
// tidiness rule: `previsitBody` is asserted under it in copy.test.ts at a
// realistic origin length.
//
// ONE CREDIT *FOR A NAME GSM-7 CAN CARRY*, AND THE MODULE NOW SAYS SO. The
// ceiling used to be checked with `body.length`, which counts UTF-16 code units
// and knows nothing about the alphabet a carrier bills in. A single letter
// GSM 03.38 has no code point for — the ł in Małgorzata, the â in Siân, the ț
// in Ionuț — forces the WHOLE body into UCS-2, where one segment is 70 units,
// not 160. The composed message is ~140 characters either way, so such a
// message is two or three credits while passing a check that certified it as
// one. `./sms-cost.ts` is the honest measure (and the numbers above are from
// it, not from an estimate); `smsCost` is asserted on the shipped body for both
// alphabets in copy.test.ts, so the real figure is a pinned fact rather than a
// surprise on an invoice.
//
// The scan does NOT refuse a body for being UCS-2. Refusing would mean the
// practice never texts a patient because of how their name is spelled, which is
// a worse failure than the cost, and the name is the one part of this message
// the platform does not get to write. What to do about the 2-3x for that cohort
// (transliterate the greeting? drop to a neutral one? accept it?) changes words
// a patient reads, so it is the owner's call and not this file's.
//
// ---------------------------------------------------------------------------
// WHY THE MEDICAL-HISTORY LINK IS NOT IN THIS MESSAGE.
// ---------------------------------------------------------------------------
// The brief asked for the pre-visit link "alongside the medical-history link".
// Two links cannot fit in one credit: the medical-history link is a signed
// patient token (~170 characters + origin) and there is no shorter form of it
// without changing that module, which belongs to another lane. Sending two
// messages doubles the cost and the interruption for one errand.
//
// So the handover is in the JOURNEY rather than in the message: when
// MEDICAL_HISTORY_ENABLED is on, the pre-visit form's completion screen offers
// the medical-history form as the next step, minted for the same patient by
// buildMedicalHistoryLink. The patient gets one text, one tap, and both forms in
// the order the practice wants them. See src/app/pv/[token]/page.tsx.
// ===========================================================================

export interface TriageMessageFacts {
  firstName: string;
  practiceName: string;
  link: string;
}

export type TriageFactsProjection =
  | { ok: true; facts: TriageMessageFacts }
  | { ok: false; missing: string[] };

/**
 * A usable first name: at least two characters, contains a letter, not absurdly
 * long, no control characters.
 *
 * The length ceiling is a real defence rather than tidiness. This is the one
 * place a Dentally free-text field is copied verbatim into a patient-facing
 * message, and a 40-character run with no space in a name field is a payload, not
 * a name. Control characters are refused so a name cannot introduce structure
 * into the message body.
 */
function firstNameOf(patientName: string): string | null {
  const token = (patientName ?? "").trim().split(/\s+/)[0] ?? "";
  if (token.length < 2 || token.length > 40) return null;
  if (!/\p{L}/u.test(token)) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(token)) return null;
  return token;
}

/**
 * Project a target into the three facts a message may use, or refuse.
 *
 * A refusal means NO MESSAGE, not a message with a gap in it. "Hi , Vitality here"
 * is worse than silence, and a link that is the empty string is a message asking
 * the patient to tap nothing.
 */
export function projectTriageFacts(input: {
  patientName: string;
  practiceName: string;
  link: string | null;
}): TriageFactsProjection {
  const missing: string[] = [];
  const firstName = firstNameOf(input.patientName);
  if (!firstName) missing.push("patientName");
  const practiceName = (input.practiceName ?? "").trim();
  if (practiceName.length === 0) missing.push("practiceName");
  const link = (input.link ?? "").trim();
  if (link.length === 0) missing.push("link");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, facts: { firstName: firstName as string, practiceName, link } };
}

/**
 * THE ONE OUTBOUND MESSAGE.
 *
 * It names the practice (so the patient knows who is texting), says what the link
 * is for in six words, and stops. It makes no clinical statement, asks no
 * clinical question, promises nothing and quotes no figure. It does not say
 * "urgent", "important" or "required": a form the practice would like filled in
 * is not an instruction, and dressing it as one is how a pre-visit ask turns into
 * a patient ringing the emergency line.
 *
 * It also does not name the appointment time. The time is in the confirmation the
 * no-show module already sends, and a second message quoting a time the diary may
 * have moved since is a second chance to be wrong about it.
 */
export function previsitBody(facts: TriageMessageFacts): string {
  return (
    `Hi ${facts.firstName}, ${facts.practiceName} here. ` +
    `A few quick questions before your visit: ${facts.link}`
  );
}

// ---------------------------------------------------------------------------
// THE COMPLIANCE SCAN.
// ---------------------------------------------------------------------------

export type TriageRefusalCategory =
  | "empty"
  | "funding"
  | "clinical"
  | "urgency"
  | "clinical_question"
  | "placeholder"
  | "em_dash"
  | "preamble"
  | "too_long";

export type TriageScanResult =
  | { ok: true }
  | { ok: false; category: TriageRefusalCategory; matched: string };

/**
 * ONE SMS CREDIT. 160 GSM-7 septets, and the ceiling is enforced on the whole
 * composed body including the link.
 *
 * Not 306 (two segments) and not 320 (post-op's ceiling): the brief was one
 * credit, and a ceiling set at two segments would let the message grow to two
 * without anybody noticing that it had.
 *
 * SEPTETS, NOT `body.length` — see the header. The unit is `gsm7LengthUnits`,
 * which charges two for an escape-table character (`[`, `]`, `{`, `}`, `\`,
 * `^`, `~`, `|`, `€`), because the wire does. A body of 160 characters holding
 * one `[` is two segments, and the old measure called it one.
 */
export const MAX_CHARS = 160;

/**
 * Urgency language. A pre-visit form is a courtesy; a courtesy that says "urgent"
 * or "action required" reads to an anxious patient as a message about their
 * MOUTH, not about a form, and the practice gets a phone call it did not want at
 * a time it cannot answer.
 */
const URGENCY_PATTERNS: RegExp[] = [
  /\burgent(?:ly)?\b/i,
  /\bimmediate(?:ly)?\b/i,
  /\bas soon as possible\b/i,
  /\basap\b/i,
  /\baction required\b/i,
  /\bmust\b/i,
  /\brequired\b/i,
  /\bimportant\b/i,
  /\bdo not ignore\b/i,
  /\bfailure to\b/i,
  /\bwill be cancelled\b/i,
];

/**
 * A clinical QUESTION in the message body.
 *
 * The whole design of this module is that the clinical questions live behind the
 * link, where the SERVER has already decided which bank the patient may be asked.
 * A symptom question in the SMS itself bypasses the fork completely: every patient
 * gets it, including every patient on the short list, which is the exact failure
 * the fork exists to prevent. So the message may not ask about the patient's mouth
 * at all.
 */
const CLINICAL_QUESTION_PATTERNS: RegExp[] = [
  /\bpain\b/i,
  /\bhurt/i,
  /\bache/i,
  /\bsymptom/i,
  /\bbleed/i,
  /\bswell/i,
  /\btooth\b/i,
  /\bteeth\b/i,
  /\bgum(?:s)?\b/i,
  /\bsensitiv/i,
];

const PLACEHOLDER_PATTERNS: RegExp[] = [/\[[^\]]{1,40}\]/, /\{\{[^}]{1,40}\}\}/, /\bXXXX?\b/, /\{[a-zA-Z]+\}/];

const GREETING_WORDS = "hi|hiya|hello|hey|dear";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan a pre-visit message against this module's rules and the shared platform
 * guardrail. Returns the first violation found.
 *
 * `firstName`, when given, requires the body to OPEN by greeting the patient by
 * that exact name — the mechanical form of "no preamble", and also a proof that
 * what the composer put first is the substituted name rather than anything else.
 */
export function checkTriageMessage(
  body: string,
  facts: Partial<Pick<TriageMessageFacts, "firstName">> = {},
): TriageScanResult {
  const text = body ?? "";
  if (text.trim().length === 0) return { ok: false, category: "empty", matched: "" };

  // The shared platform backstop first: funding jargon and clinical advice are the
  // two universal rules, enforced identically for every module. includePrice stays
  // false because this message carries no figure at all.
  const shared = checkAgentReply(text, { includePrice: false });
  if (!shared.ok) {
    const category: TriageRefusalCategory = shared.category === "funding" ? "funding" : "clinical";
    return { ok: false, category, matched: shared.matched ?? "" };
  }
  // ...and this module's own funding list on top, which catches the vocabulary the
  // shared guardrail does not (payment plan, exemption, fee scale).
  const funding = fundingTermIn(text);
  if (funding) return { ok: false, category: "funding", matched: funding };

  for (const re of PLACEHOLDER_PATTERNS) {
    const m = re.exec(text);
    if (m) return { ok: false, category: "placeholder", matched: m[0] };
  }
  for (const re of URGENCY_PATTERNS) {
    const m = re.exec(text);
    if (m) return { ok: false, category: "urgency", matched: m[0] };
  }
  for (const re of CLINICAL_QUESTION_PATTERNS) {
    const m = re.exec(text);
    if (m) return { ok: false, category: "clinical_question", matched: m[0] };
  }

  if (facts.firstName) {
    const opening = text.replace(/^\s+/, "");
    const greet = new RegExp(
      `^(?:${GREETING_WORDS})\\b[\\s,]*${escapeRegExp(facts.firstName)}(?![\\p{L}\\p{N}])`,
      "iu",
    );
    if (!greet.test(opening)) {
      return { ok: false, category: "preamble", matched: opening.slice(0, 40) };
    }
  }

  const dash = /[—–]/.exec(text);
  if (dash) return { ok: false, category: "em_dash", matched: dash[0] };

  // THE LENGTH RULE, IN THE UNIT THE CARRIER COUNTS IN. `text.length` was the
  // wrong measure twice over: it charged one for an escape-table character the
  // wire charges two for, and it certified "one credit" for a UCS-2 body that
  // is two or three. The refusal stays keyed to the septet count — the thing it
  // was written to catch is the TEMPLATE growing — and the true cost of a body
  // in either alphabet is `smsCost`, which nothing here refuses on. See the
  // header for why a name outside GSM-7 must not cost the patient their message.
  const units = gsm7LengthUnits(text);
  if (units > MAX_CHARS) {
    return { ok: false, category: "too_long", matched: `${units} chars` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// THE SCREEN THE PATIENT SEES. Every string, in one tested place.
//
// None of these says NHS, private, band, funding, payment plan or exemption, and
// none of them explains why this patient got these questions. Two patients
// comparing their phones must not be able to work out that they were asked
// different things because of how they are seen: the shorter form simply has
// fewer questions on it, with no note attached.
// ---------------------------------------------------------------------------

/**
 * THE SCORE AT WHICH THE PATIENT IS TOLD HOW TO GET HELP NOW.
 *
 * Seven, the same number the record summary flags at (DISCOMFORT_NOTICE_THRESHOLD),
 * and kept as its own constant because the two serve different readers: that one
 * decides what a clinician sees on a record, this one decides what a patient in
 * pain is told on their phone. They agree today by intent, not by dependency.
 */
export const URGENT_HELP_THRESHOLD = 7;

/**
 * What a patient who has just rated their discomfort near the top of the scale is
 * told, immediately, on the form and again on the completion screen.
 *
 * WHY IT EXISTS. Nothing in this module acts on a high score: it raises no task,
 * moves no appointment and sends no message. A form that asks somebody how bad
 * their pain is, does nothing about the answer, and does not tell them where to go
 * is worse than a form that never asked. This line is the whole of the practice's
 * duty here and it is not optional.
 *
 * THE NUMBER IS NEVER INVENTED. `practicePhone` is the SITE's own publicPhone,
 * which is null until the owner supplies the real numbers. When it is null the
 * sentence drops the number clause and keeps 111 — it does NOT fall back to a
 * guess. That is the rule the platform already states on Site.publicPhone: "a
 * guessed phone number in a text to a patient is not acceptable, and a message
 * inviting someone to ring a number that is not the practice is worse than sending
 * nothing." A patient is still given a route either way.
 *
 * "111", NOT "NHS 111". The service is called 111 and the patient-facing crawl
 * forbids the other word.
 *
 * NO EM-DASH. The approved wording used one; house style forbids an em-dash in
 * patient copy, so the clause is a sentence instead. The words are unchanged.
 */
export function urgentHelpLine(practicePhone: string | null | undefined): string {
  const phone = (practicePhone ?? "").trim();
  const call = phone ? `please call the practice on ${phone}.` : "please call the practice.";
  return `If you're in severe pain right now, ${call} Outside opening hours, call 111 for urgent dental advice.`;
}

export const TRIAGE_PUBLIC_COPY = {
  /** The heading, above the practice name. */
  heading: "Before your visit",
  /**
   * The one line of orientation. It sets the expectation (short), the stakes
   * (none) and the point (so we are ready for you). It does NOT say "so we can
   * plan your treatment", which would be a claim about what happens next.
   *
   * IT ALSO DOES NOT OFFER A SKIP, BECAUSE THE FORM DOES NOT HAVE ONE. It used
   * to end "you can skip anything you would rather talk about in person", and
   * that was simply untrue: `defaultConfigFor` ships `attending`,
   * `health-changed`, the interest grid and (on the full bank) `visit-reason`
   * REQUIRED, `outstandingCount` counts every unanswered one of them plus every
   * unanswered interest row, and the submit button is disabled until that count
   * is zero. A patient who took the sentence at its word met a dead button with
   * a count line for an explanation, and the likeliest outcome was an abandoned
   * form on the very question the sentence was written for.
   *
   * The design is right and the sentence was wrong, so the sentence changed
   * (ruling W3/9: copy matches code, never the reverse). What the form actually
   * offers is REQUIRED-BUT-REFUSABLE: the handful we insist on can each be
   * answered without going into anything ("I'm not sure yet", "Something else",
   * "Not right now", and health-changed's own help line already says a yes or a
   * no is enough), and the detail waits for the chair. That is what it now says.
   * Pinned by "the intro never promises a skip the form will not allow".
   */
  intro:
    "A few quick questions so we are ready for you. It takes about a minute. Most are optional, and where we do need an answer there is always one that leaves the details for your visit.",
  /** Under the interest grid. Says plainly that yes is not a commitment. */
  interestNote:
    "Saying yes just means someone will have a chat with you about it. Nothing is booked and nothing is charged.",
  /** The always-available refusal, worded so it is a real answer and not a skip. */
  interestDecline: "Not right now",
  interestAccept: "Yes, tell me more",
  submit: "Send to the practice",
  submitting: "Sending",
  /** Shown when a required answer is missing. Counts, never names or shames. */
  incomplete: (n: number) => `${n} question${n === 1 ? "" : "s"} still to answer.`,
  /** Success. Nothing more to do, and it says so. */
  doneHeading: "Thank you",
  doneBody: "Your answers have gone to the practice. There is nothing more to do, and you can close this page.",
  /** The onward step, shown only when the medical-history form is switched on. */
  medicalNext: "While you are here, there is one more short form about your health.",
  medicalNextCta: "Fill in the health form",
  /** A submit the server rejected. Distinct from a submit that never arrived. */
  saveFailed: "We could not save your answers. Please try again.",
  /** A submit that never reached us. A different fact, and a different fix. */
  reachFailed: "We could not reach the practice. Please check your signal and try again.",
} as const;
