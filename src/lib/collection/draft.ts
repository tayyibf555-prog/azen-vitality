// Outstanding-balance collection agent: the drafter.
//
// REFUSE, NEVER INVENT. The model sees a projected set of facts taken from a
// VERIFIED balance (src/lib/collection/balance.ts) and nothing else. Every draft
// is scanned before it is stored, and a draft that fails the scan is NOT stored:
// there is no "store it and let a human notice" path.
//
// Nothing here sends. A draft is written to collection_touch with status 'draft'
// and nothing is written to collection_outbox, so the shared messaging drain
// (which lists only outbox rows with status 'queued') is structurally incapable of
// delivering an unapproved draft.
//
// ===========================================================================
// WHAT THE MODEL IS DELIBERATELY NOT TOLD, AND WHY.
//
// It is not told the treatment, the appointment, the clinician, the invoice date,
// the patient's history, or anything else about their care. A balance reminder
// needs none of it, and every one of them is a confidentiality risk on a channel
// the practice does not control: an SMS reading "your root canal invoice is
// unpaid" is legible on a lock screen, on a shared handset, and to whoever is
// standing next to them. The scan below refuses any named procedure outright
// (CLINICAL_DETAIL_PATTERNS) precisely because the model was never given one, so
// any that appears was invented AND is a leak.
//
// That also collapses the prompt-injection surface almost to nothing. The only
// Dentally free text that reaches the prompt at all is the patient's own name and
// the invoice reference, and both are shape-gated before they get there
// (sanitiseFreeText here, sanitiseInvoiceReference in balance.ts).
//
// THE MONEY FIGURE IS OFF BY DEFAULT.
//
// COLLECTION_QUOTE_AMOUNT defaults to false, and while it is false the message
// carries no figure at all: "there is an unpaid invoice on your account" is a
// complete, true and useful sentence without one. The reason is stated plainly in
// balance.ts — nothing in this repo settles whether live Dentally's
// `amount_outstanding` is denominated in the same unit as `amount`, and a figure
// wrong by a factor of a hundred in a message about somebody's money is not a bug
// that can be apologised for afterwards. The flag is switched on by a person, once
// one real invoice has been reconciled against Dentally's own account screen.
// ===========================================================================

import Anthropic from "@anthropic-ai/sdk";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { checkAgentReply } from "@/lib/agent/guardrail";
import { consumeBudget } from "@/lib/rate-budget";
import { penceToPounds, type VerifiedBalance } from "./balance";
import type { CollectionStep, TouchChannel } from "./types";
import { sanitiseFreeText as sharedSanitiseFreeText } from "@/lib/agent/free-text";

// ---------------------------------------------------------------------------
// Fact projection.
// ---------------------------------------------------------------------------

export interface CollectionDraftSource {
  siteId: string;
  patientName: string;
  balance: VerifiedBalance;
}

/** The projected, validated facts the prompt is built from. Nothing else reaches
 *  the model, so it cannot relay a field the practice never established. */
export interface CollectionFacts {
  firstName: string;
  practiceName: string;
  /** null means the message must carry NO money figure of any kind. */
  amountPounds: number | null;
  /** null means there is no single reference that describes the balance. */
  reference: string | null;
  /** null means the ask becomes "reply to this message". */
  paymentLink: string | null;
}

export type FactsProjection =
  | { ok: true; facts: CollectionFacts }
  | { ok: false; missing: string[] };

/**
 * Reduce a Dentally-sourced free-text field to something name-shaped before it can
 * reach the prompt. The same three passes the closer's sanitiseTreatmentName uses,
 * and for the same reason: a "name" of several sentences of instructions is a
 * prompt-injection attempt, not a name.
 *   1. replace control characters (C0, DEL, C1) and collapse whitespace runs, so a
 *      multi-line instruction block becomes one line and cannot pose as structure;
 *   2. keep only up to the first sentence break, severing anything after it;
 *   3. hard-cap the length.
 * PURE. An ordinary name passes through unchanged.
 */
