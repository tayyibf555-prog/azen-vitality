// THE SERVER-SIDE HALF: what we are willing to tell Meta that a submission
// happened, and what we are not.
//
// ============================================================================
// WHY A SERVER EVENT EXISTS AT ALL WHEN THE BROWSER ALREADY FIRES ONE.
//
// The browser Lead event is lost to ad blockers, to Safari's tracking prevention,
// and to every visitor who closes the tab in the second between the submit and
// the pixel call. Meta's Conversions API is the same conversion reported from the
// server, deduplicated against the browser one by a shared `event_id`. A practice
// that measures its ad spend on browser events alone under-counts, and an ad
// account optimising on an under-count spends the practice's money badly.
//
// THE PAYLOAD IS THE POINT OF THIS MODULE. A server-to-server call is invisible —
// no network tab, no cookie banner, no way for anybody outside this repository to
// see what left. So what leaves is decided HERE, in a pure function, against a
// test that asserts on the exact serialised bytes.
//
// THE DEFAULT EVENT CARRIES NO PERSONAL DATA. Not "hashed personal data": none.
// No email, no phone, no name, no IP address, no user agent, no _fbp/_fbc cookie,
// no answers, no score, no band. `event_name`, `event_time`, `event_source_url`,
// `action_source` and an opaque `event_id` — which together say "a submission
// happened on this page at this time" and identify nobody.
//
// AND THAT IS A KNOWN, DELIBERATE TRADE. Meta matches such an event to a person
// poorly or not at all, so the ad account learns less from it than it would from
// a fully-matched one. That is the correct direction to be wrong in. A weakly
// attributed conversion is a measurement problem; sending a patient's contact
// details to Meta because a default was convenient is a disclosure, and it is not
// ours to make on their behalf.
//
// TWO KEYS TOGETHER UNLOCK ANYTHING MORE, and they are held by different people:
//   * the VISITOR consented to Meta tracking on this device (meta-pixel.ts), and
//   * the PRACTICE deliberately switched advanced matching on (default off).
// Either alone sends the anonymous event. `capiUserData` is the one function that
// can produce identifiers, it takes both booleans, and there is no other way to
// get a `user_data` object into a payload.
//
// PURE. node:crypto for the hash and nothing else — no fetch, no environment, no
// secret. The network call, the access token, the timeout and the budget guard
// all live in meta-capi-send.ts, which is server-only. This half is a data
// transformation, and it is tested as one.
// ============================================================================

import { createHash } from "node:crypto";
import { META_API_VERSION } from "@/lib/meta-ads/publish";

/* ---------------------------------------------------------------------------
 * 1. The endpoint.
 * ------------------------------------------------------------------------- */

/**
 * Where a dataset's events are posted.
 *
 * The Graph version is IMPORTED from the publish adapter rather than retyped, so
 * the practice's campaign publisher and its conversion reporting can never end up
 * speaking to two different versions of the same API. Bumping Meta's version stays
 * the one-line change publish.ts promises.
 *
 * The pixel id is interpolated into a URL PATH here, so the same digits-only
 * grammar that guards the <script> body guards this: callers pass a value that has
 * been through `normalisePixelId`, and the sender re-checks before it builds the
 * request (there is no path from an unvalidated string to a URL).
 */
export function capiEndpoint(pixelId: string): string {
  return `https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events`;
}

/* ---------------------------------------------------------------------------
 * 2. Normalisation and hashing.
 * ------------------------------------------------------------------------- */

/**
 * SHA-256, lowercase hex — the only form Meta accepts for a matching key, and the
 * only form anything leaves this module in.
 *
 * There is no "send it in the clear" branch anywhere in this file, and no
 * parameter that could select one. The plain value exists inside `capiUserData`
 * for the length of one expression and is never returned, logged or stored.
 */
