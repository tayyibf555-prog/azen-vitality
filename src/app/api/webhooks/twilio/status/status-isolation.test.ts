import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ONE MODULE'S FAILURE MUST NOT HIDE THE OTHERS.
 *
 * The delivery callback fans a Twilio message id out to every module's outbox
 * because the id lives in exactly one of them and the rest are no-ops. That
 * was seven bare `await`s in a row, so the FIRST rejection ended the handler
 * and every write after it silently never happened.
 *
 * Two ways that bites in production, both real:
 *   - a table that does not exist yet (a migration applied after the deploy
 *     that references it) throws on every callback, forever;
 *   - one transient PostgREST error takes the rest of the fan-out with it.
 *
 * Speed-to-lead sits LAST in that list and is the live-armed module: its
 * undelivered-retry decision is driven by this callback. So the module most
 * likely to be skipped was the one whose loss costs a real patient contact.
 *
 * The property pinned here is isolation, not ordering: every write is
 * attempted whatever the others do.
 */

const calls: string[] = [];
const boom = (name: string) => vi.fn(async () => { calls.push(name); throw new Error(`${name} exploded`); });
const ok = (name: string) => vi.fn(async () => { calls.push(name); });

vi.mock("@/lib/reactivation/repository", () => ({ updateOutboxStatusByMessageId: boom("reactivation") }));
vi.mock("@/lib/recall/repository", () => ({ updateOutboxStatusByMessageId: ok("recall") }));
vi.mock("@/lib/noshow/repository", () => ({ updateOutboxStatusByMessageId: ok("noshow") }));
vi.mock("@/lib/coordinator/repository", () => ({ updateOutboxStatusByMessageId: ok("coordinator") }));
// The closer is the newest table: if its migration lags the deploy, this is
// exactly what the callback sees.
vi.mock("@/lib/closer/repository", () => ({ updateOutboxStatusByMessageId: boom("closer") }));
vi.mock("@/lib/reviews/repository", () => ({ updateOutboxStatusByMessageId: ok("reviews") }));
vi.mock("@/lib/speed-to-lead/repository", () => ({ updateAttemptStatusByMessageId: ok("speed-to-lead") }));

vi.mock("@/lib/twilio/verify", () => ({ verifyTwilioSignature: () => true }));

describe("the Twilio delivery callback isolates each module's write", () => {
  beforeEach(() => { calls.length = 0; });

  it("still records speed-to-lead when two earlier modules throw", async () => {
    const { POST } = await import("./route");
    const body = new URLSearchParams({ MessageSid: "SM-test-1", MessageStatus: "delivered" });
    const res = await POST(
      new Request("https://example.test/api/webhooks/twilio/status", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "stub" },
        body: body.toString(),
      }),
    );

    // Twilio is answered regardless - a 5xx here just buys a replay of the
    // same idempotent writes.
    expect(res.status).toBe(204);

    // THE POINT: the two throwers ran, and so did everything after them.
    expect(calls).toContain("reactivation");
    expect(calls).toContain("closer");
    expect(
      calls,
      "speed-to-lead is last in the fan-out and live-armed; a sequential await chain would have skipped it",
    ).toContain("speed-to-lead");
    expect(calls).toHaveLength(7);
  });
});
