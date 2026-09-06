// FIX 1 (WhatsApp channel-preference routing): the drain may re-route a queued SMS
// to WhatsApp for a patient who prefers it ONLY when WhatsApp is DOUBLE-GATED open:
// the owner kill switch is ON *and* a WhatsApp sender (TWILIO_WHATSAPP_FROM) is
// actually configured. If either gate is closed, a 'whatsapp' preference must be a
// no-op and the message must still go out on SMS, never routed to a dead channel.
//
// Drives the REAL drain POST with the REAL resolvePreferredChannel; only the DB/IO
// seams are faked. sendMessage is captured so we can assert the channel each row
// actually went out on.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  recallRows: [] as Array<{ id: string; touchId: string; siteId: string; channel: string; toRef: string; body: string; status: string }>,
  send: vi.fn(),
  getChannelPref: vi.fn(),
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
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: async () => false }));
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
// Real resolvePreferredChannel (the routing logic under test); only getChannelPref
// (the DB read) is faked so we can drive a 'whatsapp' preference without Supabase.
vi.mock("@/lib/messaging/channel-pref", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/messaging/channel-pref")>();
  return { ...actual, getChannelPref: (...a: unknown[]) => hoisted.getChannelPref(...a) };
});
// Capture the channel each send actually used; never touches the network.
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: (...a: unknown[]) => hoisted.send(...a),
}));

import { POST } from "./route";

function req(): Request {
  return new Request("http://localhost/api/messaging/drain", {
    method: "POST",
    headers: { authorization: "Bearer fix1-secret" },
  });
}
function seedRecallSms() {
  hoisted.recallRows.length = 0;
  hoisted.recallRows.push({
    id: "recall-1", touchId: "recall-t-1", siteId: "site-1", channel: "sms",
    toRef: "patient:1", body: "Time for your check-up", status: "queued",
  });
}

beforeEach(() => {
  hoisted.recallRows.length = 0;
  hoisted.disabledSlugs.clear();
  hoisted.send.mockReset();
  hoisted.send.mockResolvedValue({ provider: "test", providerMessageId: "sid-1", status: "queued" });
  hoisted.getChannelPref.mockReset();
  hoisted.getChannelPref.mockResolvedValue("whatsapp"); // this patient prefers WhatsApp
  vi.stubEnv("CRON_SECRET", "fix1-secret");
  vi.stubEnv("DENTALLY_API_KEY", "test-key");
  vi.stubEnv("MESSAGING_DRY_RUN", "true");
  vi.stubEnv("PUBLIC_BASE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("drain WhatsApp channel-preference double-gate", () => {
  it("toggle OFF (whatsapp disabled), sender configured: a 'whatsapp' preference still goes via SMS", async () => {
    seedRecallSms();
    hoisted.disabledSlugs.add("whatsapp"); // owner kill switch OFF for whatsapp
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+441134960000"); // sender IS configured

    await POST(req());

    expect(hoisted.send).toHaveBeenCalledTimes(1);
    expect(hoisted.send.mock.calls[0][0]).toMatchObject({ channel: "sms", to: "+447700900001" });
    // The preference read is skipped entirely when the gate is closed.
    expect(hoisted.getChannelPref).not.toHaveBeenCalled();
  });

  it("toggle ON, NO sender configured: a 'whatsapp' preference still goes via SMS (no dead-channel route)", async () => {
    seedRecallSms();
    // disabledSlugs empty => whatsapp toggle is ON (the silently-live default the fix guards)
    vi.stubEnv("TWILIO_WHATSAPP_FROM", ""); // sender NOT configured

    await POST(req());

    expect(hoisted.send).toHaveBeenCalledTimes(1);
    expect(hoisted.send.mock.calls[0][0]).toMatchObject({ channel: "sms" });
    expect(hoisted.getChannelPref).not.toHaveBeenCalled();
  });

  it("toggle ON AND sender configured: a 'whatsapp' preference IS honoured (routes to WhatsApp)", async () => {
    seedRecallSms();
    // disabledSlugs empty => toggle ON; sender configured => deliverable.
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+441134960000");

    await POST(req());

    expect(hoisted.send).toHaveBeenCalledTimes(1);
    expect(hoisted.send.mock.calls[0][0]).toMatchObject({ channel: "whatsapp" });
    expect(hoisted.getChannelPref).toHaveBeenCalledTimes(1);
  });

  it("an SMS-preferring patient is unaffected and always goes via SMS", async () => {
    seedRecallSms();
    hoisted.getChannelPref.mockResolvedValue("sms");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+441134960000");

    await POST(req());

    expect(hoisted.send.mock.calls[0][0]).toMatchObject({ channel: "sms" });
  });
});
