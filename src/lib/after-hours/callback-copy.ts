// Every word a caller to the practice line hears or is texted, in one place.
//
// Three rules bind this file:
//
//  1. NAME THE PRACTICE. A text arriving from an unknown number that does not say
//     who it is from reads as spam, and a spoken line that does not name the
//     practice tells the caller nothing. The name comes from the site config
//     (`getSite(siteId).name`), never a literal, so a second practice on this
//     platform can never be greeted with Vitality's name.
//
//  2. NEVER SAY NHS OR PRIVATE. Funding vocabulary is internal; it must not reach
//     a patient on any channel (project rule, swept by the sibling test and by
//     `checkAgentReply`).
//
//  3. PROMISE ONLY WHAT HAPPENED. The "text sent" lines are only ever spoken by
//     the route AFTER a send actually succeeded. The "no text" lines promise
//     nothing, so a suppressed number, a switched-off system or a failed send
//     never hears "we've just sent you a text".
//
// Pure: no clock, no network, no I/O. Every line takes the practice name so the
// caller resolves it once.

import { getSite } from "@/lib/mock/clients";

/**
 * Spoken and texted when the site id does not resolve to a configured site.
 * Deliberately generic rather than a guessed brand: naming the wrong practice to
 * a patient is worse than naming none.
 */
const PRACTICE_FALLBACK = "the practice";

/** The practice name to put in front of a caller, from the site config. */
export function practiceNameFor(siteId: string): string {
  return getSite(siteId)?.name ?? PRACTICE_FALLBACK;
}

// --- Spoken lines (TwiML <Say>) ---------------------------------------------

/**
 * In hours, nothing texted. Says plainly that we could not get to the call.
 *
 * This deliberately does NOT say "please hold": the TwiML hangs up immediately
 * afterwards, so telling a caller to hold is a statement the next half-second
 * contradicts.
 */
export function spokenOpenNoText(practice: string): string {
  return `Thanks for calling ${practice}. Sorry we could not get to your call. Please call back and we will be happy to help.`;
}

/** In hours, a callback text has actually gone out. */
export function spokenOpenTextSent(practice: string): string {
  return `Thanks for calling ${practice}. Sorry we could not get to your call, we've just sent you a text so we can help you book.`;
}

/** Outside hours, nothing texted (suppressed, switched off, or the send failed). */
export function spokenClosedNoText(practice: string): string {
  return `Thanks for calling ${practice}. We're currently closed. Please call back during our opening hours and we will be happy to help.`;
}

/** Outside hours, a text has actually gone out on this call. */
export function spokenClosedTextSent(practice: string): string {
  return `Thanks for calling ${practice}. We're currently closed. We've just sent you a text so we can help you book.`;
}

/** Outside hours, a repeat call inside the dedup window: the earlier text stands. */
export function spokenClosedAlreadyTexted(practice: string): string {
  return `Thanks for calling ${practice}. We're currently closed. We've already texted you so we can help you book.`;
}

// --- SMS bodies --------------------------------------------------------------

/**
 * The bare after-hours fallback text, sent only when the speed-to-lead bridge
 * could not draft one. Invites a reply so the conversational agent picks it up.
 */
export function afterHoursFallbackSms(practice: string): string {
  return `Hi, sorry we missed you at ${practice}. We're currently closed but I can help you book by text, just reply here with what you need.`;
}

/**
 * The in-hours overflow text: the practice was open but nobody could pick up.
 *
 * Promises a callback rather than opening hours, because the call landed inside
 * them, and the capture it accompanies becomes a callback task on the worklist.
 */
export function inHoursCallbackSms(practice: string): string {
  return `Hi, sorry we could not get to your call at ${practice}. We have your number and will call you back, or reply here and I can help you book.`;
}

// --- TwiML safety ------------------------------------------------------------

/**
 * Escape a spoken line for an XML text node.
 *
 * The practice name is configuration, so an ampersand in it ("Smith & Partners")
 * would otherwise emit malformed TwiML and the caller would hear a Twilio
 * application error instead of a message. Only the three characters that are
 * actually special in a text node are escaped; quotes and apostrophes are legal
 * there, and escaping them would churn every existing line for nothing.
 */
export function escapeForTwiml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
