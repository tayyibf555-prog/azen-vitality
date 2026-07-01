// RESILIENCE: the messaging drain must degrade gracefully under injected
// failures on the 24/7 path.
//
// The drain iterates five module outboxes (reactivation, recall, noshow,
// coordinator, reviews). For each row it resolves a recipient, checks
// suppression + a copy guardrail, sends, then records the outcome. We inject a
// throw at each seam and assert:
//  - one module's list() throwing does not silently swallow the whole run AND
//    still releases the cron lock (never held on error)
//  - a recordSent throw mid-loop does not double-send an already-sent row
//  - a single sendMessage throw fails just that row; later rows still process
//  - a permanently-gone recipient (Dentally 404) is retired without blocking
//    the rest of the queue
//
// vi.mock factories are hoisted, so every mock fn is defined INSIDE its factory
// and re-imported below for assertions.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = { id: string; touchId: string; siteId: string; channel: string; toRef: string; body: string };
function row(id: string): Row {
  return { id, touchId: `t-${id}`, siteId: "site-cc", channel: "sms", toRef: `patient:${id}`, body: "Hello from the practice" };
}

// Each module repo mock exposes the four functions the drain uses, under the
// module's own export names.
vi.mock("@/lib/reactivation/repository", () => ({
  listQueuedOutbox: vi.fn(async (..._a: unknown[]): Promise<Row[]> => []),
  recordOutboxSent: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxFailed: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxBlocked: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));
vi.mock("@/lib/recall/repository", () => ({
  listQueuedOutbox: vi.fn(async (..._a: unknown[]): Promise<Row[]> => []),
  recordOutboxSent: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxFailed: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxBlocked: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));
vi.mock("@/lib/noshow/repository", () => ({
  listQueuedOutbox: vi.fn(async (..._a: unknown[]): Promise<Row[]> => []),
  recordOutboxSent: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxFailed: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxBlocked: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));
vi.mock("@/lib/coordinator/repository", () => ({
  listQueuedOutbox: vi.fn(async (..._a: unknown[]): Promise<Row[]> => []),
  recordOutboxSent: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxFailed: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxBlocked: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));
vi.mock("@/lib/reviews/repository", () => ({
  listQueuedOutbox: vi.fn(async (..._a: unknown[]): Promise<Row[]> => []),
  recordOutboxSent: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxFailed: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  markOutboxBlocked: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));

vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
  releaseCronLock: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
}));

vi.mock("@/lib/messaging/resolve", () => ({
  resolveRecipient: vi.fn(async (..._a: unknown[]): Promise<string | null> => "+447700900000"),
}));

vi.mock("@/lib/messaging/suppression", () => ({
  isSuppressed: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
}));

vi.mock("@/lib/agent/guardrail", () => ({
  checkAgentReply: vi.fn((..._a: unknown[]) => ({ ok: true })),
}));

vi.mock("@/lib/messaging/send", () => ({
  sendMessage: vi.fn(async (..._a: unknown[]) => ({ provider: "twilio", providerMessageId: "SM1" })),
}));

vi.mock("@/lib/dentally/client", () => {
  class DentallyError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    DentallyClient: class {
      constructor(..._a: unknown[]) {}
    },
    DentallyError,
  };
});

vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-cc", clientId: "vitality" }],
}));

