// AREA 9 (no-show defence): risk-scoring determinism + banding boundaries.
//
// riskScore must be a pure, deterministic function of its inputs (no clock, no
// randomness) so the same patient always lands in the same band, and the band
// thresholds (>=60 high, >=30 medium) must line up exactly with what
// toNoshowTarget stamps on the target.
import { describe, it, expect } from "vitest";
import { riskScore, bandFor, toNoshowTarget, type NoshowInput } from "./normalise";

const NOW = new Date("2026-06-26T09:00:00.000Z");

function input(overrides: Partial<NoshowInput> = {}): NoshowInput {
  return {
    siteId: "site-cc",
    dentallyPatientId: "pat-1",
    patientName: "Sam Lee",
    appointment: { id: "appt-1", start: "2026-06-29T10:00:00.000Z", state: "booked", durationMin: 30, practitioner: "Dr Khan" },
    priorAppointments: 4,
    priorNoShows: 0,
    isNewPatient: false,
    bookedDaysAhead: 10,
    consent: { sms: true, email: true, marketing: false },
    now: NOW,
    ...overrides,
  };
}

describe("riskScore determinism", () => {
  it("is a pure function: repeated calls with identical inputs are identical", () => {
    const i = input({ priorAppointments: 5, priorNoShows: 2, isNewPatient: false, bookedDaysAhead: 1 });
    const runs = Array.from({ length: 50 }, () => riskScore(i));
    expect(new Set(runs).size).toBe(1);
  });

  it("does not read the wall clock: same inputs at a different `now` give the same score", () => {
    const base = { priorAppointments: 6, priorNoShows: 3, isNewPatient: false, bookedDaysAhead: 40 };
    const a = riskScore(input({ ...base, now: new Date("2020-01-01T00:00:00Z") }));
    const b = riskScore(input({ ...base, now: new Date("2030-12-31T23:59:59Z") }));
    expect(a).toBe(b);
  });

  it("is monotonic in no-show history (more no-shows never lowers the score)", () => {
    let prev = -1;
    for (let ns = 0; ns <= 10; ns++) {
      const s = riskScore(input({ priorAppointments: 10, priorNoShows: ns }));
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it("computes each additive component exactly and clamps at 100", () => {
    // history .5*60=30 + new 25 + last-minute 15 = 70
    expect(riskScore(input({ priorAppointments: 4, priorNoShows: 2, isNewPatient: true, bookedDaysAhead: 1 }))).toBe(70);
    // history 1*60=60 + new 25 + long-ago 10 = 95
    expect(riskScore(input({ priorAppointments: 3, priorNoShows: 3, isNewPatient: true, bookedDaysAhead: 45 }))).toBe(95);
    // Over-100 combination clamps.
    expect(riskScore(input({ priorAppointments: 2, priorNoShows: 2, isNewPatient: true, bookedDaysAhead: 1 }))).toBe(100);
    // No history, no flags = 0.
    expect(riskScore(input({ priorAppointments: 0, priorNoShows: 0, isNewPatient: false, bookedDaysAhead: 10 }))).toBe(0);
  });

  it("guards divide-by-zero: zero prior appointments contributes no history score", () => {
    expect(riskScore(input({ priorAppointments: 0, priorNoShows: 5, isNewPatient: false, bookedDaysAhead: 10 }))).toBe(0);
  });
});

describe("bandFor boundaries line up with the target the module stamps", () => {
  it.each([
    [59, "medium"],
    [60, "high"],
    [29, "low"],
    [30, "medium"],
  ])("score %i -> band %s", (score, band) => {
    expect(bandFor(score)).toBe(band);
  });

  it("toNoshowTarget stamps riskScore and riskBand consistently with the pure functions", () => {
    // history 1*60=60 -> exactly the high boundary.
    const i = input({ priorAppointments: 2, priorNoShows: 2 });
    const t = toNoshowTarget(i)!;
    expect(t.riskScore).toBe(riskScore(i));
    expect(t.riskBand).toBe(bandFor(t.riskScore));
    expect(t.riskScore).toBe(60);
    expect(t.riskBand).toBe("high");
  });
});
