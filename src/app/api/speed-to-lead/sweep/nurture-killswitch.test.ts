import { describe, it, expect, vi, beforeEach } from "vitest";

// The nurture pass is wired into the speed-to-lead sweep, which is gated by the
// speed-to-lead kill switch (fail-closed once messaging is live). With the system
// OFF the whole sweep - nurture included - does nothing. With it ON the nurture pass
// runs and its result is reported.

const cronUnauthorized = vi.fn();
const isSystemEnabledForSend = vi.fn();
const nurtureSweep = vi.fn();
const acquireCronLock = vi.fn();
const releaseCronLock = vi.fn();
const resetStaleContacting = vi.fn();
const listUncontacted = vi.fn();
const convertAbandonedHolds = vi.fn();

vi.mock("@/lib/cron", () => ({ cronUnauthorized: (...a: unknown[]) => cronUnauthorized(...a) }));
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: vi.fn() }));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  listUncontacted: (...a: unknown[]) => listUncontacted(...a),
  claimLeadForContact: vi.fn(),
  releaseLeadClaim: vi.fn(),
  resetStaleContacting: (...a: unknown[]) => resetStaleContacting(...a),
}));
vi.mock("@/lib/speed-to-lead/nurture", () => ({ nurtureSweep: (...a: unknown[]) => nurtureSweep(...a) }));
vi.mock("@/lib/booking/abandoned-holds", () => ({ convertAbandonedHolds: (...a: unknown[]) => convertAbandonedHolds(...a) }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: (...a: unknown[]) => acquireCronLock(...a),
  releaseCronLock: (...a: unknown[]) => releaseCronLock(...a),
}));
vi.mock("@/lib/systems/repository", () => ({ isSystemEnabledForSend: (...a: unknown[]) => isSystemEnabledForSend(...a) }));

import { POST } from "./route";

function req(): Request {
  return new Request("http://localhost/api/speed-to-lead/sweep", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  cronUnauthorized.mockReturnValue(null); // authorized
  acquireCronLock.mockResolvedValue(true);
  releaseCronLock.mockResolvedValue(undefined);
  resetStaleContacting.mockResolvedValue(0);
  listUncontacted.mockResolvedValue([]);
  convertAbandonedHolds.mockResolvedValue({ converted: 0 });
  nurtureSweep.mockResolvedValue({ due: 0, sent: 0, exited: 0, retired: 0, capped: 0, failed: 0, completed: 0 });
});

describe("speed-to-lead sweep nurture wiring", () => {
  it("does NOTHING (including no nurture) when the kill switch is off", async () => {
    isSystemEnabledForSend.mockResolvedValue(false);

    const res = await POST(req());
    const json = await res.json();

    expect(json).toMatchObject({ ok: true, skipped: "system off" });
    expect(nurtureSweep).not.toHaveBeenCalled();
    expect(acquireCronLock).not.toHaveBeenCalled();
  });

  it("runs the nurture pass and reports it when the system is on", async () => {
    isSystemEnabledForSend.mockResolvedValue(true);
    nurtureSweep.mockResolvedValue({ due: 2, sent: 2, exited: 0, retired: 0, capped: 0, failed: 0, completed: 1 });

    const res = await POST(req());
    const json = await res.json();

    expect(nurtureSweep).toHaveBeenCalledTimes(1);
    expect(json.nurture).toMatchObject({ due: 2, sent: 2, completed: 1 });
  });

  it("isolates a nurture failure so the sweep still succeeds", async () => {
    isSystemEnabledForSend.mockResolvedValue(true);
    nurtureSweep.mockRejectedValue(new Error("nurture boom"));

    const res = await POST(req());
    const json = await res.json();

    // The SLA sweep is this route's real job; a nurture blow-up must not fail it.
    expect(json.ok).toBe(true);
    expect(json.nurture).toMatchObject({ error: "nurture boom" });
  });
});
