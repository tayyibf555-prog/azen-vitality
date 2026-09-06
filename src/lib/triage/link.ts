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
 * The absolute /pv/<token> link, or NULL — never a root-relative path.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FAILS CLOSED, WHERE ITS SIBLINGS FALL BACK.
 * ---------------------------------------------------------------------------
 * `buildMedicalHistoryLink`, `src/lib/fp17/link.ts` and `src/lib/messaging/
 * pref-token.ts` all return a root-relative "/…/<token>" when no public origin
 * is configured, and that is right for them: every one of those is a link a
 * STAFF MEMBER copies out of a screen, where a path is a usable thing to have
 * in local dev and nothing is transmitted.
 *
 * This one is different, and it is the only one of the family that is
 * different: its single caller is the pre-visit sweep, which puts the result
 * straight into an SMS body (src/app/api/previsit/sweep/route.ts, `compose`).
 * "A few quick questions before your visit: /pv/AbCdEf…" is a text no phone
 * renders as a link, so it is the message ./copy.ts refuses by name — "a link
 * that is the empty string is a message asking the patient to tap nothing" —
 * arriving in a form that composer's emptiness check cannot see. One SMS
 * credit is spent per appointment, the target moves to `sent`, the run report
 * counts it queued and delivered, and the practice sees zero completions with
 * no reason for it. That is a silent failure in both directions, which is
 * exactly what the fail-CLOSED direction (W1-B/1-5) exists to stop.
 *
 * So an origin that is not an http(s) origin is treated the same way as a
 * malformed token: NO LINK. The sweep already has the branch for it, and its
 * `no_link` stop reason now fires for the misconfiguration its own comment
 * names (PUBLIC_BASE_URL unset or set without a scheme — the roster lists it
 * at src/lib/agent-wiring/roster.ts as a pre-visit "Needs first", and nothing
 * else in the tree validates its shape) as well as for a corrupt stored token.
 * The pattern is the one src/app/api/closer/sweep/route.ts already uses.
 *
 * `startsWith("http")` — not a URL parse — because the mock and local dev both
 * serve http://localhost:3000 and "https" begins with "http". Anything else
 * (a bare "azen-vitality.vercel.app", "ftp://…", "" ) is refused.
 */
export function buildTriageLink(
  token: string,
  baseUrl: string | undefined = process.env.PUBLIC_BASE_URL,
): string | null {
  if (!isTriageLinkTokenShaped(token)) return null;
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return null;
  return `${baseUrl.replace(/\/$/, "")}/pv/${token}`;
}