export function sanitiseFreeText(raw: string, maxChars: number): string {
  // Re-exported from the shared implementation (src/lib/agent/free-text.ts) so
  // this module's callers and its own tests keep their import, while there is only
  // one copy of the algorithm in the tree. Behaviour is unchanged.
  return sharedSanitiseFreeText(raw, maxChars);
}

const MAX_NAME_CHARS = 80;

function firstNameOf(patientName: string): string | null {
  const token = sanitiseFreeText(patientName ?? "", MAX_NAME_CHARS).split(/\s+/)[0] ?? "";
  // At least two characters and containing a letter, so an initial, a stray
  // punctuation mark or a Dentally id never opens a message.
  if (token.length < 2) return null;
  // ...and not absurdly long. A real first name is short; a 40+ character run with
  // no space to split on is an injection payload jammed into the name field. The
  // greeting scan is anchored to this exact string, so capping it here is also what
  // stops a long instruction being smuggled into the message opening.
  if (token.length > 40) return null;
  if (!/\p{L}/u.test(token)) return null;
  return token;
}

/** Whether a draft may quote a figure at all. Default FALSE: see the file header. */
export function quoteAmountEnabled(): boolean {
  return (process.env.COLLECTION_QUOTE_AMOUNT ?? "").trim().toLowerCase() === "true";
}

/**
 * The ONE figure a collection message may carry, or null.
 *
 * Exported because two places need the same answer and must not each compute it:
 * the projection below, which builds the prompt, and the approval route, which
 * re-scans a HUMAN-EDITED body. If those two disagreed about what the figure is,
 * the scan would either refuse a correct edit or admit an invented one, and the
 * second is the failure that matters.
 *
 * Takes the pence figure STORED ON THE TOUCH rather than a fresh balance, so a
 * human editing a three-day-old draft is held to the figure that draft was written
 * against, not to one that has moved underneath them.
 */
export function quotableAmount(amountPence: number | null): number | null {
  if (amountPence === null || !Number.isFinite(amountPence) || amountPence <= 0) return null;
  if (!quoteAmountEnabled()) return null;
  return penceToPounds(amountPence);
}

/**
 * Project a verified balance into the facts a draft may use, or refuse.
 *
 * PURE apart from the one env read behind quotableAmount. Refuses when the patient
 * has no usable first name or the practice has no name, because both are
 * load-bearing: without them the message is an anonymous demand for money, which
 * is the exact thing this module must never send.
 */
export function projectCollectionFacts(
  source: CollectionDraftSource,
  opts: { paymentLink: string | null; practiceName: string },
): FactsProjection {
  const missing: string[] = [];

  const firstName = firstNameOf(source.patientName);
  if (!firstName) missing.push("patientName");

  const practiceName = sanitiseFreeText(opts.practiceName ?? "", 80);
  if (practiceName.length === 0) missing.push("practiceName");

  if (missing.length > 0) return { ok: false, missing };

  const link = (opts.paymentLink ?? "").trim();

  return {
    ok: true,
    facts: {
      firstName: firstName as string,
      practiceName,
      amountPounds: quotableAmount(source.balance.pence),
      // Only ever set when the whole balance is a single invoice; balance.ts drops
      // it otherwise, because with several invoices no one reference describes it.
      reference: source.balance.reference,
      paymentLink: link.startsWith("https://") ? link : null,
    },
  };
}

// ---------------------------------------------------------------------------
// The prompt.
// ---------------------------------------------------------------------------

const STEP_BRIEF: Record<CollectionStep["purpose"], string> = {
  notice:
    "This is the FIRST message. Let them know, kindly and without any fuss, that there is an " +
    "unpaid invoice on their account, and make it easy to sort out or to query.",
  offer_help:
    "This is the SECOND message, ten days after the first. Do not repeat the first message. " +
    "Offer to help: say that if it would be easier to talk it through, or to arrange something " +
    "that suits them better, they only have to tell you. Do not propose any specific arrangement, " +
    "any number of payments, any dates or any terms.",
  close:
    "This is the FINAL message. Say plainly that this is the last message about it, that the " +
    "balance simply stays on their account, and that they are welcome to get in touch whenever " +
    "suits them. Nothing about this may sound like a warning.",
};

