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

/** Global safety switch: when true, providers no-op and return a synthetic id. */
export function isDryRun(): boolean {
  return process.env.MESSAGING_DRY_RUN === "true";
}
