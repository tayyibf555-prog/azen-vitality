import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { sendMessage } from "@/lib/messaging/send";
import { isSuppressed } from "@/lib/messaging/suppression";
import { identifyByPhone } from "@/lib/agent/identify";
import { DentallyClient } from "@/lib/dentally/client";
import { insertCapture, markFollowUpSent, hasOpenCaptureFrom } from "@/lib/after-hours/repository";
import { isOutsideHours, getSiteById } from "@/lib/after-hours/hours";

const CAPTURE_DEDUP_MS = 12 * 60 * 60 * 1000; // one capture + follow-up per number per 12h

export const dynamic = "force-dynamic";

// Site to attribute an inbound call to (one practice number serves every site in
// this pilot). Overridable per deployment, matching the inbound SMS webhook.
const DEFAULT_SITE_ID = process.env.AGENT_DEFAULT_SITE_ID ?? "site-cc";

function publicUrl(path: string): string {
  return `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}${path}`;
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

  // Best-effort patient resolution so the worklist shows a name where we know one.
  const dentally = new DentallyClient({
    apiKey: process.env.DENTALLY_API_KEY ?? "",
    baseUrl: process.env.DENTALLY_BASE_URL ?? "https://api.dentally.co",
  });
  let patientId: string | null = null;
  let patientName = `Unknown ${from.slice(-4)}`;
  try {
    const identity = await identifyByPhone(from, { dentally });
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

  if (outside) {
    // Send an SMS follow-up so the caller can book by text, then record that we did.
    // Honour the opt-out list first: a number that texted STOP must not be texted,
    // even off the back of a missed call. The call is still logged for a callback.
    try {
      if (await isSuppressed(siteId, "sms", from)) {
        // Suppressed: skip the SMS. The capture row remains for a manual callback.
      } else {
        await sendMessage({
          channel: "sms",
          to: from,
          body:
            "Hi, sorry we missed you at Vitality Dental. We're currently closed but I can help you book by text, just reply here with what you need.",
        });
        if (captureId) await markFollowUpSent(captureId);
      }
    } catch {
      // Delivery failed (no key, dry-run off, unreachable): the call is still
      // logged. Swallow so Twilio gets a clean TwiML response and does not retry.
    }
    return twiml(
      "Thanks for calling Vitality Dental. We're currently closed. We've just sent you a text so we can help you book.",
    );
  }

  return twiml("Thanks for calling Vitality Dental, please hold.");
}
