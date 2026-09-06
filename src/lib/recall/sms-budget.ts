// ===========================================================================
// WHAT A RECALL MESSAGE IS ALLOWED TO COST.
//
// Recall is the highest-volume send surface this platform has: a 51,000-patient
// base, 25 automated messages a day per site the moment the switch goes on, two
// of the three cadence steps on SMS. Until this file existed, the ONLY thing
// standing between a model-written body and Twilio was a prompt line reading
// "Under 90 words" — an instruction, not a ceiling. Nothing measured the body
// afterwards: draftRecall returned it, the sweep put it straight into the touch
// and the outbox, and the drain's one universal backstop (checkAgentReply) tests
// for funding jargon, clinical advice and prices, never for length or alphabet.
//
// 90 words of ordinary English is roughly 500 GSM-7 septets: FOUR billed
// segments. One typographic apostrophe in that body (the character a model
// reaches for in "we'll") forces the whole message into UCS-2 at 67 units a
// segment: EIGHT.
//
// That is not a tidiness point, it is the number the client was shown. Dentally
// bills per MESSAGE (7p flat on the real August 2026 invoice); Twilio bills per
// SEGMENT. The break-even is 1.69 segments per message, so anything averaging
// above it makes this platform MORE expensive than the system it replaces, and
// the saving the practice was quoted inverts into a loss with nothing on any
// screen recording that it did.
//
// ---------------------------------------------------------------------------
// SEPTETS, NOT `body.length`.
// ---------------------------------------------------------------------------
// The measure is `gsm7LengthUnits` from src/lib/triage/sms-cost.ts, which charges
// two units for a GSM 03.38 escape-table character (`[ ] { } \ ^ ~ | €`) because
// the wire does. A `.length` cap of 160 certifies bodies the carrier splits in
// two. `smsCost` is the same module's honest cost figure, reported alongside so a
// caller (or a log line) can say WHY a message costs what it costs.
//
// ---------------------------------------------------------------------------
// A NAME IS NEVER A REASON NOT TO TEXT SOMEBODY.
// ---------------------------------------------------------------------------
// The LENGTH rule counts a non-GSM-7 letter as one unit, exactly as
// src/lib/triage/sms-cost.ts's own header rules for the pre-visit message: a
// north London patient list is full of Polish, Turkish and Vietnamese names, the
// body copies the first name verbatim out of the Dentally record, and refusing to
// message a patient because of how their name is spelled would silence exactly
// the people the practice cannot edit. So `ł` costs the message money and never
// costs the patient their reminder. The typography pass below rewrites OUR OWN
// punctuation and never touches a letter, for the same reason.
//
// ---------------------------------------------------------------------------
// REFUSE RATHER THAN TRUNCATE.
// ---------------------------------------------------------------------------
// Nothing here trims a body to fit. A half-sentence about a dental appointment is
// worse than no message at all (src/lib/calendar/draft.ts says the same thing in
// the same words), and a truncation would just as happily cut the invitation to
// book, which is the only reason the message exists. Over budget is a refusal;
// the drafter's one repair attempt and then a thrown error are in ./draft.ts.
//
// ---------------------------------------------------------------------------
// WHERE THIS BELONGS EVENTUALLY.
// ---------------------------------------------------------------------------
// Nothing about the rule is recall-specific: every AI drafter in the tree
// (reactivation, coordinator, outreach, no-show, speed-to-lead) states its length
// as a prompt line and measures nothing, and the real home for the ceiling is the
// shared choke point every module already passes through — checkAgentReply and
// the messaging drain — so a future module cannot forget it. This lane owns
// src/lib/recall only; the move is a handoff, and this file is written with no
// dependency on anything else in this directory so it can be lifted whole.
// ===========================================================================

import type { TouchChannel } from "@/lib/reactivation/types";
import { gsm7LengthUnits, smsCost } from "@/lib/triage/sms-cost";

/**
 * The per-channel ceiling, in the unit that channel is billed in.
 *
 * SMS is ONE GSM-7 credit. Not two, not "about 90 words": the whole point of the
 * ceiling is the 1.69-segment break-even, and a limit set at two segments would
 * let every recall message grow to two without anybody noticing that it had. It
 * is the same 160 the pre-visit message already ships under
 * (src/lib/triage/copy.ts MAX_CHARS), so the two highest-volume patient texts in
 * the platform cost the same to send.
 *
 * WhatsApp and email are not billed per segment, so their ceilings are the ones
 * the tree already uses for exactly this purpose in src/lib/collection/draft.ts
 * (480 / 1400) rather than numbers invented here. They bound the body against a
 * runaway model, nothing more. Recall's own cadence never uses WhatsApp (step 1
 * SMS, step 2 email, step 3 SMS); the manual coordinator draft route accepts it.
 */
