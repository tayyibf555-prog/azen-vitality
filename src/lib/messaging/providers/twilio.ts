import { MessagingError, isDryRun, type OutboundMessage, type SendResult } from "../types";

type FetchImpl = typeof fetch;

export interface TwilioConfig {
  accountSid?: string;
  authToken?: string;
  smsFrom?: string;
  whatsappFrom?: string;
  fetchImpl?: FetchImpl;
}

function envConfig(): TwilioConfig {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    smsFrom: process.env.TWILIO_SMS_FROM,
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM,
  };
}

export async function sendViaTwilio(
  msg: OutboundMessage,
  cfg: TwilioConfig = envConfig(),
): Promise<SendResult> {
  const from = msg.channel === "whatsapp" ? cfg.whatsappFrom : cfg.smsFrom;
  if (isDryRun() || !cfg.accountSid || !cfg.authToken || !from) {
    return { providerMessageId: `dry-${msg.channel}-${Date.now()}`, provider: "dry-run", status: "dry_run" };
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const to = msg.channel === "whatsapp" ? `whatsapp:${msg.to}` : msg.to;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`;
  const params = new URLSearchParams({ From: from, To: to, Body: msg.body });
  if (msg.statusCallbackUrl) params.set("StatusCallback", msg.statusCallbackUrl);
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!res.ok) throw new MessagingError("twilio", res.status, await res.text());
  const data = (await res.json()) as { sid: string; status: string };
  return { providerMessageId: data.sid, provider: "twilio", status: data.status };
}
