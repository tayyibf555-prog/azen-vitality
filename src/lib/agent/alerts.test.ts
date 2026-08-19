import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  sendMessage: vi.fn<(a: unknown) => Promise<{ provider: string; providerMessageId: string }>>(
    async () => ({ provider: "twilio", providerMessageId: "SM1" }),
  ),
  consumeBudget: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  ensureNeedsHuman: vi.fn<(id: string) => Promise<"set" | "already">>(async () => "set"),
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: h.sendMessage }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("./repository", () => ({ ensureNeedsHuman: h.ensureNeedsHuman }));

import { alertStaffHandover, buildHandoverAlert, staffAlertPhone } from "./alerts";

describe("staff handover alerts", () => {
  beforeEach(() => {
    h.sendMessage.mockClear();
    h.consumeBudget.mockClear();
    h.ensureNeedsHuman.mockClear();
    h.consumeBudget.mockResolvedValue(true);
    h.ensureNeedsHuman.mockResolvedValue("set");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends no text until STAFF_ALERT_PHONE is configured", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "");
    expect(staffAlertPhone()).toBeNull();
    const out = await alertStaffHandover({ patientName: "Amira Khan", reason: "escalated" });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.consumeBudget).not.toHaveBeenCalled();
    expect(out.sms).toBe("no_phone");
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
    const out = await alertStaffHandover({ patientName: "Unknown 0123", reason: "guardrail" });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(out.sms).toBe("capped");
  });

  it("swallows a send failure so the patient flow is never affected", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900123");
    h.sendMessage.mockRejectedValueOnce(new Error("provider down"));
    const out = await alertStaffHandover({ patientName: "Amira Khan", reason: "agent_error" });
    expect(out.sms).toBe("failed");
  });

  it("covers every handover reason with a readable line", () => {
    for (const reason of ["escalated", "guardrail", "agent_error", "no_reply", "throttled"] as const) {
      const body = buildHandoverAlert("Sam", reason);
      expect(body).toContain("Sam");
      expect(body.length).toBeLessThan(320); // stays within two SMS segments
    }
  });
});

/**
 * THE HOLE THIS CLOSES. With STAFF_ALERT_PHONE unset (its state in production) the
 * whole notification used to be a `return`: a patient could ask for a human and
 * nothing anywhere was told. The durable record is what the Task Queue's escalation
 * tasks are computed from, so ensuring it is what "a human always finds out" means.
 *
 * Both branches are pinned, and so is the case where BOTH are available: the record
 * is never traded away for the text.
 */
describe("staff handover: the escalation always reaches a human", () => {
  beforeEach(() => {
    h.sendMessage.mockClear();
    h.consumeBudget.mockClear();
    h.ensureNeedsHuman.mockClear();
    h.consumeBudget.mockResolvedValue(true);
    h.ensureNeedsHuman.mockResolvedValue("set");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("PHONE UNSET: writes the durable record for the conversation, and reports it queued", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "");
    const out = await alertStaffHandover({
      patientName: "Amira Khan",
      reason: "escalated",
      conversationId: "conv-1",
    });
    expect(h.ensureNeedsHuman).toHaveBeenCalledWith("conv-1");
    expect(out).toEqual({ task: "set", sms: "no_phone", queued: true });
  });

  it("PHONE SET: the SMS path is unchanged, and the record is still ensured", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900123");
    const out = await alertStaffHandover({
      patientName: "Amira Khan",
      reason: "escalated",
      conversationId: "conv-1",
    });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.ensureNeedsHuman).toHaveBeenCalledWith("conv-1");
    expect(out).toEqual({ task: "set", sms: "sent", queued: true });
  });

  it("a conversation already handed over is left alone, and still counts as queued", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "");
    h.ensureNeedsHuman.mockResolvedValueOnce("already");
    const out = await alertStaffHandover({
      patientName: "Amira Khan",
      reason: "no_reply",
      conversationId: "conv-1",
    });
    // 'already' is the healthy answer: the caller marked it a moment ago. It must
    // still count, or the belt would report a failure on every single handover.
    expect(out).toEqual({ task: "already", sms: "no_phone", queued: true });
  });

  it("records BEFORE it texts, so a dead provider cannot cost us the record", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900123");
    h.sendMessage.mockRejectedValueOnce(new Error("provider down"));
    const out = await alertStaffHandover({
      patientName: "Amira Khan",
      reason: "agent_error",
      conversationId: "conv-1",
    });
    expect(h.ensureNeedsHuman).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ task: "set", sms: "failed", queued: true });
  });

  it("records even when the hourly cap has already swallowed the text", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900123");
    h.consumeBudget.mockResolvedValueOnce(false);
    const out = await alertStaffHandover({
      patientName: "Amira Khan",
      reason: "throttled",
      conversationId: "conv-1",
    });
    expect(out).toEqual({ task: "set", sms: "capped", queued: true });
  });

  it("a failed record still lets the text go, and reports honestly that nothing is queued", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900123");
    h.ensureNeedsHuman.mockRejectedValueOnce(new Error("db down"));
    const out = await alertStaffHandover({
      patientName: "Amira Khan",
      reason: "escalated",
      conversationId: "conv-1",
    });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ task: "failed", sms: "sent", queued: false });
  });

  it("never throws, whatever fails", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "+447700900123");
    h.ensureNeedsHuman.mockRejectedValueOnce(new Error("db down"));
    h.sendMessage.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      alertStaffHandover({
        patientName: "Amira Khan",
        reason: "escalated",
        conversationId: "conv-1",
      }),
    ).resolves.toEqual({ task: "failed", sms: "failed", queued: false });
  });

  it("with no conversation ref there is nothing to record, and it says so rather than claiming success", async () => {
    vi.stubEnv("STAFF_ALERT_PHONE", "");
    const out = await alertStaffHandover({ patientName: "Amira Khan", reason: "escalated" });
    expect(h.ensureNeedsHuman).not.toHaveBeenCalled();
    expect(out).toEqual({ task: "skipped", sms: "no_phone", queued: false });
  });
});
