// FIX 2: within-tenant IDOR on reschedule / cancel.
import { describe, it, expect, vi } from "vitest";
import { makeDispatch } from "./tools";
import type { AgentContext } from "./types";

const CTX: AgentContext = {
  patientId: "pat-010",
  siteId: "site-cc",
  patientName: "Harold Pemberton",
  treatment: "Invisalign",
  fundingType: "private",
  isKnownPatient: true,
};

function dentallyWithOwn(ownId: string) {
  return {
    getAvailability: vi.fn(),
    createAppointment: vi.fn(),
    getPatientAppointments: vi.fn().mockResolvedValue({
      appointments: [
        { id: ownId, start_time: "2026-08-01T09:00:00Z", finish_time: "2026-08-01T09:30:00Z", state: "scheduled" },
      ],
    }),
    updateAppointment: vi.fn().mockResolvedValue({ appointment: { id: ownId, start_time: "x" } }),
    cancelAppointment: vi.fn().mockResolvedValue({ appointment: { id: ownId, state: "cancelled" } }),
  };
}

describe("IDOR: reschedule enforces ownership server-side", () => {
  it("refuses a FOREIGN appointmentId and never calls updateAppointment", async () => {
    const dentally = dentallyWithOwn("appt-MINE");
    const dispatch = makeDispatch({ dentally: dentally as never, context: CTX, writesEnabled: true });
    const out = await dispatch("reschedule", {
      appointmentId: "appt-OTHER-PATIENT",
      newSlotStart: "2026-07-01T10:00:00Z",
    });
    expect(out).toContain("could not find that appointment");
    // Ownership was checked against the caller's own appointments...
    expect(dentally.getPatientAppointments).toHaveBeenCalledWith("pat-010");
    // ...and the foreign id never reached the mutation.
    expect(dentally.updateAppointment).not.toHaveBeenCalled();
  });

  it("still allows the patient's OWN appointment", async () => {
    const dentally = dentallyWithOwn("appt-MINE");
    const dispatch = makeDispatch({ dentally: dentally as never, context: CTX, writesEnabled: true });
    const out = await dispatch("reschedule", {
      appointmentId: "appt-MINE",
      newSlotStart: "2026-07-01T10:00:00Z",
    });
    expect(out).toContain("rescheduled");
    // finish_time is derived from the appointment's own 30-minute duration, so a
    // reschedule can never patch start_time alone (corrupted appointment).
    expect(dentally.updateAppointment).toHaveBeenCalledWith("appt-MINE", {
      start_time: "2026-07-01T10:00:00Z",
      finish_time: "2026-07-01T10:30:00.000Z",
    });
  });
});

describe("IDOR: cancel enforces ownership server-side", () => {
  it("refuses a FOREIGN appointmentId and never calls cancelAppointment", async () => {
    const dentally = dentallyWithOwn("appt-MINE");
    const dispatch = makeDispatch({ dentally: dentally as never, context: CTX, writesEnabled: true });
    const out = await dispatch("cancel", { appointmentId: "appt-OTHER" });
    expect(out).toContain("could not find that appointment");
    expect(dentally.getPatientAppointments).toHaveBeenCalledWith("pat-010");
    expect(dentally.cancelAppointment).not.toHaveBeenCalled();
  });

  it("still allows cancelling the patient's OWN appointment", async () => {
    const dentally = dentallyWithOwn("appt-MINE");
    const dispatch = makeDispatch({ dentally: dentally as never, context: CTX, writesEnabled: true });
    const out = await dispatch("cancel", { appointmentId: "appt-MINE" });
    expect(out).toContain("cancelled");
    expect(dentally.cancelAppointment).toHaveBeenCalledWith("appt-MINE");
  });
});
