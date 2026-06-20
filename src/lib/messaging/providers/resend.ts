import { MessagingError, isDryRun, type OutboundMessage, type SendResult } from "../types";

type FetchImpl = typeof fetch;

export interface ResendConfig {
  apiKey?: string;
  from?: string;
  subject?: string;
  fetchImpl?: FetchImpl;
}

function envConfig(): ResendConfig {
  return {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
    subject: process.env.RESEND_SUBJECT ?? "A note from Vitality Dental",
  };
}

export async function sendViaResend(
  msg: OutboundMessage,
  cfg: ResendConfig = envConfig(),
): Promise<SendResult> {
  if (isDryRun() || !cfg.apiKey || !cfg.from) {
    return { providerMessageId: `dry-email-${Date.now()}`, provider: "dry-run", status: "dry_run" };
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cfg.from,
      to: msg.to,
      subject: msg.subject ?? cfg.subject ?? "A note from Vitality Dental",
      text: msg.body,
    }),
  });
  if (!res.ok) throw new MessagingError("resend", res.status, await res.text());
  const data = (await res.json()) as { id: string };
  return { providerMessageId: data.id, provider: "resend", status: "sent" };
}
