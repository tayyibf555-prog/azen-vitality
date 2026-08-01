import { describe, it, expect } from "vitest";
import {
  appointmentStateLabel,
  isAttendedState,
  isCancelledState,
  isDidNotAttendState,
  isLiveBookingState,
  normaliseAppointmentState,
} from "./appointment-state";

const REAL = ["Pending", "Confirmed", "Arrived", "In surgery", "Completed", "Cancelled", "Did not attend"];

describe("normaliseAppointmentState", () => {
  it("maps every real Dentally state to the app's lowercase vocabulary", () => {
    // Verbatim from the Dentally API docs (case-sensitive, spaces included).
    expect(normaliseAppointmentState("Pending")).toBe("pending");
    expect(normaliseAppointmentState("Confirmed")).toBe("confirmed");
    expect(normaliseAppointmentState("Arrived")).toBe("arrived");
    expect(normaliseAppointmentState("In surgery")).toBe("in_surgery");
    expect(normaliseAppointmentState("Completed")).toBe("completed");
    expect(normaliseAppointmentState("Cancelled")).toBe("cancelled");
    expect(normaliseAppointmentState("Did not attend")).toBe("did_not_attend");
  });

  it("passes the mock's legacy vocabulary through unchanged", () => {
    expect(normaliseAppointmentState("booked")).toBe("booked");
    expect(normaliseAppointmentState("did_not_attend")).toBe("did_not_attend");
    expect(normaliseAppointmentState("completed")).toBe("completed");
  });

  it("falls back for non-string or empty input", () => {
    expect(normaliseAppointmentState(undefined)).toBe("booked");
    expect(normaliseAppointmentState(null)).toBe("booked");
    expect(normaliseAppointmentState(42)).toBe("booked");
    expect(normaliseAppointmentState("  ")).toBe("booked");
    expect(normaliseAppointmentState(undefined, "")).toBe("");
  });

  it("normalises stray hyphens and repeated whitespace", () => {
    expect(normaliseAppointmentState("Did-not-attend")).toBe("did_not_attend");
    expect(normaliseAppointmentState("did  not  attend")).toBe("did_not_attend");
  });
});

// The predicates below exist because the patient record decided "is this a live
// booking" with an ALLOW-list of two states, ["booked", "pending"]. "booked" is the
// MOCK's word and live Dentally never sends it; live sends Confirmed, Arrived and In
// surgery, none of which were in the set. So a patient who replied YES to a
// confirmation SMS moved to Confirmed and fell straight out, and the record printed
// "Next appointment: None booked" for a patient booked in that afternoon. A deny-list
// of the three terminal states is the rule that survives a vocabulary we do not own.
describe("isLiveBookingState", () => {
  it("counts Confirmed, Arrived and In surgery, which the old allow-list dropped", () => {
    for (const raw of ["Confirmed", "Arrived", "In surgery", "Pending"]) {
      expect(isLiveBookingState(normaliseAppointmentState(raw))).toBe(true);
    }
    expect(isLiveBookingState("booked")).toBe(true);
  });

  it("excludes the three states that close an appointment", () => {
    for (const raw of ["Cancelled", "Did not attend", "Completed"]) {
      expect(isLiveBookingState(normaliseAppointmentState(raw))).toBe(false);
    }
  });

  it("treats a state Dentally has not shipped yet as live rather than dropping it", () => {
    expect(isLiveBookingState("rescheduled")).toBe(true);
  });
});

describe("isAttendedState", () => {
  it("is true for Completed, Arrived and In surgery: the patient is in the building", () => {
    for (const raw of ["Completed", "Arrived", "In surgery"]) {
      expect(isAttendedState(normaliseAppointmentState(raw))).toBe(true);
    }
  });

  it("is false for a booking, a cancellation and a no-show", () => {
    for (const raw of ["Pending", "Confirmed", "Cancelled", "Did not attend"]) {
      expect(isAttendedState(normaliseAppointmentState(raw))).toBe(false);
    }
    expect(isAttendedState("booked")).toBe(false);
  });
});

describe("isCancelledState / isDidNotAttendState", () => {
  it("separates the two, because a no-show is not a cancellation", () => {
    expect(isCancelledState("cancelled")).toBe(true);
    expect(isCancelledState("did_not_attend")).toBe(false);
    expect(isDidNotAttendState("did_not_attend")).toBe(true);
    expect(isDidNotAttendState("cancelled")).toBe(false);
  });
});

describe("appointmentStateLabel", () => {
  it("gives every real state a human label", () => {
    expect(REAL.map((s) => appointmentStateLabel(normaliseAppointmentState(s)))).toEqual([
      "Pending",
      "Confirmed",
      "Arrived",
      "In surgery",
      "Completed",
      "Cancelled",
      "No-show",
    ]);
  });

  it("never leaks a raw underscored identifier onto a clinical screen", () => {
    expect(appointmentStateLabel("some_new_state")).toBe("Some new state");
    expect(appointmentStateLabel("")).toBe("Unknown");
  });
});
