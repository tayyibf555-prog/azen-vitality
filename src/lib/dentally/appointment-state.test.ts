import { describe, it, expect } from "vitest";
import { normaliseAppointmentState } from "./appointment-state";

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
