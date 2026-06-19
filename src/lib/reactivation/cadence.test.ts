import { describe, it, expect } from "vitest";
import {
  DEFAULT_CADENCE,
  stepDef,
  nextStep,
  dueAt,
  advanceAfter,
} from "./cadence";

const NOW = new Date("2026-06-18T09:00:00Z");

describe("cadence definition", () => {
  it("has three ordered steps ending in a final touch", () => {
    expect(DEFAULT_CADENCE.map((s) => s.step)).toEqual([1, 2, 3]);
    expect(DEFAULT_CADENCE[0].waitDays).toBe(0);
    expect(DEFAULT_CADENCE[2].purpose).toBe("final");
  });
});

describe("nextStep", () => {
  it("returns step 1 when nothing sent yet", () => {
    expect(nextStep(0)?.step).toBe(1);
  });
  it("returns null after the last step (exhausted)", () => {
    expect(nextStep(3)).toBeNull();
  });
});

describe("dueAt", () => {
  it("adds the step waitDays to the anchor time", () => {
    const step2 = stepDef(2)!;
    const due = dueAt(step2, NOW);
    const expected = new Date(NOW.getTime() + step2.waitDays * 86_400_000).toISOString();
    expect(due).toBe(expected);
  });
});

describe("advanceAfter", () => {
  it("schedules the next step while more remain", () => {
    const a = advanceAfter(1, NOW);
    expect(a.status).toBe("active");
    expect(a.currentStep).toBe(1);
    expect(a.nextDueAt).not.toBeNull();
    expect(a.endedAt).toBeNull();
  });
  it("exhausts after the final step", () => {
    const a = advanceAfter(3, NOW);
    expect(a.status).toBe("exhausted");
    expect(a.nextDueAt).toBeNull();
    expect(a.endedAt).toBe(NOW.toISOString());
  });
});
