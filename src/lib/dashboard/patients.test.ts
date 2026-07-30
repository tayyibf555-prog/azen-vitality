import { describe, expect, it } from "vitest";

import type {
  DashboardAppointment,
  DashboardPatient,
  DashboardTreatmentPlan,
} from "@/lib/dashboard/normalise";
import { computePatientCounts, computeTreatmentPlanCounts } from "@/lib/dashboard/patients";

const WINDOW = { from: "2026-07-01", to: "2026-07-30" };

function patient(over: Partial<DashboardPatient> & { id: string }): DashboardPatient {
  return { siteId: "site-cc", createdDay: null, active: null, archived: false, ...over };
}

function appt(
  day: string,
  state: string,
  patientId: string,
  siteId = "site-cc",
): DashboardAppointment {
  return { id: `${day}-${patientId}`, day, siteId, practitionerId: "prac-1", patientId, state };
}

function plan(over: Partial<DashboardTreatmentPlan> & { id: string }): DashboardTreatmentPlan {
  return {
    siteId: "site-cc",
    startedDay: null,
    finishedDay: null,
    hasFinishField: true,
    ...over,
  };
}

describe("computePatientCounts", () => {
  const patients = [
    patient({ id: "p1", createdDay: "2026-07-05", active: true }),
    patient({ id: "p2", createdDay: "2026-07-29", active: true }),
    patient({ id: "p3", createdDay: "2026-06-30", active: true }),
    patient({ id: "p4", createdDay: "2025-01-01", active: false }),
    patient({ id: "p5", createdDay: "2025-01-01", active: true, archived: true }),
    patient({ id: "p6", createdDay: "2026-07-10", active: true, siteId: "site-rv" }),
  ];
  const appointments = [
    appt("2026-07-20", "Completed", "p1"),
    appt("2026-07-21", "Completed", "p1"),
    appt("2026-07-22", "Completed", "p3"),
    appt("2026-07-22", "Cancelled", "p4"),
    appt("2026-06-01", "Completed", "p2"),
  ];

  it("counts new in the window, seen from completed appointments, and active on the books", () => {
    expect(computePatientCounts({ patients, appointments, window: WINDOW })).toEqual({
      newCount: 3,
      seenCount: 2,
      activeCount: 4,
    });
  });

  it("scopes each count to the selected site", () => {
    expect(computePatientCounts({ patients, appointments, window: WINDOW, siteId: "site-rv" })).toEqual({
      newCount: 1,
      seenCount: 0,
      activeCount: 1,
    });
  });

  it("reports null, not zero, when the source carries no registration date at all", () => {
    const undated = [patient({ id: "p1", active: true }), patient({ id: "p2", active: true })];
    const counts = computePatientCounts({ patients: undated, appointments, window: WINDOW });
    expect(counts.newCount).toBeNull();
    expect(counts.activeCount).toBe(2);
  });

  it("reports null when the source carries no active flag at all", () => {
    const noFlag = [patient({ id: "p1", createdDay: "2026-07-05" })];
    const counts = computePatientCounts({ patients: noFlag, appointments, window: WINDOW });
    expect(counts.activeCount).toBeNull();
    expect(counts.newCount).toBe(1);
  });

  it("reports null for every count the caller could not fetch data for", () => {
    expect(computePatientCounts({ patients: null, appointments: null, window: WINDOW })).toEqual({
      newCount: null,
      seenCount: null,
      activeCount: null,
    });
  });

  it("returns zero, not null, when the data is there and the window is genuinely empty", () => {
    const counts = computePatientCounts({
      patients: [patient({ id: "p1", createdDay: "2020-01-01", active: true })],
      appointments: [],
      window: WINDOW,
    });
    expect(counts.newCount).toBe(0);
    expect(counts.seenCount).toBe(0);
    expect(counts.activeCount).toBe(1);
  });
});

describe("computeTreatmentPlanCounts", () => {
  const plans = [
    plan({ id: "a", startedDay: "2026-07-02", finishedDay: null }),
    plan({ id: "b", startedDay: "2026-07-10", finishedDay: "2026-07-20" }),
    plan({ id: "c", startedDay: "2026-06-01", finishedDay: "2026-07-15" }),
    plan({ id: "d", startedDay: "2026-06-01", finishedDay: null }),
    plan({ id: "e", startedDay: "2026-05-01", finishedDay: "2026-06-01" }),
    plan({ id: "f", startedDay: "2026-07-05", finishedDay: null, siteId: "site-ng" }),
  ];

  it("counts started and finished inside the window, and open at its close", () => {
    expect(computeTreatmentPlanCounts({ plans, window: WINDOW })).toEqual({
      started: 3,
      finished: 2,
      open: 3,
    });
  });

  it("scopes to the selected site", () => {
    expect(computeTreatmentPlanCounts({ plans, window: WINDOW, siteId: "site-ng" })).toEqual({
      started: 1,
      finished: 0,
      open: 1,
    });
  });

  it("counts a plan finished after the window closes as still open", () => {
    const later = [plan({ id: "x", startedDay: "2026-07-01", finishedDay: "2026-08-15" })];
    expect(computeTreatmentPlanCounts({ plans: later, window: WINDOW })).toEqual({
      started: 1,
      finished: 0,
      open: 1,
    });
  });

  it("reports null when the source exposes no finish field at all", () => {
    const noFinish = [
      { id: "a", siteId: "site-cc", startedDay: "2026-07-02", finishedDay: null, hasFinishField: false },
    ];
    expect(computeTreatmentPlanCounts({ plans: noFinish, window: WINDOW })).toEqual({
      started: 1,
      finished: null,
      open: null,
    });
  });

  it("reports null when the source exposes no start date at all", () => {
    const noStart = [plan({ id: "a", startedDay: null, finishedDay: "2026-07-10" })];
    expect(computeTreatmentPlanCounts({ plans: noStart, window: WINDOW })).toEqual({
      started: null,
      finished: 1,
      open: null,
    });
  });

  it("reports null for everything when the caller could not fetch plans", () => {
    expect(computeTreatmentPlanCounts({ plans: null, window: WINDOW })).toEqual({
      started: null,
      finished: null,
      open: null,
    });
  });
});
