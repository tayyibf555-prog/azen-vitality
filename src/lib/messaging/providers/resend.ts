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
  // Dry-run returns a synthetic result on purpose. Live-but-misconfigured must FAIL
  // LOUDLY, not silently return a fake "sent" that the drain records as delivered.
  if (isDryRun()) {
    return { providerMessageId: `dry-email-${Date.now()}`, provider: "dry-run", status: "dry_run" };
  }
  if (!cfg.apiKey || !cfg.from) {
    const missing = [!cfg.apiKey && "RESEND_API_KEY", !cfg.from && "RESEND_FROM"].filter(Boolean).join(", ");
    throw new MessagingError("resend", 0, `missing live Resend config: ${missing}`);
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: cfg.from,
        to: msg.to,
        subject: msg.subject ?? cfg.subject ?? "A note from Vitality Dental",
        text: msg.body,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new MessagingError("resend", 0, "Resend request timed out after 15000ms");
    }
    throw e;
  }
  if (!res.ok) throw new MessagingError("resend", res.status, await res.text());
  const data = (await res.json()) as { id: string };
  return { providerMessageId: data.id, provider: "resend", status: "sent" };
}
