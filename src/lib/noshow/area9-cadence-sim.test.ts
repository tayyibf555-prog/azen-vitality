// AREA 9 (no-show defence): appointment-relative confirmation cadence.
//
// The sweep drives the pure engine (enrolment -> advanceAfter) once per due
// tick. Here we simulate a 15-minute cron loop end to end over the pure engine
// to prove the cadence fires the RIGHT NUMBER OF TIMES relative to the
// appointment (T-48h confirm, T-24h reminder, T-3h final, then exhausts) and
// never in the past, for both comfortably-ahead and inside-window bookings.
// Europe/London display correctness (DST) is checked against draft copy.
import { describe, it, expect } from "vitest";
import { NOSHOW_CADENCE, stepDef, enrolment, advanceAfter } from "./cadence";
import { draftSlotOffer, buildNoshowPrompt } from "./draft";

const HOUR = 3_600_000;

/**
 * Replays the sweep's cadence handling over a fixed cron interval. Returns the
 * ISO time each step was actually SENT. Mirrors sweep route logic: on each tick
 * at/after nextDueAt, "send" the current step and advance.
 */
function simulateCadence(appointmentStart: Date, firstNow: Date, tickMs: number): { sentAt: string; step: number }[] {
  const e = enrolment(appointmentStart, firstNow)!;
  let currentStep = e.currentStep;
  let nextDueAt: string | null = e.nextDueAt;
  let status: string | null = "active";
  const fired: { sentAt: string; step: number }[] = [];

  let now = firstNow.getTime();
  const stopAt = appointmentStart.getTime() + HOUR; // stop shortly after the appointment
  let guard = 0;
  while (now <= stopAt && status === "active" && guard < 10_000) {
    guard += 1;
    if (nextDueAt && now >= new Date(nextDueAt).getTime()) {
      const step = stepDef(currentStep + 1, NOSHOW_CADENCE);
      if (!step) break;
      fired.push({ sentAt: new Date(now).toISOString(), step: step.step });
      const adv = advanceAfter(step.step, appointmentStart, new Date(now), NOSHOW_CADENCE);
      currentStep = adv.currentStep;
      nextDueAt = adv.nextDueAt;
      status = adv.status;
    }
    now += tickMs;
  }
  return fired;
}