export function buildCollectionPrompt(
  facts: CollectionFacts,
  step: CollectionStep,
): { system: string; user: string } {
  const nextStep = facts.paymentLink
    ? `Give exactly one next step: they can settle it here, written out in full and unchanged: ${facts.paymentLink}`
    : "Give exactly one next step: ask them to reply to this message and the team will sort it out with them.";

  const system = [
    `You are a warm, unhurried member of the reception team at ${facts.practiceName}, a UK dental practice.`,
    "You are letting a patient know, gently, that an invoice on their account has not been paid.",
    STEP_BRIEF[step.purpose],
    "",
    "THE TONE. This is a courteous note from a practice the patient trusts, and it must read as " +
      "though a person who likes them wrote it. It is never a demand, a warning, a notice, or a " +
      "chase. Assume completely that the patient simply has not got round to it, or has not seen " +
      "the invoice, because that is almost always what has happened.",
    "",
    "HARD RULES. Breaking any one of these means the message is thrown away:",
    `- Open the message with "Hi ${facts.firstName}," and address the patient only by that first name. Write no preamble, no note to yourself, no explanation of what you are doing, nothing at all before the greeting.`,
    "- Use ONLY the facts given below. Never add a fact, a figure, a percentage, a date, a time, a deadline or an offer that is not in them.",
    facts.amountPounds === null
      ? "- No amount is available to you. Do not mention any amount of money, in any form, and do not guess at one. Say that there is an unpaid invoice on their account, without a figure."
      : `- The only money figure you may write is £${facts.amountPounds}. Write no other number preceded by a pound sign, and no percentages.`,
    "- NEVER threaten anything. No debt collection, no collection agency, no legal action, no court, no credit rating, no referral of the account to anybody, no final demand, no final notice, no consequences of any kind, stated or implied.",
    "- NEVER suggest their care is affected. Never say or imply that an appointment, a booking, treatment or their place at the practice depends on this being paid.",
    "- NEVER mention interest, a late fee, a surcharge, an admin fee, a penalty, or any charge being added.",
    "- NEVER blame them. No wording about failing to pay, neglecting it, ignoring it, still not having paid, or being chased. No 'despite', no 'as you know', no 'once again'.",
    "- NEVER apply pressure. No deadline, no date by which anything must happen, no 'immediately', no 'urgent', no 'as soon as possible', no 'last chance'.",
    "- NEVER name a treatment, a procedure, an appointment, a tooth or anything clinical. You have not been told what the invoice is for and you must not guess.",
    "- Never give clinical advice, an opinion, or a diagnosis.",
    "- Never promise, guarantee or predict anything about treatment.",
    "- Never use internal funding or treatment category wording such as NHS or private. These are internal labels, not patient facing language.",
    "- NEVER ask for card details, a card number, a sort code, an account number, a security code or any bank detail. Not by reply, not by any route.",
    "- YOU MUST INCLUDE, in plain words, an invitation to tell the practice if the patient has already paid or if the amount looks wrong, and a promise to check it. For example: \"If you have already paid, or it looks wrong, just reply and we will check.\" This is not optional and the message is thrown away without it.",
    "- Never use an em dash or an en dash. Use commas or full stops.",
    facts.reference ? `- You may mention the invoice reference ${facts.reference} once, so they can find it. Do not alter it.` : null,
    `- ${nextStep}`,
    step.channel === "email"
      ? "- Channel is email. Plain text, no subject line, under 130 words."
      : "- Channel is SMS. Plain text, one short paragraph, under 60 words.",
    "- Sign off with the practice name. No placeholders, no square brackets, nothing for a human to fill in.",
    "- Output the message text only. No preamble, no explanation, no quotation marks around it.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  const user = [
    "FACTS:",
    `Patient first name: ${facts.firstName}`,
    facts.amountPounds === null
      ? "Amount owed: not available to you, do not mention any amount"
      : `Amount owed (GBP): ${facts.amountPounds}`,
    facts.reference ? `Invoice reference: ${facts.reference}` : "Invoice reference: none, do not mention one",
    `Practice: ${facts.practiceName}`,
    facts.paymentLink ? `Payment link: ${facts.paymentLink}` : "Payment link: none, ask them to reply",
  ].join("\n");

  return { system, user };
}

