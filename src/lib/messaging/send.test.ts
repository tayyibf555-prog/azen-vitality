import { describe, it, expect, beforeEach } from "vitest";
import { sendMessage } from "./send";

beforeEach(() => { process.env.MESSAGING_DRY_RUN = "true"; });

describe("sendMessage", () => {
  it("routes sms and whatsapp through the dry-run path", async () => {
    const sms = await sendMessage({ channel: "sms", to: "+1", body: "x" });
    const wa = await sendMessage({ channel: "whatsapp", to: "+1", body: "x" });
    expect(sms.providerMessageId).toMatch(/^dry-sms-/);
    expect(wa.providerMessageId).toMatch(/^dry-whatsapp-/);
  });

  it("routes email through the resend dry-run path", async () => {
    const em = await sendMessage({ channel: "email", to: "a@b.test", body: "x" });
    expect(em.providerMessageId).toMatch(/^dry-email-/);
  });
});
