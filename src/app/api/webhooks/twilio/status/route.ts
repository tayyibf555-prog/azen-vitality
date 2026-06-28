import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { updateOutboxStatusByMessageId as updateReactivationStatus } from "@/lib/reactivation/repository";
import { updateOutboxStatusByMessageId as updateRecallStatus } from "@/lib/recall/repository";
import { updateOutboxStatusByMessageId as updateNoshowStatus } from "@/lib/noshow/repository";
import { updateOutboxStatusByMessageId as updateCoordinatorStatus } from "@/lib/coordinator/repository";
import { updateAttemptStatusByMessageId as updateSpeedToLeadStatus } from "@/lib/speed-to-lead/repository";

export const dynamic = "force-dynamic";

function publicUrl(path: string): string {
  return `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}${path}`;
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
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
  const status = params["MessageStatus"]; // queued|sent|delivered|undelivered|failed
  if (sid && status) {
    const mapped = status === "delivered" ? "delivered" : status === "undelivered" || status === "failed" ? "failed" : "sent";
    // The message id lives in exactly one outbox (or the speed-to-lead attempt
    // table); the others are no-ops.
    await updateReactivationStatus(sid, mapped);
    await updateRecallStatus(sid, mapped);
    await updateNoshowStatus(sid, mapped);
    await updateCoordinatorStatus(sid, mapped);
    await updateSpeedToLeadStatus(sid, mapped);
  }
  return new Response(null, { status: 204 });
}
