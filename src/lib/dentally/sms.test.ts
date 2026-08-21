import { describe, it, expect, vi, afterEach } from "vitest";
import { DentallyClient } from "./client";
import { isDentallySmsReadEnabled, readPatientDentallySms } from "./sms";

const ORIGINAL = process.env.DENTALLY_SMS_READ_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DENTALLY_SMS_READ_ENABLED;
  else process.env.DENTALLY_SMS_READ_ENABLED = ORIGINAL;
});

function client(pages: unknown[]) {
  let call = 0;
  const fetchImpl = vi.fn().mockImplementation(async () => {
    const body = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  });
  return { c: new DentallyClient({ apiKey: "k", baseUrl: "https://x", readOnly: true, fetchImpl }), fetchImpl };
}

function row(p: Record<string, unknown> = {}) {
  return {
    id: "1", body: "hello", direction: "outbound", from: "VitalityDental", to: "+447700900001",
    sent_at: "2026-06-16T09:00:00Z", created_at: "2026-06-16T08:59:58Z", message_type: "recall", ...p,
  };
}

describe("isDentallySmsReadEnabled", () => {
  it("is OFF unless explicitly switched on", () => {
    // /v1/sms is undocumented and its shape was calibrated in one session that
    // cannot be re-verified from a development machine. Switching it on is a
    // deliberate act by a human who has just checked it against live.
    delete process.env.DENTALLY_SMS_READ_ENABLED;
    expect(isDentallySmsReadEnabled()).toBe(false);
    process.env.DENTALLY_SMS_READ_ENABLED = "1";
    expect(isDentallySmsReadEnabled()).toBe(false);
    process.env.DENTALLY_SMS_READ_ENABLED = "yes";
    expect(isDentallySmsReadEnabled()).toBe(false);
    process.env.DENTALLY_SMS_READ_ENABLED = "true";
    expect(isDentallySmsReadEnabled()).toBe(true);
  });
});

describe("readPatientDentallySms", () => {
  it("reports 'off' and calls Dentally ZERO times when disabled", async () => {
    delete process.env.DENTALLY_SMS_READ_ENABLED;
    const { c, fetchImpl } = client([{ sms: [row()] }]);
    const read = await readPatientDentallySms("pat-001", { client: c });
    // 'off' is NOT 'ok with no messages': the tab must be able to say "we do not show
    // Dentally's own SMS" rather than "Dentally has none for this patient".
    expect(read.health).toBe("off");
    expect(read.messages).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the calibrated path with patient_id, which live requires", async () => {
    process.env.DENTALLY_SMS_READ_ENABLED = "true";
    const { c, fetchImpl } = client([{ sms: [row()] }]);
    await readPatientDentallySms("pat-001", { client: c });
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/v1/sms");
    expect(url).toContain("patient_id=pat-001");
  });

  it("NEVER sends anything but a GET", async () => {
    // Dentally sends its SMS through Twilio. A POST to this path is far more likely
    // to transmit a real text to a real patient than to file a log entry, so this is
    // the one property of this module that must never regress.
    process.env.DENTALLY_SMS_READ_ENABLED = "true";
    const { c, fetchImpl } = client([{ sms: [row()] }]);
    await readPatientDentallySms("pat-001", { client: c });
    for (const [, init] of fetchImpl.mock.calls) {
      expect((init as { method?: string }).method ?? "GET").toBe("GET");
    }
  });

  it("pages until a short page", async () => {
    process.env.DENTALLY_SMS_READ_ENABLED = "true";
    const full = { sms: Array.from({ length: 100 }, (_, i) => row({ id: String(i) })) };
    const short = { sms: [row({ id: "last" })] };
    const { c, fetchImpl } = client([full, short]);
    const read = await readPatientDentallySms("pat-001", { client: c });
    expect(read.health).toBe("ok");
    expect(read.messages).toHaveLength(101);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns oldest-first, matching the timeline's chat order", async () => {
    process.env.DENTALLY_SMS_READ_ENABLED = "true";
    const { c } = client([
      {
        sms: [
          row({ id: "b", sent_at: "2026-06-20T09:00:00Z" }),
          row({ id: "a", sent_at: "2026-06-16T09:00:00Z" }),
        ],
      },
    ]);
    const read = await readPatientDentallySms("pat-001", { client: c });
    expect(read.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("FAILS SOFT on an unrecognised envelope: 'failed', never an empty history", async () => {
    // A record that 500s because an undocumented endpoint changed shape is worse
    // than one that says part of the history could not be read. But it must not say
    // "no messages" either, which is a claim about the patient.
    process.env.DENTALLY_SMS_READ_ENABLED = "true";
    const { c } = client([{ text_messages: [] }]);
    const read = await readPatientDentallySms("pat-001", { client: c });
    expect(read.health).toBe("failed");
    expect(read.messages).toEqual([]);
  });

  it("FAILS SOFT on an upstream error", async () => {
    process.env.DENTALLY_SMS_READ_ENABLED = "true";
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: "forbidden" }), text: async () => "forbidden",
    });
    const c = new DentallyClient({ apiKey: "k", baseUrl: "https://x", readOnly: true, fetchImpl });
    const read = await readPatientDentallySms("pat-001", { client: c });
    expect(read.health).toBe("failed");
  });

  it("does not call Dentally for an empty patient id", async () => {
    process.env.DENTALLY_SMS_READ_ENABLED = "true";
    const { c, fetchImpl } = client([{ sms: [] }]);
    const read = await readPatientDentallySms("", { client: c });
    expect(read.health).toBe("off");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports 'ok' with no messages when Dentally genuinely has none", async () => {
    process.env.DENTALLY_SMS_READ_ENABLED = "true";
    const { c } = client([{ sms: [], meta: { total: 0 } }]);
    const read = await readPatientDentallySms("pat-001", { client: c });
    expect(read.health).toBe("ok");
    expect(read.messages).toEqual([]);
  });
});
