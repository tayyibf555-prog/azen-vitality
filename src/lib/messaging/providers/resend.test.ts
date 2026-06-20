import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendViaResend } from "./resend";

const CFG = { apiKey: "re_test", from: "Vitality <hi@vitality.test>", subject: "Hello" };

beforeEach(() => { delete process.env.MESSAGING_DRY_RUN; });
afterEach(() => { vi.restoreAllMocks(); });

describe("sendViaResend", () => {
  it("posts an email with Bearer auth and returns the id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "em123" }), text: async () => "" });
    const r = await sendViaResend(
      { channel: "email", to: "a@b.test", body: "Hi there", subject: "Your treatment" },
      { ...CFG, fetchImpl },
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("api.resend.com/emails");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer re_test");
    const payload = JSON.parse(String(init.body));
    expect(payload.to).toBe("a@b.test");
    expect(payload.from).toBe(CFG.from);
    expect(payload.subject).toBe("Your treatment");
    expect(payload.text).toBe("Hi there");
    expect(r).toEqual({ providerMessageId: "em123", provider: "resend", status: "sent" });
  });

  it("falls back to the configured subject when none is supplied", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "em2" }), text: async () => "" });
    await sendViaResend({ channel: "email", to: "a@b.test", body: "Hi" }, { ...CFG, fetchImpl });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body)).subject).toBe("Hello");
  });

  it("throws MessagingError on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}), text: async () => "bad" });
    await expect(sendViaResend({ channel: "email", to: "a@b.test", body: "x" }, { ...CFG, fetchImpl })).rejects.toThrow(/resend 422/);
  });

  it("is a no-op in dry-run mode", async () => {
    process.env.MESSAGING_DRY_RUN = "true";
    const fetchImpl = vi.fn();
    const r = await sendViaResend({ channel: "email", to: "a@b.test", body: "x" }, { ...CFG, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.provider).toBe("dry-run");
  });
});