export function hashForMeta(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * An email in Meta's canonical form, or null.
 *
 * Trimmed and lowercased, which is Meta's documented normalisation. Nothing
 * further: gmail dot-stripping and plus-address folding are things some tools do,
 * they are not in the specification, and a "helpful" transform would hash an
 * address the patient never gave us.
 */
export function normaliseEmailForMeta(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  // A minimal shape check, not a validator: the submit route has already refused
  // anything undeliverable. This only stops an obviously-not-an-address string
  // being hashed into a matching key that can never match.
  if (!trimmed || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * A phone number in Meta's canonical form, or null.
 *
 * Digits only, country code included, no `+` and no separators — which is exactly
 * what an E.164 number minus its plus sign is, and E.164 is what the submit route
 * has already canonicalised to (toE164). A number with no country code would hash
 * to a key that matches nobody, so anything shorter than a plausible international
 * number is dropped rather than sent as noise.
 */
export function normalisePhoneForMeta(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/[^0-9]/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

/* ---------------------------------------------------------------------------
 * 3. The event.
 * ------------------------------------------------------------------------- */

/**
 * Meta's name for "somebody enquired". A closed union rather than a string,
 * because the event name is what an ad account optimises towards and a typo would
 * report conversions into a bucket nobody is bidding on.
 */
export type CapiEventName = "Lead";

/** The matching keys we are ever prepared to send, hashed. Nothing else exists. */
export interface CapiUserData {
  /** sha256(lowercased, trimmed email). Meta's `em`. */
  em?: string[];
  /** sha256(digits-only phone). Meta's `ph`. */
  ph?: string[];
}

/** One event, exactly as it is serialised. Optional fields are ABSENT, not null. */
export interface CapiEvent {
  event_name: CapiEventName;
  /** Unix seconds. Meta refuses an event more than seven days old. */
  event_time: number;
  /** The page the visitor was on. */
  event_source_url?: string;
  /** Always "website": this conversion happened on a web page. */
  action_source: "website";
  /** Shared with the browser event so Meta counts one conversion, not two. */
  event_id?: string;
  /** Present ONLY under consent + advanced matching. See capiUserData. */
  user_data?: CapiUserData;
}

/**
 * THE FIELDS THAT MUST NEVER APPEAR IN A PAYLOAD, named so a test can assert on
 * them by name rather than by inspection.
 *
 * Each is a legitimate, documented, commonly-used CAPI field, and each is one we
 * refuse. `client_ip_address` and `client_user_agent` are the pair Meta leans on
 * hardest for matching and are the two that turn an anonymous event into a
 * personal one without any contact detail being involved at all. `fbp`/`fbc` are
 * the pixel's own cookies, which on this page exist only where the visitor has
 * already consented — and re-sending them from the server would be a second,
 * unasked-for channel for the same identifier.
 *
 * This constant is not consulted by the builder. It cannot be: the builder emits
 * a closed set of keys, so there is nothing to filter. It exists so that
 * meta-capi.test.ts fails loudly the day somebody adds one of them.
 */
export const CAPI_FORBIDDEN_FIELDS = [
  "client_ip_address",
  "client_user_agent",
  "fbp",
  "fbc",
  "external_id",
  "fn",
  "ln",
  "ct",
  "zp",
  "country",
  "custom_data",
] as const;

/**
 * The hashed matching keys for this submission, or undefined.
 *
 * BOTH BOOLEANS ARE REQUIRED AND NEITHER HAS A DEFAULT. They are separate
 * arguments rather than one "allowed" flag so that a caller cannot satisfy the
 * gate by computing the conjunction somewhere less visible, and so that the two
 * decisions — the visitor's and the practice's — stay two decisions all the way
 * down to the byte that leaves.
 *
 * Returns undefined rather than an empty object when there is nothing to send:
 * `user_data: {}` in a payload is a claim that we looked and found nobody, and it
 * is one Meta's API answers with an error. Absent means absent.
 */
export function capiUserData(input: {
  consented: boolean;
  advancedMatching: boolean;
  email?: string | null;
  phone?: string | null;
}): CapiUserData | undefined {
  if (!input.consented || !input.advancedMatching) return undefined;

  const email = normaliseEmailForMeta(input.email);
  const phone = normalisePhoneForMeta(input.phone);
  const data: CapiUserData = {};
  if (email) data.em = [hashForMeta(email)];
  if (phone) data.ph = [hashForMeta(phone)];
  return data.em || data.ph ? data : undefined;
}

export interface LeadEventInput {
  /** Unix MILLISECONDS (Date.now()). Converted here so no caller does it twice. */
  nowMs: number;
  /** The public assessment page the visitor submitted from. */
  sourceUrl?: string | null;
  /** The id the browser used for its own Lead event, for deduplication. */
  eventId?: string | null;
  /** Did this device's visitor consent to Meta tracking? */
  consented: boolean;
  /** Has the practice switched advanced matching on? */
  advancedMatching: boolean;
  email?: string | null;
  phone?: string | null;
}

/**
 * The event for one assessment submission.
 *
 * WHAT IT REFUSES TO CARRY is as deliberate as what it carries, and none of it is
 * available to a caller: there is no parameter for the patient's name, their
 * answers, their score, their band, the treatment they asked about, their IP or
 * their user agent. A future edit that wanted to send any of those would have to
 * change this signature, which is a diff a reviewer sees.
 *
 * `event_source_url` is validated rather than trusted. It is built by the caller
 * from the request's own origin and slugs it has already resolved, so it is not
 * attacker-controlled — but it is the one string in the payload assembled from
 * anything outside this file, and a malformed URL is worth dropping rather than
 * sending.
 */
export function buildLeadEvent(input: LeadEventInput): CapiEvent {
  const event: CapiEvent = {
    event_name: "Lead",
    // Seconds, floored: Meta reads this field as an integer and a millisecond
    // value reads as a date roughly fifty thousand years hence, which it rejects.
    event_time: Math.floor(input.nowMs / 1000),
    action_source: "website",
  };

  const url = safeHttpUrl(input.sourceUrl);
  if (url) event.event_source_url = url;

  const eventId = normaliseEventId(input.eventId);
  if (eventId) event.event_id = eventId;

  const userData = capiUserData({
    consented: input.consented,
    advancedMatching: input.advancedMatching,
    email: input.email,
    phone: input.phone,
  });
  if (userData) event.user_data = userData;

  return event;
}

/** The request body: Meta takes a batch, and ours is always exactly one event. */
export function buildCapiBody(event: CapiEvent): { data: CapiEvent[] } {
  return { data: [event] };
}

/* ---------------------------------------------------------------------------
 * 4. The two small parsers the builder leans on.
 * ------------------------------------------------------------------------- */

/**
 * An http(s) URL with its query string REMOVED, or null.
 *
 * The strip is not tidiness. An /assess page can be reached with whatever an ad
 * platform appended — utm parameters, click ids, and on a badly built landing
 * link, occasionally a name or an email. Sending the query string would be a way
 * for personal data to reach Meta through a field nobody was thinking about, in
 * the one payload this module promises carries none. The path identifies the
 * funnel, which is all this field is for.
 */
function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The browser's event id, or null.
 *
 * Opaque and caller-supplied, so it is bounded and restricted to characters that
 * cannot mean anything anywhere: a uuid or the base36 fallback the beacon uses.
 * It identifies nobody — it exists purely so Meta can recognise the browser event
 * and this one as the same conversion.
 */
function normaliseEventId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(trimmed) ? trimmed : null;
}