import { POST as drainPOST } from "./route";
import * as reactivation from "@/lib/reactivation/repository";
import * as recall from "@/lib/recall/repository";
import * as noshow from "@/lib/noshow/repository";
import * as coordinator from "@/lib/coordinator/repository";
import * as reviews from "@/lib/reviews/repository";
import { acquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { resolveRecipient } from "@/lib/messaging/resolve";
import { isSuppressed } from "@/lib/messaging/suppression";
import { sendMessage } from "@/lib/messaging/send";
import { DentallyError } from "@/lib/dentally/client";

const BASE = "http://localhost:3000/api/messaging/drain";
function req(): Request {
  return new Request(BASE, { method: "POST" });
}

const allRepos = [reactivation, recall, noshow, coordinator, reviews];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", ""); // dev convenience: authorized() allows non-prod
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DENTALLY_API_KEY", "k");
  vi.stubEnv("MESSAGING_DRY_RUN", "1");
  vi.mocked(acquireCronLock).mockResolvedValue(true);
  vi.mocked(releaseCronLock).mockResolvedValue(undefined);
  vi.mocked(resolveRecipient).mockResolvedValue("+447700900000");
  vi.mocked(isSuppressed).mockResolvedValue(false);
  vi.mocked(sendMessage).mockResolvedValue({ provider: "twilio", providerMessageId: "SM1" } as never);
  for (const r of allRepos) {
    vi.mocked(r.listQueuedOutbox).mockResolvedValue([]);
    vi.mocked(r.recordOutboxSent).mockResolvedValue(undefined);
    vi.mocked(r.markOutboxFailed).mockResolvedValue(undefined);
    vi.mocked(r.markOutboxBlocked).mockResolvedValue(undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("drain: a module's list() throwing (DB down)", () => {
  it("does not crash the whole drain, still drains later modules, and releases the lock", async () => {
    // Reactivation (first source) list() throws. Reviews (a later source) has work.
    vi.mocked(reactivation.listQueuedOutbox).mockRejectedValueOnce(new Error("db down"));
    vi.mocked(reviews.listQueuedOutbox).mockResolvedValueOnce([row("r1")] as never);

    const res = await drainPOST(req());
    const json = (await res.json()) as { ok?: boolean; sent?: number; errors?: string[] };

    // The run must complete (200), not surface an unhandled 500.
    expect(res.status).toBe(200);
    // The failed module is surfaced (ok:false + errors[]) rather than silently
    // dropped, so monitoring can see reactivation was skipped this tick.
    expect(json.ok).toBe(false);
    expect(json.errors?.some((e) => e.includes("reactivation"))).toBe(true);
    // The lock is ALWAYS released, even when a module threw.
    expect(releaseCronLock).toHaveBeenCalledWith("drain");
    // The healthy downstream module still processed its row.
    expect(reviews.recordOutboxSent).toHaveBeenCalledTimes(1);
    expect(json.sent).toBe(1);
  });
});

describe("drain: recordSent throwing mid-loop", () => {
  it("does not double-send the already-sent row and still processes the next row", async () => {
    // Distinct recipients per row so we can attribute each send unambiguously.
    vi.mocked(resolveRecipient)
      .mockResolvedValueOnce("+447700900aaa")
      .mockResolvedValueOnce("+447700900bbb");
    vi.mocked(noshow.listQueuedOutbox).mockResolvedValueOnce([row("a"), row("b")] as never);
    // recordSent for row a throws AFTER the send already went out.
    vi.mocked(noshow.recordOutboxSent).mockRejectedValueOnce(new Error("record write failed"));

    const res = await drainPOST(req());
    expect(res.status).toBe(200);

    const sendsToA = vi.mocked(sendMessage).mock.calls.filter(
      (c) => (c[0] as { to?: string })?.to === "+447700900aaa",
    );
    const sendsToB = vi.mocked(sendMessage).mock.calls.filter(
      (c) => (c[0] as { to?: string })?.to === "+447700900bbb",
    );
    // Row a sent exactly once (the record failure must NOT re-send it).
    expect(sendsToA.length).toBe(1);
    // Row a's record failure is caught -> row a marked failed, and row b still
    // processes (the loop does not abort on one row's post-send record error).
    expect(noshow.markOutboxFailed).toHaveBeenCalledWith("a");
    expect(sendsToB.length).toBe(1);
    expect(releaseCronLock).toHaveBeenCalledWith("drain");
  });
});

describe("drain: a single sendMessage throwing", () => {
  it("fails only that row and still processes the later rows", async () => {
    vi.mocked(coordinator.listQueuedOutbox).mockResolvedValueOnce([row("x"), row("y")] as never);
    // First send throws; second must still be attempted.
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("twilio 500"));

    const res = await drainPOST(req());
    const json = (await res.json()) as { sent?: number; failed?: number };
    expect(res.status).toBe(200);

    // Row x failed -> markOutboxFailed; row y sent.
    expect(coordinator.markOutboxFailed).toHaveBeenCalledWith("x");
    expect(coordinator.recordOutboxSent).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(json.failed).toBe(1);
    expect(json.sent).toBe(1);
  });
});

describe("drain: a permanently-gone recipient (Dentally 404) mid-loop", () => {
  it("retires that row as failed and keeps draining later rows (no head-of-line block)", async () => {
    vi.mocked(recall.listQueuedOutbox).mockResolvedValueOnce([row("gone"), row("ok")] as never);
    vi.mocked(resolveRecipient)
      .mockRejectedValueOnce(new DentallyError(404, "patient merged"))
      .mockResolvedValueOnce("+447700900111");

    const res = await drainPOST(req());
    expect(res.status).toBe(200);
    expect(recall.markOutboxFailed).toHaveBeenCalledWith("gone");
    // The second row still sent despite the first being poison.
    expect(recall.recordOutboxSent).toHaveBeenCalledTimes(1);
  });
});
