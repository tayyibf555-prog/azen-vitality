import { verifyTwilioSignature } from "@/lib/messaging/signature";
import { updateOutboxStatusByMessageId } from "@/lib/reactivation/repository";

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
    if (!verifyTwilioSignature(publicUrl("/api/webhooks/twilio/status"), params, sig, token)) {
      return Response.json({ error: "bad signature" }, { status: 403 });
    }
  }

  const sid = params["MessageSid"];
  const status = params["MessageStatus"]; // queued|sent|delivered|undelivered|failed
  if (sid && status) {
    const mapped = status === "delivered" ? "delivered" : status === "undelivered" || status === "failed" ? "failed" : "sent";
    await updateOutboxStatusByMessageId(sid, mapped);
  }
  return new Response(null, { status: 204 });
}
