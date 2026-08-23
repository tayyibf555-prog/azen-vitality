export type MessageChannel = "sms" | "whatsapp" | "email";

export interface OutboundMessage {
  channel: MessageChannel;
  to: string;                 // phone (sms/whatsapp) or email address
  body: string;
  subject?: string;           // email only
  statusCallbackUrl?: string; // sms/whatsapp delivery callback
}

export interface SendResult {
  providerMessageId: string;
  provider: string;           // "twilio" | "resend" | "dry-run"
  status: string;             // provider status, e.g. "queued"
}

export class MessagingError extends Error {
  constructor(public provider: string, public status: number, message: string) {
    super(`${provider} ${status}: ${message}`);
  }
}

/**
 * Global safety switch: when dry, providers no-op and return a synthetic id.
 *
 * FAIL-SAFE BY CONSTRUCTION: live sending requires MESSAGING_DRY_RUN to be the
 * exact string "false". Every other value - "true", absence, "True", "tru",
 * a stray space, an emptied var during an env edit - means DRY RUN. The old
 * rule (dry only when exactly "true") meant a typo in a Vercel env screen
 * would have started texting real patients; the go-live step is now a
 * deliberate, exact word, and nothing else can produce it.
 */
export function isDryRun(): boolean {
  return process.env.MESSAGING_DRY_RUN !== "false";
}