// ---------------------------------------------------------------------------
// The compliance scan. PURE, and the reason a bad draft is never stored.
// ---------------------------------------------------------------------------

export type CollectionRefusalCategory =
  | "empty"
  | "funding"
  | "clinical"
  | "clinical_detail"
  | "threat"
  | "care_withheld"
  | "invented_charge"
  | "shame"
  | "pressure"
  | "harm_from_delay"
  | "outcome_claim"
  | "credential_request"
  | "invented_figure"
  | "no_query_invitation"
  | "em_dash"
  | "placeholder"
  | "preamble"
  | "too_long";

export type CollectionScanResult =
  | { ok: true }
  | { ok: false; category: CollectionRefusalCategory; matched: string };

/**
 * The tone lock, and the reason this module exists rather than a template.
 *
 * A dental practice chasing a balance is not a creditor and must never sound like
 * one. Every pattern here is a thing a debt collector says and a receptionist does
 * not, and the distinction is not stylistic: under the GDC's own standards the
 * relationship is one of trust, and a practice that threatens a patient over an
 * invoice has spent that trust for a sum it will usually recover anyway.
 */
const THREAT_PATTERNS: RegExp[] = [
  /\bdebt collect/i,
  /\bcollections? agenc/i,
  /\brecovery agen/i,
  /\bbailiff/i,
  /\blegal action\b/i,
  /\bsolicitors?\b/i,
  /\b(?:county )?court\b/i,
  /\bccj\b/i,
  /\bsmall claims\b/i,
  /\bcredit (?:rating|score|file|reference|report)\b/i,
  /\b(?:refer|report|pass(?:ed|ing)?|hand(?:ed|ing)?) (?:you|this|it|your account|the account|the matter) (?:on )?to\b/i,
  /\bfurther action\b/i,
  /\baction will be taken\b/i,
  /\bconsequences?\b/i,
  /\bfinal (?:notice|demand|reminder|warning)\b/i,
  /\bformal (?:notice|demand)\b/i,
  /\bdemand (?:for )?payment\b/i,
  /\byou must pay\b/i,
  /\byou are required to\b/i,
  /\bfailure to (?:pay|respond|settle)\b/i,
  /\bif you do not pay\b/i,
  /\boverdue\b/i,
  /\barrears\b/i,
  /\bdelinquent\b/i,
  /\bin default\b/i,
  /\brecover (?:the|this|these|our) (?:money|amount|sum|funds|debt)\b/i,
];

/** Care may never be made conditional on payment. This is the single most serious
 *  thing a message like this could say, so it has its own category and its own
 *  sentence in the staff-facing copy. */
const CARE_WITHHELD_PATTERNS: RegExp[] = [
  /\b(?:cannot|can ?n[o']?t|unable to|will not|wo ?n[o']?t|refuse to|not able to) (?:book|see|treat|register|offer|make|give|arrange)\b/i,
  /\b(?:no|any) further (?:appointments?|treatment|care)\b/i,
  /\bbefore (?:we|you) can (?:book|be seen|see|treat|arrange)\b/i,
  /\b(?:account|treatment|appointments?|care) (?:is |are |will be )?(?:on hold|suspended|blocked|frozen)\b/i,
  /\bremoved from (?:our|the) (?:list|register|books|practice)\b/i,
  /\buntil (?:this|it|the balance|the invoice|payment) is (?:paid|settled|cleared|received)\b/i,
  /\bonce (?:this|it|the balance) is (?:paid|settled|cleared)[^.]{0,30}\b(?:we can|you can) (?:book|be seen|see)\b/i,
];

/** Nothing about a fee, an interest charge or a penalty is in the record, so any
 *  of it in a draft was invented AND commits the practice to a charge. */
const INVENTED_CHARGE_PATTERNS: RegExp[] = [
  /\binterest\b/i,
  /\blate (?:fee|payment fee|charge)\b/i,
  /\bsurcharge\b/i,
  /\b(?:admin|administration|handling|processing) (?:fee|charge)\b/i,
  /\bpenalt/i,
  /\b(?:additional|extra|further) charge/i,
  /\bwill be added to\b/i,
  /\bcharge you\b/i,
];

