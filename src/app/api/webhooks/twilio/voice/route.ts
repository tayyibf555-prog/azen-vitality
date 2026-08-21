import { runWithDentallyPriority } from "@/lib/dentally/budget";
import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { sendMessage } from "@/lib/messaging/send";
import { recordOutbound, outboundPatientKey } from "@/lib/inbox/record-outbound";
import { toE164 } from "@/lib/messaging/phone";
import { isSuppressed } from "@/lib/messaging/suppression";
import { identifyByPhone } from "@/lib/agent/identify";
import { DentallyClient } from "@/lib/dentally/client";
import { insertCapture, markFollowUpSent, hasOpenCaptureFrom } from "@/lib/after-hours/repository";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabledForSend } from "@/lib/systems/repository";
import { isOutsideHours, getSiteById } from "@/lib/after-hours/hours";
import { decideCallOutcome } from "@/lib/after-hours/call-outcome";
import {
  afterHoursFallbackSms,
  escapeForTwiml,
  inHoursCallbackSms,
  practiceNameFor,
  spokenClosedNoText,
  spokenClosedTextSent,
  spokenOpenNoText,
  spokenOpenTextSent,
} from "@/lib/after-hours/callback-copy";
import { contactLead } from "@/lib/speed-to-lead/contact";
import { insertLead, findOpenLeadByAddress, claimLeadForContact, releaseLeadClaim } from "@/lib/speed-to-lead/repository";
import type { LeadConsent } from "@/lib/speed-to-lead/types";

// Window for the speed-to-lead cross-channel dedup: an open lead created inside
// this window at the same number is treated as the same enquiry, so a missed
// call from someone who also filled the website form is not texted twice.
const LEAD_DEDUP_MS = 12 * 60 * 60 * 1000;

const CAPTURE_DEDUP_MS = 12 * 60 * 60 * 1000; // one capture + follow-up per number per 12h

export const dynamic = "force-dynamic";

// Site to attribute an inbound call to (one practice number serves every site in
// this pilot). Overridable per deployment, matching the inbound SMS webhook.
const DEFAULT_SITE_ID = process.env.AGENT_DEFAULT_SITE_ID ?? "site-cc";

function publicUrl(path: string): string {
  return `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}${path}`;
}

/**
 * Bound a slow promise so it never holds up the TwiML response past Twilio's ~15s
 * voice-webhook timeout. Resolves with `fallback` if `p` has not settled within
 * `ms`; the underlying work keeps running but no longer blocks the call leg.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** TwiML response: speak a line, then hang up. No voicemail recording. */
function twiml(say: string): Response {
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    // The practice name comes from configuration, so an ampersand in it would
    // otherwise emit malformed XML and the caller would hear a Twilio
    // application error instead of a message.
    `<Response><Say>${escapeForTwiml(say)}</Say><Hangup/></Response>`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/xml" } });
}

/**
 * THE one bare-SMS send path for this webhook, used by BOTH the after-hours
 * fallback and the in-hours overflow callback.
 *
 * Deliberately a single function taking the body: a second `sendMessage(...)`
 * call site is exactly how the double-text bug returns. Everything the platform
 * enforces around a send (MESSAGING_DRY_RUN, provider selection, logging) is
 * inherited from `sendMessage`; the opt-out and kill-switch gates are enforced
 * upstream by `decideCallOutcome`, which returns action "none" instead.
 *
 * Bounded so a slow provider cannot push the TwiML past Twilio's voice timeout.
 *
 * IT ALSO PUTS THE TEXT ON THE CALLER'S RECORD, and being the single send path is
 * what makes that reliable: both callers inherit it, so a third branch added later
 * cannot text a caller off the record by forgetting a line. Until this existed, a
 * missed call produced a text the patient received and no screen showed.
 *
 * THE RECORD IS OUTSIDE THE TIMEOUT RACE, in both directions and on purpose:
 *   - the write is never part of the promise the 6s bound is racing, so a slow
 *     database can never downgrade a genuinely sent text to "timeout" and make the
 *     caller hear a line that no longer promises the message;
 *   - and it hangs off the SEND, so a send that resolves after the bound is still
 *     recorded on a best-effort basis rather than being lost by definition.
 * `recordOutbound` never throws and never sends, so neither path can affect what
 * the caller is told or put a second text on the wire.
 */
