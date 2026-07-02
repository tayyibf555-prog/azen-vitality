import { describe, it, expect, vi, beforeEach } from "vitest";

// AREA 2 (consent + suppression gates): the shared outbox drain.
// Every per-module outbox (recall, reactivation, noshow, coordinator, reviews)
// funnels through this drain. Consent is checked at QUEUE time by each module;
// the drain is the last line of defence for opt-outs. Proves: a queued message
// (i.e. one that passed consent) is still BLOCKED at send time when either the
// patient ref or the resolved address is suppressed, and the row is marked
// blocked rather than sent.

const sendMessage = vi.fn();
const isSuppressed = vi.fn();
const resolveRecipient = vi.fn();

const recallList = vi.fn();
const recallClaim = vi.fn();
const recallSent = vi.fn();
const recallFailed = vi.fn();
const recallBlocked = vi.fn();

// vi.mock factories are hoisted, so build the empty-outbox shape inline.
function emptyOutbox() {
  return {
    listQueuedOutbox: vi.fn(async () => []),
    claimOutbox: vi.fn(async () => true),
    recordOutboxSent: vi.fn(),
    markOutboxFailed: vi.fn(),
    markOutboxBlocked: vi.fn(),
  };
}

vi.mock("@/lib/dentally/client", () => ({ DentallyClient: class {} }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock("@/lib/messaging/resolve", () => ({ resolveRecipient: (...a: unknown[]) => resolveRecipient(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: (...a: unknown[]) => isSuppressed(...a) }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => undefined),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-cc", clientId: "vitality", name: "Site" }],
}));
vi.mock("@/lib/recall/repository", () => ({
  listQueuedOutbox: (...a: unknown[]) => recallList(...a),
  claimOutbox: (...a: unknown[]) => recallClaim(...a),
  recordOutboxSent: (...a: unknown[]) => recallSent(...a),
  markOutboxFailed: (...a: unknown[]) => recallFailed(...a),
  markOutboxBlocked: (...a: unknown[]) => recallBlocked(...a),
}));
vi.mock("@/lib/reactivation/repository", () => emptyOutbox());
vi.mock("@/lib/noshow/repository", () => emptyOutbox());
vi.mock("@/lib/coordinator/repository", () => emptyOutbox());
vi.mock("@/lib/reviews/repository", () => emptyOutbox());

import { POST } from "@/app/api/messaging/drain/route";

const ROW = {
  id: "ob-1",
  touchId: "t-1",
  siteId: "site-cc",
  channel: "sms",
  toRef: "patient:p-1",
  body: "Your check-up is due.",
};

function drainRequest(): Request {
  return new Request("http://localhost/api/messaging/drain", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DENTALLY_API_KEY", "test-key");
  vi.stubEnv("CRON_SECRET", "");
  recallList.mockResolvedValue([ROW]);
  recallClaim.mockResolvedValue(true);
  resolveRecipient.mockResolvedValue("+447700900123");
  isSuppressed.mockResolvedValue(false);
  sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
});

describe("drain suppression gate (suppression wins over queue-time consent)", () => {
  it("blocks a queued row suppressed by patient ref: marked blocked, never sent", async () => {
    isSuppressed.mockImplementation(async (_s: string, _c: string, ref: string) => ref === "patient:p-1");
    const res = await POST(drainRequest());
    const json = await res.json();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recallBlocked).toHaveBeenCalledWith("ob-1");
    expect(recallSent).not.toHaveBeenCalled();
    expect(json.blocked).toBe(1);
    expect(json.sent).toBe(0);
  });

  it("blocks a queued row suppressed only by the resolved ADDRESS (STOP from an unidentified number)", async () => {
    isSuppressed.mockImplementation(async (_s: string, _c: string, ref: string) => ref === "+447700900123");
    const res = await POST(drainRequest());
    const json = await res.json();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(recallBlocked).toHaveBeenCalledWith("ob-1");
    expect(json.blocked).toBe(1);
  });

  it("sends an unsuppressed queued row (control) and records it", async () => {
    const res = await POST(drainRequest());
    const json = await res.json();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(recallSent).toHaveBeenCalledWith("ob-1", "t-1", expect.objectContaining({ toAddress: "+447700900123" }));
    expect(recallBlocked).not.toHaveBeenCalled();
    expect(json.sent).toBe(1);
  });
});
