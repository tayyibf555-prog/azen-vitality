import type { OutboundMessage, SendResult } from "./types";
import { sendViaTwilio } from "./providers/twilio";
import { sendViaResend } from "./providers/resend";

export async function sendMessage(msg: OutboundMessage): Promise<SendResult> {
  switch (msg.channel) {
    case "sms":
    case "whatsapp":
      return sendViaTwilio(msg);
    case "email":
      return sendViaResend(msg);
  }
}
