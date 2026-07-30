import { describe, expect, it } from "vitest";

import {
  classifyState,
  computeOutcomeSplit,
  countPatientsSeen,
  stateKey,
} from "@/lib/dashboard/appointments";
import type { DashboardAppointment } from "@/lib/dashboard/normalise";

const WINDOW = { from: "2026-07-24", to: "2026-07-30" };

function appt(
  day: string,
  state: string,
  over: Partial<DashboardAppointment> = {},
): DashboardAppointment {
  return {
    id: over.id ?? `${day}-${state}-${over.patientId ?? "pat-001"}-${over.siteId ?? "site-cc"}`,
    day,
    siteId: "site-cc",
    practitionerId: "prac-1",
    patientId: "pat-001",
    state,
    ...over,
  };
}

describe("stateKey", () => {
  it("reduces Dentally's wording to a comparable key", () => {
    expect(stateKey("Did not attend")).toBe("did_not_attend");
    expect(stateKey("  Completed ")).toBe("completed");
    expect(stateKey("Cancelled-by-patient")).toBe("cancelled_by_patient");
    expect(stateKey("")).toBe("");
  });
});

describe("classifyState", () => {
  it("maps the three donut slices", () => {
    expect(classifyState("Completed")).toEqual({ bucket: "completed", recognised: true });
    expect(classifyState("Cancelled")).toEqual({ bucket: "cancelled", recognised: true });
    expect(classifyState("Did not attend")).toEqual({ bucket: "dna", recognised: true });
  });

  it("recognises in-flight states without putting them in a slice", () => {
    expect(classifyState("booked")).toEqual({ bucket: "other", recognised: true });
    expect(classifyState("Arrived")).toEqual({ bucket: "other", recognised: true });
  });

  it("refuses to guess at a state it has never seen", () => {
    expect(classifyState("Rebooked by triage")).toEqual({ bucket: "other", recognised: false });
    expect(classifyState("")).toEqual({ bucket: "other", recognised: false });
  });
});

describe("computeOutcomeSplit", () => {
  const appointments = [
    appt("2026-07-29", "Completed", { patientId: "pat-001" }),
    appt("2026-07-29", "Completed", { patientId: "pat-002" }),
    appt("2026-07-29", "Cancelled", { patientId: "pat-003" }),
    appt("2026-07-28", "Did not attend", { patientId: "pat-004" }),
    appt("2026-07-30", "booked", { patientId: "pat-005" }),
    appt("2026-07-23", "Completed", { patientId: "pat-006" }), // outside the window
  ];

  it("counts the donut and its centre total", () => {
    const split = computeOutcomeSplit({ appointments, window: WINDOW });
    expect(split).toEqual({
      completed: 2,
      cancelled: 1,
      dna: 1,
      other: 1,
      total: 5,
      unknownStates: [],
    });
  });

  it("reports an unrecognised state instead of filing it under a slice", () => {
    const split = computeOutcomeSplit({
      appointments: [...appointments, appt("2026-07-29", "Rebooked by triage", { id: "odd" })],
      window: WINDOW,
    });
    expect(split.completed).toBe(2);
    expect(split.cancelled).toBe(1);
    expect(split.dna).toBe(1);
    expect(split.other).toBe(2);
    expect(split.unknownStates).toEqual(["Rebooked by triage"]);
  });

  it("scopes to a site and to a practitioner", () => {
    const mixed = [
      appt("2026-07-29", "Completed", { siteId: "site-cc", practitionerId: "prac-1", id: "a" }),
      appt("2026-07-29", "Completed", { siteId: "site-rv", practitionerId: "prac-2", id: "b" }),
      appt("2026-07-29", "Completed", { siteId: "site-cc", practitionerId: "prac-2", id: "c" }),
    ];
    expect(computeOutcomeSplit({ appointments: mixed, window: WINDOW }).completed).toBe(3);
    expect(computeOutcomeSplit({ appointments: mixed, window: WINDOW, siteId: "site-cc" }).completed).toBe(2);
    expect(
      computeOutcomeSplit({ appointments: mixed, window: WINDOW, practitionerId: "prac-2" }).completed,
    ).toBe(2);
    expect(
      computeOutcomeSplit({
        appointments: mixed,
        window: WINDOW,
        siteId: "site-cc",
        practitionerId: "prac-2",
      }).completed,
    ).toBe(1);
  });

  it("returns a genuine set of zeroes for an empty window", () => {
    expect(computeOutcomeSplit({ appointments: [], window: WINDOW })).toEqual({
      completed: 0,
      cancelled: 0,
      dna: 0,
      other: 0,
      total: 0,
      unknownStates: [],
    });
  });
});

describe("countPatientsSeen", () => {
  it("counts distinct patients with a completed appointment, not appointments", () => {
    const appointments = [
      appt("2026-07-29", "Completed", { patientId: "pat-001", id: "a" }),
      appt("2026-07-28", "Completed", { patientId: "pat-001", id: "b" }),
      appt("2026-07-28", "Completed", { patientId: "pat-002", id: "c" }),
      appt("2026-07-28", "Cancelled", { patientId: "pat-003", id: "d" }),
      appt("2026-07-23", "Completed", { patientId: "pat-004", id: "e" }),
    ];
    expect(countPatientsSeen({ appointments, window: WINDOW })).toBe(2);
  });

  it("ignores appointments with no patient id", () => {
    const appointments = [appt("2026-07-29", "Completed", { patientId: null, id: "a" })];
    expect(countPatientsSeen({ appointments, window: WINDOW })).toBe(0);
  });
});