/** Blame and moralising. A patient who has not paid an invoice has, almost always,
 *  not got round to it, and a message that says otherwise is both rude and wrong. */
const SHAME_PATTERNS: RegExp[] = [
  /\byou (?:have )?failed to\b/i,
  /\byou neglect/i,
  /\byou still (?:have ?n[o']?t|ha ?ve ?n[o']?t|not)\b/i,
  /\bstill (?:not|un)paid\b/i,
  /\byou (?:have )?ignor/i,
  /\bdespite\b/i,
  /\brepeatedly\b/i,
  /\b(?:once|yet) again\b/i,
  /\bas you (?:know|are aware)\b/i,
  /\b(?:we have|we've) (?:already )?(?:chased|contacted you|written to you|reminded you)\b/i,
  /\bthird (?:time|reminder)\b/i,
];

/** No urgency, deadline or countdown. This is a reminder, not a demand. */
const PRESSURE_PATTERNS: RegExp[] = [
  /\bimmediat/i,
  /\burgent/i,
  /\bright away\b/i,
  /\bwithout delay\b/i,
  /\bat once\b/i,
  /\bas soon as possible\b/i,
  /\basap\b/i,
  /\bwithin \d+ (?:days?|hours?|working days?)\b/i,
  /\bno later than\b/i,
  /\bby (?:the end of|close of|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bdeadline\b/i,
  /\blast chance\b/i,
  /\bact now\b/i,
  /\bpromptly\b/i,
];

/** Never imply the patient will be harmed, or charged more, by not paying yet. */
const HARM_FROM_DELAY_PATTERNS: RegExp[] = [
  /\bget(?:s|ting)? worse\b/i,
  /\bworsen/i,
  /\bdeteriorat/i,
  /\bmore (?:serious|difficult|complex|expensive)\b/i,
  /\bcost(?:s)? more (?:later|if you wait)\b/i,
  /\bthe longer you (?:wait|leave|leave it)\b/i,
];

/** No promised or predicted clinical result, ever. */
const OUTCOME_PATTERNS: RegExp[] = [
  /\bguarantee/i,
  /\bcure[sd]?\b/i,
  /\bpain ?free\b/i,
  /\bpain-free\b/i,
  /\bpainless\b/i,
  /\brisk ?free\b/i,
  /\brisk-free\b/i,
  /\bpermanent(?:ly)?\b/i,
  /\b100 ?%/,
  /\bperfect (?:smile|teeth|result|results)\b/i,
];

/**
 * The funding pitch with the banned tokens filed off, exactly as the closer's own
 * scan carries it: the shared guardrail is token-based (NHS, private, funding) and
 * a message making the identical argument without those words sails through it.
 * Reported as `funding`, because that is what it is.
 */
const COMPARATIVE_ACCESS_PATTERNS: RegExp[] = [
  /\bwait(?:ing)?[\s-]?lists?\b/i,
  /\bseen (?:sooner|faster|quicker|earlier|more quickly)\b/i,
  /\bskip(?:ping)? (?:the |a )?(?:queue|queues|wait|waiting|line|lines|list)\b/i,
  /\bjump(?:ing)? (?:the |a )?(?:queue|queues|line|lines|list|waiting list)\b/i,
  /\b(?:faster|quicker|sooner|more quickly) than\b/i,
];

/**
 * Named procedures. The drafter is never told what the invoice is for, so any of
 * these in a draft is BOTH an invention and a disclosure of somebody's dental
 * treatment onto a channel the practice does not control. "surgery" is deliberately
 * absent: in British usage the surgery is the building, and "pop into the surgery"
 * is an ordinary and useful sentence.
 */
const CLINICAL_DETAIL_PATTERNS: RegExp[] = [
  /\bimplants?\b/i,
  /\broot canal\b/i,
  /\bendodont/i,
  /\bcrowns?\b/i,
  /\bbridges?\b/i,
  /\bdentures?\b/i,
  /\bveneers?\b/i,
  /\bwhitening\b/i,
  /\bfillings?\b/i,
  /\bextractions?\b/i,
  /\bhygien/i,
  /\bscale and polish\b/i,
  /\borthodont/i,
  /\binvisalign\b/i,
  /\bbraces?\b/i,
  /\baligners?\b/i,
  /\bwisdom (?:tooth|teeth)\b/i,
  /\bteeth\b/i,
  /\btooth\b/i,
  /\bgums?\b/i,
  /\bx-?ray/i,
  /\bradiograph/i,
  /\bperiodont/i,
  /\bsedation\b/i,
  /\banaesthe/i,
];

/**
 * Payment credentials, never. A message that asks a patient to reply with a card
 * number is a data breach if they do it and a template for a scam if they do not,
 * and the practice has a card machine at reception for exactly this reason.
 */
const CREDENTIAL_REQUEST_PATTERNS: RegExp[] = [
  /\bcard (?:number|details|digits)\b/i,
  /\blong number\b/i,
  /\bsort ?code\b/i,
  /\baccount number\b/i,
  /\b(?:cvv|cvc)\b/i,
  /\bsecurity (?:code|number)\b/i,
  /\bbank details\b/i,
  /\bexpiry date\b/i,
  /\b(?:reply|text|email) (?:us )?(?:with|your) (?:your )?card\b/i,
];

/**
 * THE INVITATION TO QUERY, and it is REQUIRED, not merely permitted.
 *
 * This is the one positive requirement in the scan and it is the module's
 * conscience. Every message here rests on a figure derived from a live system by a
 * chain of reads, and the patient is the only person in the loop who actually knows
 * whether they paid. A reminder that does not offer them a way to say "I already
 * paid" or "that is not right" is a claim being made at somebody with no door out
 * of it, and it is also how a dispute goes unnoticed until it becomes a complaint.
 * It is cheap, it is kind, and it is what turns a wrong figure into a corrected
 * record instead of a lost patient.
 */
const QUERY_INVITATION_PATTERNS: RegExp[] = [
  /\balready (?:paid|settled)\b/i,
  /\bif (?:this|that|it|anything|the amount|the figure)[^.?!]{0,70}\b(?:wrong|incorrect|not right|a mistake|does ?n[o']?t look right|looks off|seems off)\b/i,
  /\b(?:let us know|tell us|get in touch|reply|come back to us|contact us)\b[^.?!]{0,70}\bif\b[^.?!]{0,70}\b(?:wrong|incorrect|mistake|paid|not right|does ?n[o']?t look right|anything)\b/i,
  /\bif\b[^.?!]{0,50}\b(?:think|believe)\b[^.?!]{0,50}\b(?:wrong|incorrect|mistake|error|not right)\b/i,
];

/** An unfilled template slot must never reach a patient. */
const PLACEHOLDER_PATTERNS: RegExp[] = [/\[[^\]]{1,40}\]/, /\{\{[^}]{1,40}\}\}/, /\bXXXX?\b/];

/** Greeting openings a real reminder uses. The scan requires the body to START
 *  with one of these immediately followed by the patient's own first name, which is
 *  the mechanical form of "no model preamble". */
const GREETING_WORDS = "hi|hiya|hello|hey|dear";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every currency figure in the text, with its parsed value. */
export function currencyFigures(text: string): Array<{ raw: string; value: number }> {
  const out: Array<{ raw: string; value: number }> = [];
  const re = /£\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ raw: m[0], value: Number(m[1].replace(/,/g, "")) });
  }
  return out;
}

const MAX_CHARS: Record<TouchChannel, number> = { sms: 480, email: 1400, whatsapp: 480 };

/** One pattern list, returning the first hit. */
function firstHit(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Scan a drafted message against this module's rules AND the shared platform
 * guardrail. Returns the FIRST violation found.
 *
 * The invented-figure rule is the mechanical form of "the verified balance only":
 * every currency amount in the text must equal the figure the draft was written
 * against, and when there is no figure, ANY currency amount is a refusal.
 * A figure may render the amount exactly or round it DOWN to whole pounds, never
 * UP: quoting even a penny more than the practice can prove is a fabricated figure.
 * Percentages are refused outright, because nothing in the record is a percentage.
 *
 * `firstName` is OPTIONAL. The drafter's own path always supplies it and the body
 * must then open by greeting the patient by that name, which is how model preamble
 * and narration are caught. The approval route re-scans a HUMAN's edit with no
 * first name: a receptionist may legitimately open "Dear Mrs Shah", and a human
 * does not emit model narration.
 *
 * KNOWN LIMIT, stated rather than hidden: a bare number with no currency symbol
 * ("120 on your account") is not caught. The prompt forbids it and the human
 * approval step is the second line of defence. Widening the rule to every digit run
 * would refuse legitimate drafts (invoice references, links) and drive churn.
 */
export function checkCollectionDraft(
  body: string,
  facts: Pick<CollectionFacts, "amountPounds"> & Partial<Pick<CollectionFacts, "firstName">>,
  channel: TouchChannel = "sms",
): CollectionScanResult {
  const text = body ?? "";
  if (text.trim().length === 0) return { ok: false, category: "empty", matched: "" };

  // The shared platform backstop first: funding jargon and clinical advice are the
  // two universal rules, enforced identically for every module.
  const shared = checkAgentReply(text, { includePrice: false });
  if (!shared.ok) {
    const category: CollectionRefusalCategory = shared.category === "funding" ? "funding" : "clinical";
    return { ok: false, category, matched: shared.matched ?? "" };
  }

  // Ordered by seriousness, so a message that breaks several rules is reported as
  // the worst of them: the staff-facing sentence should name the thing that most
  // needs to change, not whichever pattern happens to sit first in the file.
  const passes: Array<[CollectionRefusalCategory, RegExp[]]> = [
    ["care_withheld", CARE_WITHHELD_PATTERNS],
    ["threat", THREAT_PATTERNS],
    ["credential_request", CREDENTIAL_REQUEST_PATTERNS],
    ["clinical_detail", CLINICAL_DETAIL_PATTERNS],
    ["invented_charge", INVENTED_CHARGE_PATTERNS],
    ["shame", SHAME_PATTERNS],
    ["pressure", PRESSURE_PATTERNS],
    ["harm_from_delay", HARM_FROM_DELAY_PATTERNS],
    ["outcome_claim", OUTCOME_PATTERNS],
    ["funding", COMPARATIVE_ACCESS_PATTERNS],
    ["placeholder", PLACEHOLDER_PATTERNS],
  ];
  for (const [category, patterns] of passes) {
    const matched = firstHit(text, patterns);
    if (matched) return { ok: false, category, matched };
  }

  // Message SHAPE: the body must open by greeting the patient by their own first
  // name, so no preamble or model narration can precede it. Runs after placeholder
  // so a template slot IN the greeting ("Hi [FIRST NAME]") is named as the
  // placeholder it is rather than as a shape failure. The trailing boundary is a
  // Unicode negative lookahead, not \b: an accented first name does not close on
  // JS \b (ASCII-only), so \b would wrongly reject an accented greeting.
  if (facts.firstName) {
    const opening = text.replace(/^\s+/, "");
    const greet = new RegExp(
      `^(?:${GREETING_WORDS})\\b[\\s,]*(?:there[\\s,]+)?${escapeRegExp(facts.firstName)}(?![\\p{L}\\p{N}])`,
      "iu",
    );
    if (!greet.test(opening)) {
      return { ok: false, category: "preamble", matched: opening.slice(0, 40) };
    }
  }

  // Invented figures.
  const percent = /\d+(?:\.\d+)?\s?%/.exec(text);
  if (percent) return { ok: false, category: "invented_figure", matched: percent[0] };
  const figures = currencyFigures(text);
  if (facts.amountPounds === null) {
    if (figures.length > 0) return { ok: false, category: "invented_figure", matched: figures[0].raw };
  } else {
    const stored = facts.amountPounds;
    for (const f of figures) {
      const exact = Math.abs(f.value - stored) < 0.005;
      // Whole-pound DOWN only. Math.floor never rounds up, so a figure may equal the
      // stored amount or its floor but can never exceed it.
      const roundedDown = f.value === Math.floor(stored);
      if (!exact && !roundedDown) {
        return { ok: false, category: "invented_figure", matched: f.raw };
      }
    }
  }

  // THE ONE POSITIVE REQUIREMENT. See QUERY_INVITATION_PATTERNS.
  if (!QUERY_INVITATION_PATTERNS.some((re) => re.test(text))) {
    return { ok: false, category: "no_query_invitation", matched: "" };
  }

  const dash = /[—–]/.exec(text);
  if (dash) return { ok: false, category: "em_dash", matched: dash[0] };

  const cap = MAX_CHARS[channel] ?? MAX_CHARS.sms;
  if (text.length > cap) {
    return { ok: false, category: "too_long", matched: `${text.length} chars` };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// The model call.
// ---------------------------------------------------------------------------

export type CollectionDraftResult =
  | { ok: true; body: string; amountPence: number | null }
  | {
      ok: false;
      category: CollectionRefusalCategory | "budget" | "missing_facts" | "model_error";
      detail: string;
    };

function budgetLimit(): number {
  const n = Number(process.env.COLLECTION_DRAFT_BUDGET_LIMIT ?? "100");
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function budgetWindowSeconds(): number {
  const n = Number(process.env.COLLECTION_DRAFT_BUDGET_WINDOW ?? "3600");
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

/**
 * Draft one balance reminder, or refuse.
 *
 * The cost guard is consumed BEFORE the Anthropic client is constructed, so a
 * runaway sweep cannot open a client at all once the window's budget is spent. The
 * scan runs on the model's output BEFORE the caller is given a body, so a
 * non-compliant draft never exists as a storable value.
 *
 * `amountPence` comes back with the body and is stored on the touch, so the
 * approval route can hold a human's edit to the same figure the model was given.
 * It is null whenever the draft quotes nothing, which includes every draft written
 * while COLLECTION_QUOTE_AMOUNT is off.
 *
 * NO usps ARE PASSED, and that is deliberate. Every other drafter in this platform
 * threads the practice's selling points into the prompt. A message about money a
 * patient owes is the one place marketing has no business being: "we are rated
 * five stars" in the same paragraph as "you have not paid" is the tonal opposite
 * of what this module is for.
 */
export async function draftCollectionMessage(
  source: CollectionDraftSource,
  step: CollectionStep,
  opts: {
    paymentLink: string | null;
    practiceName: string;
    client?: Anthropic;
  },
): Promise<CollectionDraftResult> {
  const projected = projectCollectionFacts(source, {
    paymentLink: opts.paymentLink,
    practiceName: opts.practiceName,
  });
  if (!projected.ok) {
    return { ok: false, category: "missing_facts", detail: projected.missing.join(",") };
  }
  const { facts } = projected;

  // Cost guard FIRST, before any client exists. Shared across every serverless
  // instance (api_budget + the consume_rate_budget RPC), so it is a real ceiling.
  const withinBudget = await consumeBudget(
    `collection-draft:${source.siteId}`,
    budgetLimit(),
    budgetWindowSeconds(),
  );
  if (!withinBudget) {
    return { ok: false, category: "budget", detail: `collection-draft:${source.siteId}` };
  }

  const client = opts.client ?? new Anthropic();
  const { system, user } = buildCollectionPrompt(facts, step);

  let body: string;
  try {
    const msg = await client.messages.create({
      model: SONNET,
      thinking: NO_THINKING,
      max_tokens: 500,
      system,
      messages: [{ role: "user", content: user }],
    });
    body = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (err) {
    return { ok: false, category: "model_error", detail: err instanceof Error ? err.message : String(err) };
  }

  const scan = checkCollectionDraft(body, facts, step.channel);
  if (!scan.ok) return { ok: false, category: scan.category, detail: scan.matched };

  return {
    ok: true,
    body,
    // Stored only when the draft actually quotes one. A draft written with the
    // figure withheld must not carry a figure on its row either, or a later
    // human edit would be re-scanned as though quoting it were allowed.
    amountPence: facts.amountPounds === null ? null : source.balance.pence,
  };
}
