// G5 (+ the queued-WhatsApp half of G4): a cadence message must not be lost just
// because WhatsApp refused it.
//
//  - A row QUEUED for WhatsApp while WhatsApp is unavailable (owner switch off, or
//    no TWILIO_WHATSAPP_FROM sender) is downgraded to SMS instead of being sent
//    into a dead channel and retired failed.
//  - A WhatsApp send that fails anyway (the classic case: outside WhatsApp's 24
//    hour customer service window a freeform message is refused) falls back to SMS
//    once, to the same handset.
//  - The fallback is opt-out safe: suppression rows are per channel, so an SMS
//    opt-out blocks the fallback even though the WhatsApp send failed.
//
// Drives the REAL drain POST; only the DB / provider seams are faked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  recallRows: [] as Array<{ id: string; touchId: string; siteId: string; channel: string; toRef: string; body: string; status: string }>,
  send: vi.fn(),
  suppressed: new Set<string>(), // `${channel}:${ref}`
  disabledSlugs: new Set<string>(),
}));

function emptyRepo() {
  return {
    listQueuedOutbox: async () => [],
    claimOutbox: async () => true,
    recordOutboxSent: async () => {},
    markOutboxFailed: async () => {},
    markOutboxBlocked: async () => {},
  };
}
function recallRepo() {
  return {
    listQueuedOutbox: async (siteIds: string[]) =>
      hoisted.recallRows
        .filter((r) => r.status === "queued" && siteIds.includes(r.siteId))
        .map(({ id, touchId, siteId, channel, toRef, body }) => ({ id, touchId, siteId, channel, toRef, body })),
    claimOutbox: async (id: string) => {
      const r = hoisted.recallRows.find((x) => x.id === id);
      if (!r || r.status !== "queued") return false;
      r.status = "sending";
      return true;
    },
    recordOutboxSent: async (id: string) => {
      const r = hoisted.recallRows.find((x) => x.id === id);
      if (r) r.status = "sent";
    },
    markOutboxFailed: async (id: string) => {
      const r = hoisted.recallRows.find((x) => x.id === id);
      if (r) r.status = "failed";
    },
    markOutboxBlocked: async (id: string) => {
      const r = hoisted.recallRows.find((x) => x.id === id);
      if (r) r.status = "blocked";
    },
  };
}

vi.mock("@/lib/recall/repository", () => recallRepo());
vi.mock("@/lib/reactivation/repository", () => emptyRepo());
vi.mock("@/lib/noshow/repository", () => emptyRepo());
vi.mock("@/lib/coordinator/repository", () => emptyRepo());
vi.mock("@/lib/reviews/repository", () => emptyRepo());
vi.mock("@/lib/outreach/repository", () => emptyRepo());
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient { constructor(_opts: unknown) {} },
  DentallyError: class DentallyError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));
vi.mock("@/lib/messaging/resolve", () => ({
  resolveRecipient: async (_ref: string, channel: string) => (channel === "email" ? "p@example.test" : "+447700900001"),
}));
vi.mock("@/lib/messaging/suppression", () => ({
  isSuppressed: async (_siteId: string, channel: string, ref: string) => hoisted.suppressed.has(`${channel}:${ref}`),
}));
vi.mock("@/lib/messaging/frequency", () => ({ wasContactedToday: async () => false, recordContacted: async () => {} }));
vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: async () => true, releaseCronLock: async () => {} }));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
}));
vi.mock("@/lib/systems/repository", () => ({
  getDisabledSlugsForSend: async () => new Set(hoisted.disabledSlugs),
  getDisabledSlugs: async () => new Set(hoisted.disabledSlugs),
  // The drain's per-row gate reads the switch through this same module, so the
  // fake answers the single-slug question the same way it answers the set one — a
  // mock looser than live here would make the mid-run stop untestable.
  isSystemEnabledForSend: async (_clientId: string, slug: string) => !hoisted.disabledSlugs.has(slug),
}));
vi.mock("@/lib/messaging/channel-pref", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/messaging/channel-pref")>();
  return { ...actual, getChannelPref: async () => null };
});
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: (...a: unknown[]) => hoisted.send(...a),
}));

import { POST } from "./route";

