import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { updateOutboxStatusByMessageId as updateReactivationStatus } from "@/lib/reactivation/repository";
import { updateOutboxStatusByMessageId as updateRecallStatus } from "@/lib/recall/repository";
import { updateOutboxStatusByMessageId as updateNoshowStatus } from "@/lib/noshow/repository";
import { updateOutboxStatusByMessageId as updateCoordinatorStatus } from "@/lib/coordinator/repository";
import { updateOutboxStatusByMessageId as updateReviewsStatus } from "@/lib/reviews/repository";
import { updateAttemptStatusByMessageId as updateSpeedToLeadStatus } from "@/lib/speed-to-lead/repository";

export const dynamic = "force-dynamic";

function publicUrl(path: string): string {
  return `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}${path}`;
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Malformed / non-form POST (scanner, bad content-type): reject cleanly
    // rather than throwing an unhandled 500. Matches the voice webhook.
    return Response.json({ error: "malformed payload" }, { status: 400 });
  }
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    // Fail closed in production: never accept unsigned status callbacks on a public deploy.
    if (process.env.NODE_ENV === "production") {
      return Response.json({ error: "TWILIO_AUTH_TOKEN not configured" }, { status: 403 });
    }
  } else {
    const sig = request.headers.get("x-twilio-signature") ?? "";
    if (!verifyTwilioSignature(publicUrl("/api/webhooks/twilio/status"), params, sig, token)) {
      return Response.json({ error: "bad signature" }, { status: 403 });
    }
  }

  const sid = params["MessageSid"];
  const status = params["MessageStatus"]; // queued|accepted|sending|sent|delivered|read|undelivered|failed
  // Explicit status map. WhatsApp's "read" arrives AFTER "delivered" and must map to
  // "delivered", not downgrade the row to "sent". Unknown statuses are ignored (no
  // write) so a future Twilio status can never regress an existing delivered state.
  const STATUS_MAP: Record<string, "sent" | "delivered" | "failed"> = {
    queued: "sent",
    accepted: "sent",
    sending: "sent",
    sent: "sent",
    delivered: "delivered",
    read: "delivered",
    undelivered: "failed",
    failed: "failed",
  };
  const mapped = status ? STATUS_MAP[status] : undefined;
  if (sid && mapped) {
    // The message id lives in exactly one outbox (or the speed-to-lead attempt
    // table); the others are no-ops.
    await updateReactivationStatus(sid, mapped);
    await updateRecallStatus(sid, mapped);
    await updateNoshowStatus(sid, mapped);
    await updateCoordinatorStatus(sid, mapped);
    await updateReviewsStatus(sid, mapped);
    await updateSpeedToLeadStatus(sid, mapped);
  }
  return new Response(null, { status: 204 });
}
