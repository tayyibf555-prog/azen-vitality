import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { sendMessage } from "@/lib/messaging/send";
import { toE164 } from "@/lib/messaging/phone";
import { isSuppressed } from "@/lib/messaging/suppression";
import { identifyByPhone } from "@/lib/agent/identify";
import { DentallyClient } from "@/lib/dentally/client";
import { insertCapture, markFollowUpSent, hasOpenCaptureFrom } from "@/lib/after-hours/repository";
import { isOutsideHours, getSiteById } from "@/lib/after-hours/hours";
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
    `<Response><Say>${say}</Say><Hangup/></Response>`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/xml" } });
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Malformed / non-form POST (scanner, bad content-type): still answer the
    // call leg with valid TwiML rather than a 500.
    return twiml("Thanks for calling Vitality Dental, please hold.");
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
  if (!from) {
    return twiml("Thanks for calling Vitality Dental, please hold.");
  }

  const siteId = DEFAULT_SITE_ID;
  const now = new Date();
  const outside = isOutsideHours(getSiteById(siteId), now);

  // Withheld / anonymous / non-dialable caller ID ("anonymous", "unknown", a short
  // code, etc.): we can neither identify the caller nor text them back. Do NOT waste a
  // Dentally lookup or claim "we've sent you a text" (there is nowhere to send it).
  // Record a flagged capture for a manual callback and speak a neutral message.
  if (!toE164(from)) {
    try {
      await insertCapture({
        siteId,
        fromNumber: from || "withheld",
        dentallyPatientId: null,
        patientName: "Caller ID withheld",
        channel: "call",
        body: null,
      });
    } catch {
      // still answer the call leg cleanly
    }
    return twiml(
      outside
        ? "Thanks for calling Vitality Dental. We're currently closed. Please call back during our opening hours and we will be happy to help."
        : "Thanks for calling Vitality Dental, please hold.",
    );
  }

  // Best-effort patient resolution so the worklist shows a name where we know one.
  const dentally = new DentallyClient({
    apiKey: process.env.DENTALLY_API_KEY ?? "",
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });
  let patientId: string | null = null;
  let patientName = `Unknown ${from.slice(-4)}`;
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

  // Dedup: at most one capture + one follow-up text per number per window, so a
  // repeat dialler / robocaller can't flood the worklist or rack up SMS spend.
  let alreadyCaptured = false;
  try {
    const sinceIso = new Date(now.getTime() - CAPTURE_DEDUP_MS).toISOString();
    alreadyCaptured = await hasOpenCaptureFrom(siteId, from, sinceIso);
  } catch {
    // If the dedup check fails, fall through and capture once (fail-open on logging).
  }
  if (alreadyCaptured) {
    return twiml(
      outside
        ? "Thanks for calling Vitality Dental. We're currently closed. We've already texted you so we can help you book."
        : "Thanks for calling Vitality Dental, please hold.",
    );
  }

  // Log the call regardless of hours so genuine overflow during the day is still
  // captured for the worklist.
  let captureId: string | null = null;
  try {
    const capture = await insertCapture({
      siteId,
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

  // Whether the caller was ACTUALLY texted (or already had been), so the spoken
  // line never promises a text that was suppressed, failed, or timed out.
  let textPromised = false;

  if (outside) {
    // Route the missed call into Speed-to-lead so it gets the AI-drafted opener,
    // SLA tracking, attempt logging and the SHARED cross-channel dedup — instead of
    // a bare fixed SMS. Every safety property of the old path is preserved: the
    // opt-out check runs BEFORE any outbound, an already-open lead is not texted
    // twice, and if the bridge throws or times out we fall back to the bare SMS so
    // a missed call is never silently dropped.
    //
    // Honour the opt-out list first: a number that texted STOP must not be texted,
    // even off the back of a missed call. The call is still logged for a callback.
    // Check BOTH suppression forms: an unknown number's STOP is recorded by address,
    // but an identified patient's STOP is recorded as patient:<id>.
    try {
      const suppressed =
        (await isSuppressed(siteId, "sms", from)) ||
        (patientId ? await isSuppressed(siteId, "sms", `patient:${patientId}`) : false);
      if (suppressed) {
        // Suppressed: skip all outbound. The capture row remains for a manual callback.
      } else {
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
          textPromised = true;
          // A brand-new lead was created and first-contacted: record the follow-up.
          if (captureId) await markFollowUpSent(captureId);
        } else if (bridged === "deduped") {
          // An earlier text already went to this number for the same enquiry.
          textPromised = true;
        } else if (bridged === null && !(bridgeState.sending && !bridgeState.settled)) {
          // Bridge failed and no send is still in flight (it threw, or timed out
          // before reaching its send). Tell it to stand down and fall back to the
          // bare fixed SMS so the missed call is never silently dropped.
          bridgeState.timedOut = true;
          const sendResult = await withTimeout(
            sendMessage({
              channel: "sms",
              to: from,
              body:
                "Hi, sorry we missed you at Vitality Dental. We're currently closed but I can help you book by text, just reply here with what you need.",
            })
              .then(() => "sent" as const)
              .catch(() => "failed" as const),
            6000,
            "timeout" as const,
          );
          if (sendResult === "sent") {
            textPromised = true;
            if (captureId) await markFollowUpSent(captureId);
          }
        } else if (bridged === null) {
          // A send is genuinely still in flight past the timeout: its text is very
          // likely going out, so promise it and send nothing more (no double-text).
          textPromised = true;
        }
      }
    } catch {
      // Any failure here (no key, dry-run off, unreachable): the call is still
      // logged. Swallow so Twilio gets a clean TwiML response and does not retry.
    }
    // Only promise a text when one was actually sent (or already had been). A
    // suppressed number, a failed send, or a dry timeout must not be told "we've
    // just sent you a text" — nothing is coming.
    return twiml(
      textPromised
        ? "Thanks for calling Vitality Dental. We're currently closed. We've just sent you a text so we can help you book."
        : "Thanks for calling Vitality Dental. We're currently closed. Please call back during our opening hours and we will be happy to help.",
    );
  }

  return twiml("Thanks for calling Vitality Dental, please hold.");
}
