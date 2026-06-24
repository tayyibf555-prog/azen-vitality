import { describe, it, expect } from "vitest";
import { RECALL_CADENCE, advanceAfter } from "./cadence";

const NOW = new Date("2026-06-18T09:00:00Z");

describe("RECALL_CADENCE", () => {
  it("has three ordered steps: sms, email, sms ending in a final touch", () => {
    expect(RECALL_CADENCE.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(RECALL_CADENCE.map((s) => s.channel)).toEqual(["sms", "email", "sms"]);
    expect(RECALL_CADENCE[0].waitDays).toBe(0);
    expect(RECALL_CADENCE[2].purpose).toBe("final");
  });
});

describe("advanceAfter with the recall cadence", () => {
  it("schedules the next step while more remain", () => {
    const a = advanceAfter(1, NOW, RECALL_CADENCE);
    expect(a.status).toBe("active");
    expect(a.nextDueAt).not.toBeNull();
  });
  it("exhausts after the final recall step", () => {
    const a = advanceAfter(3, NOW, RECALL_CADENCE);
    expect(a.status).toBe("exhausted");
    expect(a.nextDueAt).toBeNull();
    expect(a.endedAt).toBe(NOW.toISOString());
  });
});