async function sendCallbackSms(
  to: string,
  body: string,
  patient: { siteId: string; dentallyPatientId: string; patientName: string },
): Promise<"sent" | "failed" | "timeout"> {
  const send = sendMessage({ channel: "sms", to, body })
    .then(() => "sent" as const)
    .catch(() => "failed" as const);
  const recorded = send
    .then((outcome) =>
      outcome === "sent"
        ? recordOutbound({ ...patient, channel: "sms", body, source: "missed-call-callback" })
        : false,
    )
    // recordOutbound already swallows everything; this is belt and braces so a
    // rejected promise can never surface as an unhandled rejection on the timeout
    // path, where nothing awaits it.
    .catch(() => false);
  const outcome = await withTimeout(send, 6000, "timeout" as const);
  // Inside the window, finish the write before returning: the record is then a
  // deterministic consequence of a successful send rather than a race.
  if (outcome === "sent") await recorded;
  return outcome;
}

async function handleWithDentallyPriority(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Malformed / non-form POST (scanner, bad content-type): still answer the
    // call leg with valid TwiML rather than a 500. Nothing is known about the
    // caller here, so the line promises nothing.
    return twiml(spokenOpenNoText(practiceNameFor(DEFAULT_SITE_ID)));
  }
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    // Fail closed in production: never accept unsigned voice webhooks on a public deploy.
    if (process.env.NODE_ENV === "production") {
      return Response.json({ error: "TWILIO_AUTH_TOKEN not configured" }, { status: 403 });
    }
  } else {
    const sig = request.headers.get("x-twilio-signature") ?? "";
    if (!verifyTwilioSignature(publicUrl("/api/webhooks/twilio/voice"), params, sig, token)) {
      return Response.json({ error: "bad signature" }, { status: 403 });
    }
  }

  const from = (params["From"] ?? "").replace(/^whatsapp:/, "");
  const siteId = DEFAULT_SITE_ID;
  const practiceName = practiceNameFor(siteId);
  const now = new Date();
  const outside = isOutsideHours(getSiteById(siteId), now);

  if (!from) {
    // No caller ID field at all (a scanner, not a real call leg): nothing to
    // capture against and nowhere to text, so promise nothing.
    return twiml(outside ? spokenClosedNoText(practiceName) : spokenOpenNoText(practiceName));
  }

  // Withheld / anonymous / non-dialable caller ID ("anonymous", "unknown", a short
  // code, etc.): we can neither identify the caller nor text them back. Do NOT waste a
  // Dentally lookup or claim "we've sent you a text" (there is nowhere to send it).
  // The call is still captured, flagged, for a manual callback.
  const dialable = Boolean(toE164(from));

  // Best-effort patient resolution so the worklist shows a name where we know one.
  let patientId: string | null = null;
  let patientName = dialable ? `Unknown ${from.slice(-4)}` : "Caller ID withheld";
  if (dialable) {
    const dentally = new DentallyClient({
      apiKey: process.env.DENTALLY_API_KEY ?? "",
      baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
      // identifyByPhone READS and nothing more. Arms the write latch (client.ts
      // assertWritable) so an inbound CALL can never become a Dentally write.
      readOnly: true,
    });
    try {
      // Cap the Dentally lookup: it must never push the response past Twilio's voice
      // timeout during a Dentally slowdown (the caller would hear an application error).
      // The name is only a worklist nicety, so a timeout falls back to the masked label.
      const identity = await withTimeout(identifyByPhone(from, { dentally }), 3000, null);
      if (identity) {
        patientId = identity.patientId;
        patientName = identity.patientName;
      }
    } catch {
      // Unrecognised / Dentally unreachable: keep the masked label.
    }
  }

  // Dedup: at most one capture + one follow-up text per number per window, so a
  // repeat dialler / robocaller can't flood the worklist or rack up SMS spend.
  //
  // Dialable numbers ONLY: every withheld caller shares the same literal, so
  // deduping on it would collapse different people into one row and lose a call.
  let alreadyCaptured = false;
  if (dialable) {
    try {
      const sinceIso = new Date(now.getTime() - CAPTURE_DEDUP_MS).toISOString();
      alreadyCaptured = await hasOpenCaptureFrom(siteId, from, sinceIso);
    } catch {
      // If the dedup check fails, fall through and capture once (fail-open on logging).
    }
  }

  // The two gates on OUTBOUND, read only when a send is even possible:
  //  - the owner's After-hours kill switch, and
  //  - the opt-out list, in BOTH forms (an unknown number's STOP is recorded by
  //    address, an identified patient's STOP as patient:<id>).
  // Fail CLOSED: if either read throws we cannot prove the system is on and the
  // number is not suppressed, so nothing goes out. The capture still lands.
  let systemOn = false;
  let suppressed = false;
  if (dialable && !alreadyCaptured) {
    try {
      systemOn = await isSystemEnabledForSend(getSite(siteId)?.clientId ?? "vitality", "after-hours");
      suppressed =
        (await isSuppressed(siteId, "sms", from)) ||
        (patientId ? await isSuppressed(siteId, "sms", `patient:${patientId}`) : false);
    } catch {
      systemOn = false;
    }
  }

  // The whole branch tree, decided in one pure call (see call-outcome.ts for the
  // precedence and the truth table). The route keeps only the I/O and the timeouts.
  const outcome = decideCallOutcome({
    outside,
    dialable,
    alreadyCaptured,
    systemOn,
    suppressed,
    practiceName,
  });

  // Log the call regardless of hours so genuine overflow during the day is still
  // captured for the worklist.
  let captureId: string | null = null;
  if (outcome.capture) {
    try {
      const capture = await insertCapture({
        siteId,
        // Non-empty by here (the no-caller-ID case returned above). A withheld
        // caller's `from` is the carrier's literal ("anonymous", "unknown"),
        // which is what the worklist shows beside the flagged name.
        fromNumber: from,
        dentallyPatientId: patientId,
        patientName,
        channel: "call",
        body: null,
      });
      captureId = capture.id;
    } catch {
      // Persistence failed: still answer the caller so the line never errors out.
    }
  }

  // Where a callback text lands on the record. A caller we recognised threads under
  // their Dentally id; one we could not threads under `lead:<number>`, which is the
  // SAME key the inbound SMS webhook uses for an unknown number — so if they text
  // back, the reply joins this text in one thread instead of forking a second one.
  // A withheld caller ID is not dialable and never reaches a send, so it never
  // reaches this either.
  const callbackRecord = {
    siteId,
    dentallyPatientId: outboundPatientKey(patientId, from),
    patientName,
  };

  // What the caller hears. The decision's own line promises nothing; it is only
  // upgraded to a "we've just sent you a text" line once a send has ACTUALLY
  // happened, so a suppressed number, a failed send or a dry timeout is never
  // told a message is coming.
  let spoken = outcome.spoken;

  if (outcome.action === "lead-bridge") {
    // Route the missed call into Speed-to-lead so it gets the AI-drafted opener,
    // SLA tracking, attempt logging and the SHARED cross-channel dedup — instead of
    // a bare fixed SMS. Every safety property of the old path is preserved: the
    // opt-out and kill-switch checks ran BEFORE this block (decideCallOutcome
    // returns "none" for either), an already-open lead is not texted twice, and if
    // the bridge throws or times out we fall back to the bare SMS so a missed call
    // is never silently dropped.
    try {
      // Bound the WHOLE bridge (dedup check + insert + claim + first contact) so it
      // can never stack on top of the identify time and push the response past
      // Twilio's ~15s voice timeout. The timeout is COOPERATIVE: on expiry the
      // bridge is told to stand down, and it checks that flag immediately before
      // its send — so the timed-out bridge and the bare-SMS fallback can never
      // BOTH text the caller (the old double-message bug).
      // sending  = the bridge began its outbound send (contactLead was entered)
      // settled  = the bridge finished (returned or self-caught), i.e. NOT still
      //            running. A send is only "in flight" when sending && !settled.
      const bridgeState = { timedOut: false, sending: false, settled: false };
      const bridged = await withTimeout(
        (async (): Promise<"contacted" | "deduped" | "aborted"> => {
          // DEDUP: if an open lead for this site + number already exists (e.g. the
          // caller also filled the website form), do NOT create a second lead or
          // first-contact again. The call is still logged for a manual callback.
          const sinceIso = new Date(now.getTime() - LEAD_DEDUP_MS).toISOString();
          const existing = await findOpenLeadByAddress(siteId, from, null, sinceIso);
          if (existing) return "deduped";

          // Consent is implied by dialling us back on a channel we can text; only
          // the SMS channel applies to a missed call.
          const consent: LeadConsent = {
            sms: true,
            email: false,
            whatsapp: false,
            marketing: false,
          };
          const lead = await insertLead({
            siteId,
            dentallyPatientId: patientId,
            name: patientName,
            phone: from,
            email: null,
            channel: "sms",
            source: "missed-call",
            consent,
          });

          // Stand down if the fallback path has already taken over: sending now
          // would double-message the caller. The lead stays 'new' for the sweep.
          if (bridgeState.timedOut) return "aborted";

          // Claim the lead ('new' -> 'contacting') then first-contact, exactly as
          // the intake route does: this closes the double-send race with the SLA
          // sweep. Our claim always wins (we just created the row); a lost claim
          // means a concurrent path already owns the contact, so we skip.
          bridgeState.sending = true;
          if (await claimLeadForContact(lead.id)) {
            try {
              await contactLead(lead);
            } finally {
              // Release a stranded claim ('contacting' -> 'new') so the sweep can
              // retry. contactLead advances to 'contacted'/'lost' on success, so
              // this is a no-op then; it only bites on a throw or silent early-return.
              try { await releaseLeadClaim(lead.id); } catch { /* best effort */ }
            }
          }
          return "contacted";
        })()
          .catch(() => null)
          .finally(() => {
            bridgeState.settled = true;
          }),
        8000,
        null,
      );

      if (bridged === "contacted") {
        spoken = spokenClosedTextSent(practiceName);
        // A brand-new lead was created and first-contacted: record the follow-up.
        if (captureId) await markFollowUpSent(captureId);
      } else if (bridged === "deduped") {
        // An earlier text already went to this number for the same enquiry.
        spoken = spokenClosedTextSent(practiceName);
      } else if (bridged === null && !(bridgeState.sending && !bridgeState.settled)) {
        // Bridge failed and no send is still in flight (it threw, or timed out
        // before reaching its send). Tell it to stand down and fall back to the
        // bare fixed SMS so the missed call is never silently dropped.
        bridgeState.timedOut = true;
        const sendResult = await sendCallbackSms(from, afterHoursFallbackSms(practiceName), callbackRecord);
        if (sendResult === "sent") {
          spoken = spokenClosedTextSent(practiceName);
          if (captureId) await markFollowUpSent(captureId);
        }
      } else if (bridged === null) {
        // A send is genuinely still in flight past the timeout: its text is very
        // likely going out, so promise it and send nothing more (no double-text).
        spoken = spokenClosedTextSent(practiceName);
      }
    } catch {
      // Any failure here (no key, dry-run off, unreachable): the call is still
      // logged. Swallow so Twilio gets a clean TwiML response and does not retry.
    }
  } else if (outcome.action === "callback-sms") {
    // IN HOURS and nobody could pick up. The old behaviour was to say "please
    // hold" and hang up: no text, no lead, no SLA, and a worklist row labelled
    // "out of hours". The caller now gets a callback promise on the SAME send
    // path as the after-hours fallback, so MESSAGING_DRY_RUN, the provider
    // choice and the send log are all inherited rather than forked.
    //
    // A bare templated text, not the speed-to-lead bridge: an open practice is
    // about to ring this person back, so an AI opener asking to book by text
    // would talk across the call the worklist is queuing.
    try {
      const sendResult = await sendCallbackSms(from, inHoursCallbackSms(practiceName), callbackRecord);
      if (sendResult === "sent") {
        spoken = spokenOpenTextSent(practiceName);
        if (captureId) await markFollowUpSent(captureId);
      }
    } catch {
      // Same contract as the after-hours path: the call is logged either way, and
      // Twilio always gets clean TwiML so it does not retry the webhook.
    }
  }

  return twiml(spoken);
}

// Every Dentally read inside this handler is CRITICAL work against the practice's
// shared 3,600/hour budget (src/lib/dentally/budget.ts): a patient mid-booking, or the
// 24/7 agent answering one, outranks every dashboard and every sweep and is served to
// 95% consumption. Pinned by src/lib/dentally/budget-priority-coverage.test.ts.
export async function POST(request: Request): Promise<Response> {
  return runWithDentallyPriority("critical", () => handleWithDentallyPriority(request));
}