function req(): Request {
  return new Request("http://localhost/api/messaging/drain", {
    method: "POST",
    headers: { authorization: "Bearer fallback-secret" },
  });
}
function seedRecallWhatsapp() {
  hoisted.recallRows.length = 0;
  hoisted.recallRows.push({
    id: "recall-1", touchId: "recall-t-1", siteId: "site-1", channel: "whatsapp",
    toRef: "patient:1", body: "Time for your check-up", status: "queued",
  });
}

beforeEach(() => {
  hoisted.recallRows.length = 0;
  hoisted.disabledSlugs.clear();
  hoisted.suppressed.clear();
  hoisted.send.mockReset();
  hoisted.send.mockResolvedValue({ provider: "test", providerMessageId: "sid-1", status: "queued" });
  vi.stubEnv("CRON_SECRET", "fallback-secret");
  vi.stubEnv("DENTALLY_API_KEY", "test-key");
  vi.stubEnv("MESSAGING_DRY_RUN", "true");
  vi.stubEnv("PUBLIC_BASE_URL", "");
  vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+441134960000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("drain: a row queued for WhatsApp when WhatsApp is unavailable", () => {
  it("goes out by SMS rather than into a dead channel (no sender configured)", async () => {
    seedRecallWhatsapp();
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "");

    await POST(req());

    expect(hoisted.send).toHaveBeenCalledTimes(1);
    expect(hoisted.send.mock.calls[0][0]).toMatchObject({ channel: "sms", to: "+447700900001" });
    expect(hoisted.recallRows[0].status).toBe("sent");
  });

  it("goes out by SMS when the owner has switched WhatsApp sending off", async () => {
    seedRecallWhatsapp();
    hoisted.disabledSlugs.add("whatsapp");

    await POST(req());

    expect(hoisted.send).toHaveBeenCalledTimes(1);
    expect(hoisted.send.mock.calls[0][0]).toMatchObject({ channel: "sms" });
  });
});

describe("drain: WhatsApp send failure falls back to SMS", () => {
  it("delivers by SMS when the WhatsApp send is refused (24 hour window)", async () => {
    seedRecallWhatsapp();
    hoisted.send
      .mockRejectedValueOnce(
        new Error("twilio 400: 63016 Failed to send freeform message outside the allowed window"),
      )
      .mockResolvedValueOnce({ provider: "twilio", providerMessageId: "sid-sms", status: "queued" });

    await POST(req());

    expect(hoisted.send).toHaveBeenCalledTimes(2);
    expect(hoisted.send.mock.calls[0][0]).toMatchObject({ channel: "whatsapp" });
    expect(hoisted.send.mock.calls[1][0]).toMatchObject({ channel: "sms", to: "+447700900001" });
    expect(hoisted.recallRows[0].status).toBe("sent");
  });

  it("never uses the fallback for a recipient who opted out of SMS", async () => {
    seedRecallWhatsapp();
    hoisted.suppressed.add("sms:+447700900001");
    hoisted.send.mockRejectedValue(new Error("twilio 400: 63016 outside the allowed window"));

    await POST(req());

    expect(hoisted.send).toHaveBeenCalledTimes(1);
    expect(hoisted.send.mock.calls[0][0]).toMatchObject({ channel: "whatsapp" });
    expect(hoisted.recallRows[0].status).toBe("failed");
  });

  it("marks the row failed when the SMS fallback also fails", async () => {
    seedRecallWhatsapp();
    hoisted.send.mockRejectedValue(new Error("twilio 500"));

    await POST(req());

    expect(hoisted.send).toHaveBeenCalledTimes(2);
    expect(hoisted.recallRows[0].status).toBe("failed");
  });

  it("does NOT fall back for a failed SMS send (no double-text)", async () => {
    hoisted.recallRows.length = 0;
    hoisted.recallRows.push({
      id: "recall-2", touchId: "recall-t-2", siteId: "site-1", channel: "sms",
      toRef: "patient:1", body: "Time for your check-up", status: "queued",
    });
    hoisted.send.mockRejectedValue(new Error("twilio 500"));

    await POST(req());

    expect(hoisted.send).toHaveBeenCalledTimes(1);
    expect(hoisted.recallRows[0].status).toBe("failed");
  });
});
