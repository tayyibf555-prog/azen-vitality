import crypto from "crypto";

// ===========================================================================
// THE PRE-VISIT LINK.
//
// A patient opens /pv/<token>. The token is 22 base64url characters of CSPRNG
// randomness, minted on the target row and stored under a unique index.
//
// ---------------------------------------------------------------------------
// WHY NOT mintPatientToken (src/lib/public-link/patient-token.ts).
// ---------------------------------------------------------------------------
//
// That module exists, it is tested, it is the right shape for the medical-history
// and FP17 links, and this module deliberately does not use it. Three reasons,
// and the first is the one that decided it:
//
//   1. LENGTH, AND THEREFORE COST. A signed patient token is
//      base64url(JSON{siteId, patientRef, purpose}) + "." + 64 hex characters —
//      about 170 characters before the origin. One SMS credit is 160 GSM-7
//      characters TOTAL. So a signed-token link cannot fit in a one-credit message
//      with a greeting, and the brief this module was built to would be broken by
//      its own link. A 22-character id plus origin is ~45 characters and leaves
//      room for a sentence.
//
//   2. REVOCABILITY. A signed token is valid for as long as the server key is,
//      which is for ever: a link texted before one appointment still opens the
//      form a year later. This id is a COLUMN, so the row decides. The public
//      page refuses a target that is already `answered` or `stopped`, and the
//      appointment it belongs to is the natural expiry. An HMAC cannot express
//      "this link has been used".
//
//   3. NO IDENTITY IN THE URL. A signed token CARRIES { siteId, patientRef } —
//      recoverable by anyone holding the URL, because the payload is base64, not
//      encrypted; the signature stops forgery, not reading. This id carries
//      nothing at all. A pre-visit link is pasted into browser history, appears in
//      a referrer, and sits in a phone's message list, and the less it says about
//      who it belongs to the better.
//
// What we give up is statelessness: verifying costs a database read. That is the
// right trade for a link the server was going to have to look up anyway to find
// out whether it had already been answered.
//
// 128 bits of entropy over ~50k patients makes guessing a live link a non-event,
// and the lookup is by unique index so a wrong guess costs one indexed miss.
// ===========================================================================

/** Characters in the token. 22 base64url chars = 132 bits, of which we use 128. */
const TOKEN_BYTES = 16;

/** Mint a fresh, unguessable link id. */
export function mintTriageLinkToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Shape check before the database is asked. Cheap, and it means a probe posting
 * junk never reaches a query at all.
 *
 * NOT an authorisation: a well-shaped token that names no row is refused by the
 * lookup. This only rejects what cannot possibly be one of ours.
 */
export function isTriageLinkTokenShaped(token: string | null | undefined): boolean {
  return typeof token === "string" && /^[A-Za-z0-9_-]{22}$/.test(token);
}

/**
 * The absolute /pv/<token> link, or a root-relative one when PUBLIC_BASE_URL is
 * unset (local dev).
 *
 * Mirrors buildMedicalHistoryLink's contract exactly, so the two pre-visit links
 * are built the same way even though they are minted differently.
 */
export function buildTriageLink(
  token: string,
  baseUrl: string | undefined = process.env.PUBLIC_BASE_URL,
): string | null {
  if (!isTriageLinkTokenShaped(token)) return null;
  const base = baseUrl && baseUrl.startsWith("http") ? baseUrl.replace(/\/$/, "") : "";
  return `${base}/pv/${token}`;
}
