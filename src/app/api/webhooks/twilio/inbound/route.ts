import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { isStopKeyword, addSuppression } from "@/lib/messaging/suppression";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  findTargetByAddress,
  insertInboundTouch,
  getCadenceByTarget,
  updateCadence,
} from "@/lib/reactivation/repository";

export const dynamic = "force-dynamic";

function publicUrl(path: string): string {
  return `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}${path}`;
}

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  const token = process.env.TWILIO_AUTH_TOKEN;
  if (token) {
    const sig = request.headers.get("x-twilio-signature") ?? "";
    if (!verifyTwilioSignature(publicUrl("/api/webhooks/twilio/inbound"), params, sig, token)) {
      return Response.json({ error: "bad signature" }, { status: 403 });
    }
  }

  const rawFrom = params["From"] ?? "";
  const isWhatsapp = rawFrom.startsWith("whatsapp:");
  const channel: MessageChannel = isWhatsapp ? "whatsapp" : "sms";
  const from = rawFrom.replace(/^whatsapp:/, "");
  const body = params["Body"] ?? "";

  const match = await findTargetByAddress(from);
  if (match) {
    const cadence = await getCadenceByTarget(match.targetId);
    await insertInboundTouch({
      targetId: match.targetId,
      cadenceId: cadence?.id ?? null,
      siteId: match.siteId,
      channel,
      body,
    });
    if (cadence && cadence.status === "active") {
      await updateCadence(cadence.id, { status: "paused" });
    }
    if (isStopKeyword(body)) {
      await addSuppression(match.siteId, channel, `patient:${match.targetId.split(":")[1]}`, "stop");
    }
  }

  // Empty TwiML so Twilio does not send an auto-reply.
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
