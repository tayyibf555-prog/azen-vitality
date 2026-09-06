// ===========================================================================
// WHAT AN SMS ACTUALLY COSTS, COUNTED THE WAY THE CARRIER COUNTS IT.
//
// `String.prototype.length` counts UTF-16 code units and knows nothing about
// the alphabet a phone network bills in. That is the measure this module's
// one-credit ceiling used to be written in, and it certified "one credit" for
// bodies the carrier splits into two or three:
//
//   "Hi Christopher, N15 Vitality Dental here. …"   141 chars, GSM-7, 1 segment
//   "Hi Sian, …" with the â                          134 chars, UCS-2, 2 segments
//   "Hi Malgorzata, …" with the ł                    140 chars, UCS-2, 3 segments
//
// Every one of those is 160-or-fewer "characters". Two of them are not one
// credit. The difference is not length at all — it is a single letter that
// GSM 03.38 has no code point for, which forces the WHOLE message into UCS-2
// and takes the single-segment ceiling from 160 down to 70. A north London
// list of 51,000 patients is full of Polish, Turkish, Romanian and Vietnamese
// first names, and the pre-visit message copies the first name verbatim out of
// the Dentally record, so this is an ordinary case and not an edge one.
//
// It matters to a number the client has been shown: the platform's SMS bill was
// compared with Dentally's on a 1.69-segment break-even, and a cohort that
// silently costs three segments a message sits on the wrong side of it.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A MEASURE AND NOT A GATE.
// ---------------------------------------------------------------------------
// Nothing here refuses anything. Refusing to text somebody because of how their
// name is spelled is not an acceptable remedy — it would silence exactly the
// patients whose names this platform does not get to edit — so the module that
// composes the message keeps its own length rule (./copy.ts) and this one
// supplies the honest figure beside it. Charter §0/5: a number that cannot be
// shown to be true is qualified or not printed, never dressed up.
//
// ---------------------------------------------------------------------------
// WHERE THIS BELONGS EVENTUALLY.
// ---------------------------------------------------------------------------
// Nothing about it is pre-visit specific: every module that queues an SMS bills
// in these units, and today none of them counts. It lives here because this is
// the module whose contract was wrong about it, and it is written with no
// dependency on anything in this directory so it can be lifted into
// src/lib/messaging/ whole when a lane owns that directory.
//
// The tables are GSM 03.38: the default alphabet at one septet a character, and
// the escape-table characters (^ { } \ [ ~ ] | € and form feed) at two, because
// each is transmitted as ESC + the code point.
// ===========================================================================

/**
 * The GSM 03.38 default alphabet, in code-point order, with 0x1B (ESC) left
 * out — it is the escape marker, never a character in its own right.
 */
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅå" + // 0x00-0x0F
  "Δ_ΦΓΛΩΠΨΣΘΞ" + //                  0x10-0x1A
  "ÆæßÉ" + //                                                       0x1C-0x1F
  " !\"#¤%&'()*+,-./" + //                                                          0x20-0x2F
  "0123456789:;<=>?" + //                                                                0x30-0x3F
  "¡ABCDEFGHIJKLMNO" + //                                                           0x40-0x4F
  "PQRSTUVWXYZÄÖÑÜ§" + //                                       0x50-0x5F
  "¿abcdefghijklmno" + //                                                           0x60-0x6F
  "pqrstuvwxyzäöñüà"; //                                        0x70-0x7F

/** The escape table. Each of these costs TWO septets, not one. */
const GSM7_EXTENDED = "\f^{}\\[~]|€";

const BASIC = new Set(GSM7_BASIC.split(""));
const EXTENDED = new Set(GSM7_EXTENDED.split(""));

/** One GSM-7 message on its own. */
export const SMS_GSM7_SINGLE = 160;
/** One GSM-7 message inside a concatenated set: 7 septets go to the UDH. */
export const SMS_GSM7_CONCAT = 153;
/** One UCS-2 message on its own, in UTF-16 code units. */
export const SMS_UCS2_SINGLE = 70;
/** One UCS-2 message inside a concatenated set. */
export const SMS_UCS2_CONCAT = 67;

export interface SmsCost {
  /** What the carrier will encode this body as. */
  encoding: "gsm7" | "ucs2";
  /** Septets for gsm7, UTF-16 code units for ucs2. The billed unit. */
  units: number;
  /** How many messages the practice pays for. */
  segments: number;
  /**
   * The one character that forced UCS-2, when one did. Named so a report can
   * say WHY a message costs three credits instead of leaving it a mystery.
   */
  forcedUcs2By: string | null;
}

/** True when every character of `text` is carried by GSM 03.38. */
export function isGsm7(text: string): boolean {
  return firstNonGsm7(text) === null;
}

/** The first character GSM 03.38 cannot carry, or null. */
export function firstNonGsm7(text: string): string | null {
  for (const ch of text) {
    if (!BASIC.has(ch) && !EXTENDED.has(ch)) return ch;
  }
  return null;
}

/**
 * What this body costs to send.
 *
 * GSM-7 septets count the escape-table characters twice, which `text.length`
 * never did: a body of 160 characters holding one `[` is already two segments.
 * UCS-2 counts UTF-16 code units, which is what the carrier's 70/67 ceilings
 * are expressed in — a character outside the BMP is two of them, as it is on
 * the wire.
 */
export function smsCost(text: string): SmsCost {
  const body = text ?? "";
  const forcedUcs2By = firstNonGsm7(body);
  if (forcedUcs2By !== null) {
    const units = body.length;
    const segments = units === 0 ? 1 : units <= SMS_UCS2_SINGLE ? 1 : Math.ceil(units / SMS_UCS2_CONCAT);
    return { encoding: "ucs2", units, segments, forcedUcs2By };
  }
  let units = 0;
  for (const ch of body) units += EXTENDED.has(ch) ? 2 : 1;
  const segments = units === 0 ? 1 : units <= SMS_GSM7_SINGLE ? 1 : Math.ceil(units / SMS_GSM7_CONCAT);
  return { encoding: "gsm7", units, segments, forcedUcs2By: null };
}

/**
 * The septet count used as a LENGTH rule rather than as a cost.
 *
 * ./copy.ts's one-credit ceiling is enforced on this, and the distinction is
 * deliberate. As a cost, a UCS-2 body's unit is not a septet at all; as a
 * length rule, what the ceiling is protecting against is the TEMPLATE growing
 * — an edit that adds a clause, a practice name nobody expected, a first name
 * that is a 40-character payload — and for that a character GSM-7 cannot carry
 * is still one character. Counting it as one septet keeps the escape-table fix
 * (a `[` really is two) while leaving the send/no-send decision for an ordinary
 * name in an ordinary alphabet exactly where it was: a patient is never left
 * unmessaged because of how their name is spelled.
 */
export function gsm7LengthUnits(text: string): number {
  let units = 0;
  for (const ch of text ?? "") units += EXTENDED.has(ch) ? 2 : 1;
  return units;
}
