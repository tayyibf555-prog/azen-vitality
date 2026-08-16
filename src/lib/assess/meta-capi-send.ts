import "server-only";
import { consumeBudget } from "@/lib/rate-budget";
import { buildCapiBody, buildLeadEvent, capiEndpoint, type LeadEventInput } from "./meta-capi";
import { normalisePixelId, type MetaPixelConfig } from "./meta-pixel";

// THE OUTBOUND CALL, and the one rule that governs every line of it:
//
//   ============================================================================
//   NOTHING IN THIS FILE MAY EVER FAIL A PATIENT'S SUBMISSION.
//   ============================================================================
//
// It is called from the public submit route, immediately after the assessment has
// been recorded and the practice has been told about the enquiry. Everything it
// does is BOOKKEEPING FOR AN AD ACCOUNT. A missing token, an un-applied migration,
// a Meta outage, a rate limit, a DNS failure, a five-second stall — none of those
// is a reason a patient sees "Sorry, something went wrong". So:
//
//   * `sendAssessmentLeadEvent` has no throwing path. Every branch returns a
//     `CapiSendResult` naming what happened, and the whole body is inside one
//     try/catch as a backstop for anything the branches did not anticipate.
//   * it never returns anything the caller has to act on. The result exists for
//     logging and for tests; the submit route ignores it by design.
//   * the fetch is time-boxed. An un-bounded call would hold a serverless
//     invocation open behind a patient waiting for a thank-you screen.
//
// FAIL-OPEN MEANS "SKIP THE EVENT", NOT "SEND ANYWAY". That is the direction the
// budget guard fails in here, and it is the opposite of the direction
// `consumeBudget` itself fails in: the shared helper returns TRUE on a database
// error, because for the routes it was written for (the public quiz, the landing
// lead) the cost of a blip is a broken patient-facing flow, and letting the call
// through is the lesser evil. Here the call IS the optional thing, so this module
// treats any doubt as a reason not to spend. There is no outcome in which a
// budget problem reaches the patient.

/** The Conversions API access token. Environment only — never a database column. */
const TOKEN_ENV = "META_CAPI_ACCESS_TOKEN";

/**
 * How many conversion events one practice may report per minute.
 *
 * Sized as a CEILING, not a target. A single practice's real assessment volume is
 * a handful an hour; the submit route's own budget already caps submissions at 60
 * per campaign per minute, so this can only ever bite during an abusive flood, and
 * during one it is the thing that stops that flood being amplified into paid API
 * calls against the practice's ad account.
 */
const CAPI_BUDGET_LIMIT = 60;
const CAPI_BUDGET_WINDOW_SECONDS = 60;

/** Longer than this and the patient is waiting on an ad platform. They are not. */
const CAPI_TIMEOUT_MS = 2500;

/** What happened, for a log line and for the tests. Never for the patient. */
export type CapiSendResult =
  /** Meta accepted the event. */
  | { sent: true }
  /** It was not sent, and why. Every one of these is a normal, silent outcome. */
  | {
      sent: false;
      reason:
        | "disabled" // the practice has not switched tracking on
        | "no-token" // no META_CAPI_ACCESS_TOKEN in this environment
        | "budget" // this practice's per-minute ceiling is spent
        | "http" // Meta answered with an error status
        | "error"; // network, timeout, or anything else at all
    };

export interface SendLeadInput extends Omit<LeadEventInput, "advancedMatching"> {
  /** The practice, for the budget key. */
  clientId: string;
  /** Its resolved tracking config. `enabled: false` short-circuits everything. */
  config: MetaPixelConfig;
}

/**
 * Report one assessment submission to Meta's Conversions API.
 *
 * THE ORDER OF THE GATES IS THE DESIGN:
 *
 *   1. CONFIG. A practice that has not switched tracking on costs nothing at all —
 *      no budget row, no environment read, no network. This is the branch the
 *      overwhelming majority of submissions take, forever.
 *   2. GRAMMAR. The pixel id goes into a URL path, so it is re-validated here even
 *      though `metaPixelConfig` already did it on the way out of the row. This is
 *      the last function before a string becomes a request.
 *   3. TOKEN. Absent in local development and in any deployment that has not been
 *      given one, which is the honest default: the feature is then configured but
 *      inert, and says so.
 *   4. BUDGET. Consumed BEFORE the call, so a flood cannot spend an ad account's
 *      API quota, and treated as a refusal on any doubt.
 *   5. THE CALL.
 *
 * `advancedMatching` IS TAKEN FROM THE CONFIG AND CANNOT BE PASSED IN. The
 * signature omits it deliberately: a caller that could supply it could turn
 * hashed contact details on for one submission without the practice's setting
 * saying so. The visitor's own `consented` flag is a parameter, because only the
 * caller knows what this particular browser said — and both are required before
 * `capiUserData` produces anything.
 */
export async function sendAssessmentLeadEvent(input: SendLeadInput): Promise<CapiSendResult> {
  try {
    const { config } = input;
    if (!config.enabled || !config.pixelId) return { sent: false, reason: "disabled" };

    const pixelId = normalisePixelId(config.pixelId);
    if (!pixelId) return { sent: false, reason: "disabled" };

    const token = (process.env[TOKEN_ENV] ?? "").trim();
    if (!token) return { sent: false, reason: "no-token" };

    // Per practice, so one busy account cannot spend another's ceiling. Wrapped:
    // `consumeBudget` swallows its own errors, but a thrown one here would
    // otherwise escape into the submit route's happy path.
    let allowed = false;
    try {
      allowed = await consumeBudget(
        `meta-capi:${input.clientId}`,
        CAPI_BUDGET_LIMIT,
        CAPI_BUDGET_WINDOW_SECONDS,
      );
    } catch {
      allowed = false;
    }
    if (!allowed) return { sent: false, reason: "budget" };

    const event = buildLeadEvent({
      nowMs: input.nowMs,
      sourceUrl: input.sourceUrl,
      eventId: input.eventId,
      consented: input.consented,
      advancedMatching: config.advancedMatching,
      email: input.email,
      phone: input.phone,
    });

    const response = await fetch(capiEndpoint(pixelId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // THE TOKEN GOES IN THE BODY, NEVER THE QUERY STRING. Meta accepts either.
      // A query string is logged by every proxy, CDN and error reporter between
      // here and Graph, so a credential in one is a credential in half a dozen
      // logs nobody audits.
      body: JSON.stringify({ ...buildCapiBody(event), access_token: token }),
      signal: AbortSignal.timeout(CAPI_TIMEOUT_MS),
      cache: "no-store",
    });

    if (!response.ok) {
      // The status alone. Meta's error bodies quote the payload back, which for a
      // matched event contains the hashes we were careful about — so the body is
      // deliberately not read and never logged.
      console.warn(`[assess] Meta CAPI refused an event for ${input.clientId}: ${response.status}`);
      return { sent: false, reason: "http" };
    }
    return { sent: true };
  } catch {
    // Network, DNS, timeout, an unexpected shape — all the same thing from here:
    // a conversion Meta will not hear about. The patient's submission is already
    // recorded and their enquiry already with the practice.
    return { sent: false, reason: "error" };
  }
}
