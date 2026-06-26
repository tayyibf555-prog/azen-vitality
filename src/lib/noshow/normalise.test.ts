import { describe, it, expect } from "vitest";
import { riskScore, bandFor, toNoshowTarget, rankByRisk, type NoshowInput } from "./normalise";
import type { NoshowTarget } from "./types";

const NOW = new Date("2026-06-26T09:00:00.000Z");

function input(overrides: Partial<NoshowInput> = {}): NoshowInput {
  return {
    siteId: "site-cc",
    dentallyPatientId: "pat-1",
    patientName: "Sam Lee",
    appointment: {
      id: "appt-1",
      start: "2026-06-29T10:00:00.000Z", // 3 days out
      state: "booked",
      durationMin: 30,
      practitioner: "Dr Khan",
    },
    priorAppointments: 4,
    priorNoShows: 0,
    isNewPatient: false,
    bookedDaysAhead: 10,
    consent: { sms: true, email: true, marketing: false },
    now: NOW,
    ...overrides,
  };
}

describe("riskScore", () => {
  it("is driven mostly by no-show history", () => {
    expect(riskScore(input({ priorAppointments: 4, priorNoShows: 0 }))).toBe(0);
    expect(riskScore(input({ priorAppointments: 4, priorNoShows: 2 }))).toBe(30); // .5 * 60
    expect(riskScore(input({ priorAppointments: 3, priorNoShows: 3 }))).toBe(60); // 1 * 60
  });

  it("adds risk for new patients", () => {
    expect(riskScore(input({ isNewPatient: true, priorAppointments: 0, priorNoShows: 0 }))).toBe(25);
  });

  it("adds risk for very last-minute bookings", () => {
    expect(riskScore(input({ bookedDaysAhead: 1, priorAppointments: 0 }))).toBe(15);
  });

  it("clamps to 0-100", () => {
    const s = riskScore(input({ priorAppointments: 2, priorNoShows: 2, isNewPatient: true, bookedDaysAhead: 1 }));
    expect(s).toBeLessThanOrEqual(100);
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

describe("bandFor", () => {
  it("maps score to a band at the right boundaries", () => {
    expect(bandFor(60)).toBe("high");
    expect(bandFor(59)).toBe("medium");
    expect(bandFor(30)).toBe("medium");
    expect(bandFor(29)).toBe("low");
    expect(bandFor(0)).toBe("low");
  });
});

describe("toNoshowTarget", () => {
  it("builds a target for an in-window appointment", () => {
    const t = toNoshowTarget(input({ priorAppointments: 4, priorNoShows: 2 }));
    expect(t).not.toBeNull();
    expect(t!.id).toBe("site-cc:pat-1:appt-1");
    expect(t!.riskScore).toBe(30);
    expect(t!.riskBand).toBe("medium");
    expect(t!.status).toBe("scheduled");
    expect(t!.durationMin).toBe(30);
    expect(t!.practitioner).toBe("Dr Khan");
  });

  it("skips a past appointment", () => {
    expect(toNoshowTarget(input({ appointment: { id: "a", start: "2026-06-25T10:00:00Z", state: "booked", durationMin: 30, practitioner: null } }))).toBeNull();
  });

  it("skips an appointment beyond the lead window", () => {
    expect(toNoshowTarget(input({ appointment: { id: "a", start: "2026-07-20T10:00:00Z", state: "booked", durationMin: 30, practitioner: null } }))).toBeNull();
  });

  it("skips already-terminal states", () => {
    for (const state of ["cancelled", "did_not_attend", "completed"]) {
      expect(toNoshowTarget(input({ appointment: { id: "a", start: "2026-06-29T10:00:00Z", state, durationMin: 30, practitioner: null } }))).toBeNull();
    }
  });

  it("skips a malformed start date (fail-safe)", () => {
    expect(toNoshowTarget(input({ appointment: { id: "a", start: "not-a-date", state: "booked", durationMin: 30, practitioner: null } }))).toBeNull();
  });
});

describe("rankByRisk", () => {
  it("orders by risk desc then soonest appointment", () => {
    const mk = (id: string, riskScore: number, start: string): NoshowTarget => ({
      id, siteId: "s", dentallyPatientId: "p", appointmentId: id, patientName: "x",
      appointmentStartAt: start, appointmentState: "booked", durationMin: 30, practitioner: null,
      riskScore, riskBand: "low", status: "scheduled", priorAttempts: 0,
      consent: { sms: true, email: true, marketing: false }, updatedFromDentallyAt: NOW.toISOString(),
    });
    const ranked = rankByRisk([
      mk("a", 20, "2026-06-29T10:00:00Z"),
      mk("b", 80, "2026-06-30T10:00:00Z"),
      mk("c", 80, "2026-06-28T10:00:00Z"),
    ]);
    expect(ranked.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });
});