describe("confirmation cadence fires the right number of times relative to the appointment", () => {
  const FIFTEEN_MIN = 15 * 60_000;

  it("comfortably-ahead booking: fires exactly 3 times (T-48h, T-24h, T-3h) then exhausts", () => {
    const start = new Date("2026-07-10T10:00:00.000Z");
    const firstNow = new Date("2026-07-01T09:00:00.000Z"); // 9 days out
    const fired = simulateCadence(start, firstNow, FIFTEEN_MIN);

    expect(fired.map((f) => f.step)).toEqual([1, 2, 3]); // exactly three, in order

    // Each fired within one tick of its appointment-relative due time.
    const dueFor = (h: number) => start.getTime() - h * HOUR;
    expect(new Date(fired[0].sentAt).getTime()).toBeGreaterThanOrEqual(dueFor(48));
    expect(new Date(fired[0].sentAt).getTime()).toBeLessThan(dueFor(48) + FIFTEEN_MIN);
    expect(new Date(fired[1].sentAt).getTime()).toBeGreaterThanOrEqual(dueFor(24));
    expect(new Date(fired[1].sentAt).getTime()).toBeLessThan(dueFor(24) + FIFTEEN_MIN);
    expect(new Date(fired[2].sentAt).getTime()).toBeGreaterThanOrEqual(dueFor(3));
    expect(new Date(fired[2].sentAt).getTime()).toBeLessThan(dueFor(3) + FIFTEEN_MIN);
  });

  it("booked inside 48h: skips the passed confirm, fires only reminder + final (2 times)", () => {
    const start = new Date("2026-07-02T10:00:00.000Z");
    const firstNow = new Date("2026-07-01T08:00:00.000Z"); // ~26h out: T-48h already gone
    const fired = simulateCadence(start, firstNow, FIFTEEN_MIN);
    expect(fired.map((f) => f.step)).toEqual([2, 3]);
  });

  it("booked inside 3h (imminent): fires exactly once (the final nudge, now)", () => {
    const start = new Date("2026-07-01T10:00:00.000Z");
    const firstNow = new Date("2026-07-01T08:30:00.000Z"); // 90 min out: every window gone
    const fired = simulateCadence(start, firstNow, FIFTEEN_MIN);
    expect(fired.map((f) => f.step)).toEqual([3]);
    // Fired essentially now (enrolment nextDueAt == now), not scheduled in the past.
    expect(new Date(fired[0].sentAt).getTime()).toBeGreaterThanOrEqual(firstNow.getTime());
  });

  it("is deterministic: identical inputs yield identical fire schedules", () => {
    const start = new Date("2026-07-10T10:00:00.000Z");
    const firstNow = new Date("2026-07-01T09:00:00.000Z");
    const a = simulateCadence(start, firstNow, FIFTEEN_MIN);
    const b = simulateCadence(start, firstNow, FIFTEEN_MIN);
    expect(a).toEqual(b);
  });

  it("never schedules a step in the past even on a coarse (hourly) tick", () => {
    const start = new Date("2026-07-10T10:00:00.000Z");
    const firstNow = new Date("2026-07-01T09:00:00.000Z");
    const fired = simulateCadence(start, firstNow, HOUR);
    // Still exactly the three steps; each sent at or after its due time.
    expect(fired.map((f) => f.step)).toEqual([1, 2, 3]);
    for (const f of fired) {
      const due = start.getTime() - stepDef(f.step)!.hoursBefore * HOUR;
      expect(new Date(f.sentAt).getTime()).toBeGreaterThanOrEqual(due);
    }
  });
});

describe("Europe/London display in patient-facing copy (DST correctness)", () => {
  it("renders a summer (BST, UTC+1) slot time in local London time", () => {
    // 2026-07-10T09:30Z is 10:30 BST.
    const copy = draftSlotOffer({ patientName: "Priya Patel", startAt: "2026-07-10T09:30:00.000Z", practitioner: "Dr Khan" });
    expect(copy).toMatch(/10:30/);
    expect(copy).toMatch(/Friday/);
    expect(copy).toMatch(/July/);
  });

  it("renders a winter (GMT, UTC+0) slot time in local London time", () => {
    // 2026-01-09T09:30Z is 09:30 GMT (no offset in winter).
    const copy = draftSlotOffer({ patientName: "Priya Patel", startAt: "2026-01-09T09:30:00.000Z", practitioner: null });
    expect(copy).toMatch(/09:30/);
    expect(copy).toMatch(/Friday/);
    expect(copy).toMatch(/January/);
  });

  it("patient-facing offer copy never leaks funding/category wording", () => {
    const copy = draftSlotOffer({ patientName: "Sam Lee", startAt: "2026-07-10T09:30:00.000Z", practitioner: "Dr Khan" });
    expect(copy).not.toMatch(/\b(NHS|private|funding)\b/i);
    expect(copy).not.toMatch(/[—–]/); // no em/en dash
  });

  it("names the practice in the slot offer so it is not an unbranded SMS", () => {
    const copy = draftSlotOffer({ patientName: "Priya Patel", startAt: "2026-07-10T09:30:00.000Z", practitioner: null, siteId: "site-cc" });
    expect(copy).toContain("N15 Vitality Dental");
  });

  it("names the practice in the confirmation prompt (both the rule and the payload)", () => {
    const target = { siteId: "site-cc", patientName: "Priya Patel", appointmentStartAt: "2026-07-10T09:30:00.000Z", practitioner: null } as never;
    const step = { step: 1, purpose: "confirm" } as never;
    const { system, user } = buildNoshowPrompt(target, "sms", step);
    expect(user).toContain("N15 Vitality Dental");
    expect(system).toMatch(/name the practice/i);
  });
});
