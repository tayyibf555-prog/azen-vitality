import { clientIdForSites } from "@/lib/mock/clients";
import { clientIp } from "@/lib/http/client-ip";
import { consumeBudget } from "@/lib/rate-budget";
import {
  canAdvanceFunnelProgress,
  parseFunnelProgressPost,
} from "@/lib/smile-assessment/funnel-progress";
import {
  advanceLeadFunnelProgress,
  findLeadFunnelSession,
} from "@/lib/speed-to-lead/repository";
import { isSystemEnabledStrict } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

// PUBLIC: "the session holding this token has now reached screen N of the funnel
// it is walking." Written forward from the funnel runtime AFTER the contact step
// has been submitted, so the lead already exists and this only ever moves a
// number on it.
//
// WHAT IT CAN AND CANNOT DO, which is the whole security story:
//
//   IT CAN   raise funnel_last_step on exactly ONE lead — the one whose
//            funnel_session_nonce equals the token on the post — and stamp
//            funnel_completed_at when that step is the funnel's last screen.
//   IT CANNOT touch any other column of that lead (not stage, not consent, not
//            updated_at), any other lead, or any other table. It sends no message,
//            makes no model call, writes nothing to Dentally and creates nothing.
//
// THE TOKEN IS THE WHOLE AUTHORISATION, and it is a bearer on purpose: no session
// exists here (a patient's browser is the caller, mid-funnel, on a public page), so
// there is nothing else to authenticate with. It is minted on the SERVER with
// crypto.randomUUID when the lead is created, handed back to that one browser in
// the submit response, and stored under a UNIQUE index (0094) so it names at most
// one lead. A caller who does not have it cannot address a row, cannot enumerate
// one, and — because every outcome below produces the same opaque 202 — cannot
// learn whether a token exists either.
//
// IT NEVER READS A PATIENT. findLeadFunnelSession selects seven columns by name;
// the name, phone and email on that row never enter this process. That is a
// property of the query, not a promise about the handler.
//
// ABUSE POSTURE, mirroring the step-event beacon (its sibling, and the closest
// thing in the tree to this shape). The cost of abuse here is one indexed read and
// at most one single-row update, so the guards are shaped around request volume,
// cheapest and broadest first:
//
//   1. PAYLOAD CAP, before the body is read. A progress post is a token, a version
//      and an integer — well under 200 bytes.
//   2. PER-IP burst budget, so one flooder is blunted across every instance
//      (unlike an in-process counter, which resets on a cold start). Consumed
//      FIRST, which also bounds how many api_budget keys a single caller can mint.
//   3. PER-TOKEN budget, so a token that leaked (or a session with a stuck loop)
//      cannot be used to hammer one row. A funnel session posts a handful of times
//      in its life; anything past this is not a patient walking a funnel.
//
// Deliberately NOT a global ceiling: one shared key would let a flood switch off
// progress recording for every real patient, and blinding the practice is a worse
// outcome than the extra rows a per-IP cap already bounds.
//
// KILL SWITCH: STRICT, i.e. fail CLOSED, exactly as both public /assess pages and
// the step beacon are — and resolved from the LEAD'S OWN SITE rather than from a
// slug on the post, so a caller cannot present a practice whose system is on while
// addressing a lead belonging to one whose system is off.

/**
 * The payload cap. `{token, flowVersion, step}` with a 36-character UUID is about
 * 70 bytes; 512 is generous headroom and still refuses anything trying to STORE
 * something here rather than report a step.
 *
 * Checked twice against two different units, and neither is a mistake: the
 * Content-Length header is BYTES and can be absent or lied about, so the
 * authoritative check is the JS string LENGTH of the text actually read.
 */
const MAX_BODY = 512;

const IP_BUDGET_LIMIT = 240; // posts per IP per hour
const IP_BUDGET_WINDOW_SECONDS = 60 * 60;

const TOKEN_BUDGET_LIMIT = 60; // posts per token per hour
const TOKEN_BUDGET_WINDOW_SECONDS = 60 * 60;

/**
 * ONE opaque acknowledgement for every outcome — accepted, dropped, unknown token,
 * wrong version, a step that would go backwards, over budget, system switched off,
 * update failed, 0094 not applied. An endpoint that answered differently for a
 * real token than for a made-up one would be an oracle for guessing them, and
 * telling the caller whether the write landed reveals a lead exists. Same call
 * step-event's `ack()` makes, and the tests compare the body byte for byte.
 */
function ack(): Response {
  return Response.json({ ok: true }, { status: 202 });
}

export async function POST(request: Request): Promise<Response> {
  try {
    // (1) Payload cap, twice. The header is a fast pre-guard; the text is the rule.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY) return ack();

    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return ack();
      body = JSON.parse(text);
    } catch {
      return ack();
    }

    // CONSTRUCTED, never spread: the parser returns exactly three keys, so no key
    // the caller invented reaches anything below — there is no field here for a
    // stage, a lead id or a phone number to arrive in.
    const post = parseFunnelProgressPost(body);
    if (!post) return ack();

    // (2)(3) The durable, distributed ceilings. Each fails OPEN on a DB blip
    // (rate-budget.ts), so a transient outage degrades the cap rather than breaking
    // the chain — acceptable because the worst case is extra reads on an indexed
    // lookup, not extra spend and not an extra message to a patient.
    const ip = clientIp(request);
    if (
      !(await consumeBudget(`assess-progress-ip:${ip}`, IP_BUDGET_LIMIT, IP_BUDGET_WINDOW_SECONDS))
    ) {
      return ack();
    }
    if (
      !(await consumeBudget(
        `assess-progress:${post.token}`,
        TOKEN_BUDGET_LIMIT,
        TOKEN_BUDGET_WINDOW_SECONDS,
      ))
    ) {
      return ack();
    }

    // THE ONLY LOOKUP. A unique-index seek on the token; no token, no row, nothing
    // to say. Note that this is also the only place the caller's string is used at
    // all — it is never interpolated into a filter, never logged, never returned.
    const session = await findLeadFunnelSession(post.token);
    if (!session) return ack();

    // The owner's "stop", resolved from the lead's own site. STRICT: off means no
    // write, an unreadable switch means no write, and the caller cannot tell either
    // from a successful post. A lead whose site does not resolve to exactly one
    // practice is refused rather than defaulted — clientIdForSites returns null
    // precisely so an unresolved tenant never lands in another practice's answer.
    const clientId = clientIdForSites([session.siteId]);
    if (!clientId) return ack();
    if (!(await isSystemEnabledStrict(clientId, "smile-assessment"))) return ack();

    // The three rules, in the shared pure module rather than inline here: forward
    // only, inside the funnel, same flow version. This is the early exit; the
    // conditional UPDATE below is the guard (see advanceLeadFunnelProgress).
    if (
      !canAdvanceFunnelProgress({
        current: session.progress,
        flowVersion: post.flowVersion,
        step: post.step,
      })
    ) {
      return ack();
    }

    await advanceLeadFunnelProgress({
      leadId: session.id,
      nonce: post.token,
      flowVersion: post.flowVersion,
      step: post.step,
      // The ceiling comes from the ROW, never from the request: the caller may say
      // which screen they reached, never how long their funnel is.
      totalSteps: session.progress.totalSteps ?? 0,
    });
    return ack();
  } catch {
    // Progress never errors the caller — including when 0094 has not been applied,
    // in which case every post is silently dropped and the funnel is unaffected.
    return ack();
  }
}