export const RECALL_MAX_UNITS: Record<TouchChannel, number> = {
  sms: 160,
  whatsapp: 480,
  email: 1400,
};

/**
 * The punctuation a language model reaches for and GSM 03.38 has no code point
 * for. Every one of these forces the WHOLE body into UCS-2, taking the
 * single-segment ceiling from 160 down to 70, and every one of them has an
 * ASCII spelling that reads identically in a text message.
 *
 * LEFT ALONE DELIBERATELY: letters. A curly apostrophe is our punctuation and we
 * may rewrite it; the ł in a patient's surname is their name and we may not.
 *
 * The dash row also mechanises the system prompt's existing "use no em-dash
 * characters anywhere" rule, which until now was an instruction with nothing
 * checking it.
 */
const TYPOGRAPHY: ReadonlyArray<readonly [RegExp, string]> = [
  // Curly single quotes, including the two low ones a model uses for quoting.
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  // Curly double quotes.
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  // Non-ASCII hyphens, the en and em dashes, and the minus sign.
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-"],
  // The ellipsis character, which costs three ASCII dots and buys nothing.
  [/\u2026/g, "..."],
  // The invisible spaces: no-break, figure, punctuation, thin, hair, narrow.
  [/[\u00A0\u2007\u2008\u2009\u200A\u202F]/g, " "],
  // Zero-width joiners and the BOM: invisible on the screen, three segments on
  // the bill. Written as escapes, never as raw characters, so this file stays
  // readable by every text tool (src/lib/source-hygiene.test.ts).
  [/[\u200B\u200C\u200D\uFEFF]/g, ""],
];

/**
 * Rewrite our own typography into characters the GSM alphabet carries.
 *
 * Idempotent, never lengthens a message except by the two characters an ellipsis
 * costs, and never changes a word. Run BEFORE the ceiling is measured so a body
 * is not refused for a curly quote we were about to fix anyway.
 */
export function normaliseGsm7Typography(text: string): string {
  let out = text ?? "";
  for (const [re, replacement] of TYPOGRAPHY) out = out.replace(re, replacement);
  return out;
}

export interface RecallBodyBudget {
  /** Within this channel's ceiling. */
  ok: boolean;
  /** The measured size, in the unit the ceiling is expressed in. */
  units: number;
  /** The ceiling that was applied. */
  limit: number;
  /** What the practice would actually be billed for, honestly counted. */
  segments: number;
  encoding: "gsm7" | "ucs2";
  /** The character that forced UCS-2, when one did. Named, never a mystery. */
  forcedUcs2By: string | null;
}

/**
 * Measure a composed body against its channel's ceiling.
 *
 * `units` is the LENGTH measure (septets, escape-table characters counted twice,
 * a non-GSM letter counted once). `segments` is the COST measure, which for a
 * UCS-2 body is a different unit entirely — a 160-unit body holding one ł is
 * three billed segments, and the report says so instead of pretending otherwise.
 */
export function measureRecallBody(body: string, channel: TouchChannel): RecallBodyBudget {
  const text = body ?? "";
  const limit = RECALL_MAX_UNITS[channel] ?? RECALL_MAX_UNITS.sms;
  const units = gsm7LengthUnits(text);
  const cost = smsCost(text);
  return {
    ok: units <= limit,
    units,
    limit,
    segments: cost.segments,
    encoding: cost.encoding,
    forcedUcs2By: cost.forcedUcs2By,
  };
}

/**
 * A drafted recall body that will not fit its channel's ceiling, after the one
 * repair attempt. Thrown rather than returned because the two callers destructure
 * `{ body }` and would otherwise have to be taught a new shape to ignore it: a
 * throw cannot be ignored. The sweep fails this tick and sends nothing, which is
 * the fail-closed direction the messaging law asks for (a skipped tick is a
 * delay; an unbounded message is a bill).
 */
export class RecallDraftTooLongError extends Error {
  readonly channel: TouchChannel;
  readonly units: number;
  readonly limit: number;
  constructor(channel: TouchChannel, budget: RecallBodyBudget) {
    super(
      `[recall] drafted ${channel} body is ${budget.units} units against a ${budget.limit} ceiling ` +
        `(${budget.segments} billed segments, ${budget.encoding}); refused rather than truncated`,
    );
    this.name = "RecallDraftTooLongError";
    this.channel = channel;
    this.units = budget.units;
    this.limit = budget.limit;
  }
}
