import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendViaTwilio } from "./twilio";

const CFG = {
  accountSid: "ACtest", authToken: "tok",
  smsFrom: "+441234567890", whatsappFrom: "whatsapp:+441234567890",
};

beforeEach(() => { delete process.env.MESSAGING_DRY_RUN; });
afterEach(() => { vi.restoreAllMocks(); });

describe("sendViaTwilio", () => {
  it("posts an SMS with Basic auth and returns the SID", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: async () => ({ sid: "SM123", status: "queued" }),
      text: async () => "",
    });
    const r = await sendViaTwilio(
      { channel: "sms", to: "+447700900010", body: "Hi" },
      { ...CFG, fetchImpl },
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/Accounts/ACtest/Messages.json");
    expect((init.headers as Record<string, string>)["Authorization"]).toMatch(/^Basic /);
    const body = String(init.body);
    expect(body).toContain("To=%2B447700900010");
    expect(body).toContain("From=%2B441234567890");
    expect(r).toEqual({ providerMessageId: "SM123", provider: "twilio", status: "queued" });
  });

  it("prefixes whatsapp: on both from and to", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 201, json: async () => ({ sid: "SMwa", status: "queued" }), text: async () => "",
    });
    await sendViaTwilio({ channel: "whatsapp", to: "+447700900010", body: "Hi" }, { ...CFG, fetchImpl });
    const body = String(fetchImpl.mock.calls[0][1].body);
    expect(body).toContain("To=whatsapp%3A%2B447700900010");
    expect(body).toContain("From=whatsapp%3A%2B441234567890");
  });

  it("throws MessagingError on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}), text: async () => "bad" });
    await expect(
      sendViaTwilio({ channel: "sms", to: "+1", body: "x" }, { ...CFG, fetchImpl }),
    ).rejects.toThrow(/twilio 401/);
  });

  it("is a no-op in dry-run mode", async () => {
    process.env.MESSAGING_DRY_RUN = "true";
    const fetchImpl = vi.fn();
    const r = await sendViaTwilio({ channel: "sms", to: "+1", body: "x" }, { ...CFG, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.provider).toBe("dry-run");
  });

  it("uses API Key auth (SK:secret) when configured, with the account SID in the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 201, json: async () => ({ sid: "SMkey", status: "queued" }), text: async () => "",
    });
    await sendViaTwilio(
      { channel: "sms", to: "+447700900010", body: "Hi" },
      { accountSid: "ACtest", apiKeySid: "SKabc", apiKeySecret: "sekret", smsFrom: "+441234567890", fetchImpl },
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/Accounts/ACtest/Messages.json");
    const expected = `Basic ${Buffer.from("SKabc:sekret").toString("base64")}`;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(expected);
  });

  it("THROWS (never silently dry-runs) when live but config is incomplete (finding #6)", async () => {
    // Not in dry-run mode + missing auth: must fail loudly so the drain marks the row
    // failed, NOT return a synthetic 'sent' that black-holes the message on go-live.
    const fetchImpl = vi.fn();
    await expect(
      sendViaTwilio({ channel: "sms", to: "+1", body: "x" }, { accountSid: "ACtest", smsFrom: "+441234567890", fetchImpl }),
    ).rejects.toThrow(/missing live Twilio config/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still dry-runs when MESSAGING_DRY_RUN is on, whatever the config", async () => {
    process.env.MESSAGING_DRY_RUN = "true";
    const fetchImpl = vi.fn();
    const r = await sendViaTwilio(
      { channel: "sms", to: "+1", body: "x" },
      { accountSid: "ACtest", smsFrom: "+441234567890", fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.provider).toBe("dry-run");
  });
});
