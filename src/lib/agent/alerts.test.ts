import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => ({ provider: "twilio", providerMessageId: "SM1" })),
  consumeBudget: vi.fn(async (..._args: unknown[]) => true),
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: h.sendMessage }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));

import { alertStaffHandover, buildHandoverAlert, staffAlertPhone } from "./alerts";

describe("staff handover alerts", () => {
  beforeEach(() => {
    h.sendMessage.mockClear();
    h.consumeBudget.mockClear();
    h.consumeBudget.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a silent no-op until STAFF_ALERT_PHONE is configured", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "");
    expect(staffAlertPhone()).toBeNull();
    await alertStaffHandover({ patientName: "Amira Khan", reason: "escalated" });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.consumeBudget).not.toHaveBeenCalled();
  });

  it("texts the configured number with the patient name and a plain-English reason", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900123");
    await alertStaffHandover({ patientName: "Amira Khan", reason: "escalated" });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const call = h.sendMessage.mock.calls[0]?.[0] as { channel: string; to: string; body: string };
    expect(call.channel).toBe("sms");
    expect(call.to).toBe("+447700900123");
    expect(call.body).toContain("Amira Khan");
    expect(call.body).toContain("needs a human");
    expect(call.body).not.toContain("—"); // house rule: no em-dash anywhere
  });

  it("drops the ping (but never throws) when the hourly cap is reached", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900123");
    h.consumeBudget.mockResolvedValueOnce(false);
    await alertStaffHandover({ patientName: "Unknown 0123", reason: "guardrail" });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("swallows a send failure so the patient flow is never affected", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900123");
    h.sendMessage.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      alertStaffHandover({ patientName: "Amira Khan", reason: "agent_error" }),
    ).resolves.toBeUndefined();
  });

  it("covers every handover reason with a readable line", () => {
    for (const reason of ["escalated", "guardrail", "agent_error", "no_reply", "throttled"] as const) {
      const body = buildHandoverAlert("Sam", reason);
      expect(body).toContain("Sam");
      expect(body.length).toBeLessThan(320); // stays within two SMS segments
    }
  });
});
