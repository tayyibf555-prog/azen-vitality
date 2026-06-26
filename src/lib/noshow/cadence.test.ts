import { describe, it, expect } from "vitest";
import {
  NOSHOW_CADENCE,
  stepDef,
  nextStep,
  dueAtForStep,
  enrolment,
  advanceAfter,
} from "./cadence";

const HOUR = 3_600_000;

describe("NOSHOW_CADENCE", () => {
  it("is a 48h confirm -> 24h reminder -> 3h final SMS sequence", () => {
    expect(NOSHOW_CADENCE.map((s) => s.hoursBefore)).toEqual([48, 24, 3]);
    expect(NOSHOW_CADENCE.map((s) => s.purpose)).toEqual(["confirm", "reminder", "final"]);
    expect(NOSHOW_CADENCE.every((s) => s.channel === "sms")).toBe(true);
  });
});

describe("dueAtForStep", () => {
  it("is the appointment start minus the step's lead hours", () => {
    const start = new Date("2026-07-01T10:00:00.000Z");
    expect(dueAtForStep(stepDef(1)!, start)).toBe(new Date(start.getTime() - 48 * HOUR).toISOString());
    expect(dueAtForStep(stepDef(3)!, start)).toBe(new Date(start.getTime() - 3 * HOUR).toISOString());
  });
});

describe("enrolment", () => {
  it("starts at step 1 for an appointment comfortably ahead", () => {
    const start = new Date("2026-07-10T10:00:00.000Z");
    const now = new Date("2026-07-01T09:00:00.000Z");
    const e = enrolment(start, now)!;
    expect(e.currentStep).toBe(0); // next step to send is 1
    expect(e.nextDueAt).toBe(new Date(start.getTime() - 48 * HOUR).toISOString());
  });

  it("skips windows that have already passed (booked inside 48h)", () => {
    const start = new Date("2026-07-02T10:00:00.000Z");
    const now = new Date("2026-07-01T08:00:00.000Z"); // ~26h before -> step1 (48h) passed
    const e = enrolment(start, now)!;
    expect(e.currentStep).toBe(1); // next step to send is 2 (the 24h reminder)
    expect(e.nextDueAt).toBe(new Date(start.getTime() - 24 * HOUR).toISOString());
  });

  it("sends only the final step when the appointment is imminent", () => {
    const start = new Date("2026-07-01T10:00:00.000Z");
    const now = new Date("2026-07-01T09:30:00.000Z"); // 30 min before -> all windows passed
    const e = enrolment(start, now)!;
    expect(e.currentStep).toBe(2); // next step to send is 3 (final)
    expect(e.nextDueAt).toBe(now.toISOString());
  });
});

describe("advanceAfter", () => {
  const start = new Date("2026-07-10T10:00:00.000Z");

  it("schedules the next step at its appointment-relative time", () => {
    const now = new Date(start.getTime() - 48 * HOUR); // just sent step 1
    const adv = advanceAfter(1, start, now);
    expect(adv.status).toBe("active");
    expect(adv.currentStep).toBe(1);
    expect(adv.nextDueAt).toBe(new Date(start.getTime() - 24 * HOUR).toISOString());
  });

  it("never schedules the next step in the past", () => {
    const now = new Date(start.getTime() - 1 * HOUR); // late: T-24h already passed
    const adv = advanceAfter(1, start, now);
    expect(adv.nextDueAt).toBe(now.toISOString());
  });

  it("exhausts after the final step", () => {
    const now = new Date(start.getTime() - 3 * HOUR);
    const adv = advanceAfter(3, start, now);
    expect(adv.status).toBe("exhausted");
    expect(adv.nextDueAt).toBeNull();
    expect(adv.endedAt).toBe(now.toISOString());
  });

  it("nextStep returns null past the end", () => {
    expect(nextStep(3)).toBeNull();
    expect(nextStep(0)?.step).toBe(1);
  });
});
