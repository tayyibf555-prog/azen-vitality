// Outreach cadence maths: three SMS touches landing on days 0, 3 and 9.
import { describe, it, expect } from "vitest";
import { OUTREACH_CADENCE, stepDef, nextStep, dueAt, advanceAfter } from "./cadence";

const DAY = 86_400_000;
const T0 = new Date("2026-07-16T09:00:00Z");

describe("OUTREACH_CADENCE shape", () => {
  it("is three SMS-only touches", () => {
    expect(OUTREACH_CADENCE).toHaveLength(3);
    expect(OUTREACH_CADENCE.every((s) => s.channel === "sms")).toBe(true);
  });

  it("has gap days 0, 3, 6 (landing on days 0, 3, 9)", () => {
    expect(OUTREACH_CADENCE.map((s) => s.waitDays)).toEqual([0, 3, 6]);
  });
});

describe("stepDef / nextStep", () => {
  it("resolves each step and stops after the third", () => {
    expect(stepDef(1, OUTREACH_CADENCE)?.purpose).toBe("nudge");
    expect(stepDef(3, OUTREACH_CADENCE)?.purpose).toBe("final");
    expect(stepDef(4, OUTREACH_CADENCE)).toBeNull();
  });

  it("nextStep after the last is null (exhausted)", () => {
    expect(nextStep(3, OUTREACH_CADENCE)).toBeNull();
  });
});

describe("advanceAfter lands the schedule on days 0, 3, 9", () => {
  it("step 1 sent at day 0 schedules step 2 three days later", () => {
    const adv = advanceAfter(1, T0, OUTREACH_CADENCE);
    expect(adv.status).toBe("active");
    expect(adv.nextDueAt).toBe(new Date(T0.getTime() + 3 * DAY).toISOString());
  });

  it("step 2 sent at day 3 schedules step 3 six days later (day 9)", () => {
    const day3 = new Date(T0.getTime() + 3 * DAY);
    const adv = advanceAfter(2, day3, OUTREACH_CADENCE);
    expect(adv.status).toBe("active");
    expect(adv.nextDueAt).toBe(new Date(day3.getTime() + 6 * DAY).toISOString());
    // Which is day 9 from enrolment.
    expect(adv.nextDueAt).toBe(new Date(T0.getTime() + 9 * DAY).toISOString());
  });

  it("step 3 exhausts the cadence", () => {
    const adv = advanceAfter(3, T0, OUTREACH_CADENCE);
    expect(adv.status).toBe("exhausted");
    expect(adv.nextDueAt).toBeNull();
    expect(adv.endedAt).toBe(T0.toISOString());
  });
});

describe("dueAt", () => {
  it("anchors a step's due time to the previous send", () => {
    expect(dueAt(OUTREACH_CADENCE[1], T0)).toBe(new Date(T0.getTime() + 3 * DAY).toISOString());
  });
});
