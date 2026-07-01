// FIX 4: MessageSid idempotency helper.
import { describe, it, expect, vi, beforeEach } from "vitest";

const consumeBudget = vi.fn();
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: (...a: unknown[]) => consumeBudget(...a) }));

import { claimInboundMessage } from "./idempotency";

beforeEach(() => consumeBudget.mockReset());

describe("claimInboundMessage", () => {
  it("claims a fresh SID once (true) then a retry is a no-op (false)", async () => {
    // Model the atomic claim: first call true, retry false, keyed on the SID.
    consumeBudget.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await claimInboundMessage("SM123")).toBe(true);
    expect(await claimInboundMessage("SM123")).toBe(false);
    // Same key, limit 1, both calls.
    expect(consumeBudget).toHaveBeenCalledTimes(2);
    expect(consumeBudget.mock.calls[0][0]).toBe("twilio-inbound-msgsid:SM123");
    expect(consumeBudget.mock.calls[0][1]).toBe(1);
  });

  it("a blank SID is always treated as first-seen (never dedups it away)", async () => {
    expect(await claimInboundMessage("")).toBe(true);
    expect(consumeBudget).not.toHaveBeenCalled();
  });
});
