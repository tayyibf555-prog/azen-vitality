import { describe, it, expect, vi } from "vitest";
import { AGENT_TOOLS, makeDispatch } from "./tools";

describe("AGENT_TOOLS", () => {
  it("exposes the full appointment tool set: find, book, reschedule, cancel, escalate", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "book",
      "cancel",
      "escalate_to_human",
      "find_appointments",
      "find_slots",
      "register_patient",
      "reschedule",
      "send_onboarding_form",
      "treatment_info",
    ]);
  });
});

describe("makeDispatch", () => {
  const context = { patientId: "pat-010", siteId: "site-cc", patientName: "Harold", treatment: "Invisalign", fundingType: "private" as const };

  it("find_slots returns the diary slots from Dentally", async () => {
    const dentally = {
      getAvailability: vi.fn().mockResolvedValue({ availability: [{ start_time: "2026-06-22T09:00:00Z" }] }),
      createAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("find_slots", { treatment: "Invisalign" });
    expect(dentally.getAvailability).toHaveBeenCalledWith(expect.objectContaining({ siteId: "site-cc" }));
    expect(out).toContain("2026-06-22T09:00:00Z");
  });

  it("book sends the calibrated real-Dentally fields: reason/practitioner/finish, not treatment/site_id", async () => {
    const dentally = {
      getAvailability: vi.fn(),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-1" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("book", {
      slotStart: "2026-06-22T09:00:00Z",
      finishTime: "2026-06-22T09:30:00Z",
      practitionerId: "42",
      treatment: "Invisalign",
    });
    const payload = dentally.createAppointment.mock.calls[0][0];
    expect(payload).toMatchObject({
      patient_id: "pat-010",
      start_time: "2026-06-22T09:00:00Z",
      finish_time: "2026-06-22T09:30:00Z",
      practitioner_id: "42",
      reason: "Other", // Invisalign -> Other; the treatment name goes in notes
      booked_via_api: true,
    });
    expect(payload.treatment).toBeUndefined(); // NOT a Dentally field
    expect(payload.site_id).toBeUndefined(); // site is implied by the practitioner
    expect(payload.notes).toContain("Invisalign");
    expect(out).toContain("appt-1");
  });

  it("book maps the treatment onto a valid Dentally reason enum", async () => {
    const dentally = { getAvailability: vi.fn(), createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "a" } }) };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    await dispatch("book", { slotStart: "2026-06-22T09:00:00Z", finishTime: "2026-06-22T09:30:00Z", practitionerId: "42", treatment: "checkup" });
    expect(dentally.createAppointment.mock.calls[0][0]).toMatchObject({ reason: "Exam" }); // checkup -> Exam
  });

  it("book REFUSES to write a slot with no practitioner (never sends an invalid payload)", async () => {
    const dentally = { getAvailability: vi.fn(), createAppointment: vi.fn() };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("book", { slotStart: "2026-06-22T09:00:00Z", finishTime: "2026-06-22T09:30:00Z", treatment: "Invisalign" });
    expect(dentally.createAppointment).not.toHaveBeenCalled();
    expect(JSON.parse(out).error).toBeTruthy();
  });

  it("book derives finish_time from the treatment length when the slot omits it", async () => {
    const dentally = { getAvailability: vi.fn(), createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-3" } }) };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    await dispatch("book", { slotStart: "2026-06-22T09:00:00Z", practitionerId: "42", treatment: "Invisalign" });
    const payload = dentally.createAppointment.mock.calls[0][0];
    expect(typeof payload.finish_time).toBe("string");
    expect(Date.parse(payload.finish_time as string)).toBeGreaterThan(Date.parse("2026-06-22T09:00:00Z"));
  });

  it("find_appointments returns only upcoming, active appointments", async () => {
    const dentally = {
      getAvailability: vi.fn(), createAppointment: vi.fn(), updateAppointment: vi.fn(), cancelAppointment: vi.fn(),
      getPatientAppointments: vi.fn().mockResolvedValue({
        appointments: [
          { id: "appt-past", start_time: "2020-01-01T09:00:00Z", state: "completed" },
          { id: "appt-cancelled", start_time: "2999-01-01T09:00:00Z", state: "cancelled" },
          { id: "appt-up", start_time: "2999-01-01T09:00:00Z", state: "booked" },
        ],
      }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("find_appointments", {});
    expect(out).toContain("appt-up");
    expect(out).not.toContain("appt-past");
    expect(out).not.toContain("appt-cancelled");
  });

  it("reschedule moves an appointment via updateAppointment (own appointment)", async () => {
    const dentally = {
      getAvailability: vi.fn(), createAppointment: vi.fn(),
      // Ownership check re-derives the caller's appointments; appt-9 is theirs.
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [{ id: "appt-9", state: "booked" }] }),
      updateAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-9", start_time: "2026-07-01T10:00:00Z" } }),
      cancelAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("reschedule", { appointmentId: "appt-9", newSlotStart: "2026-07-01T10:00:00Z" });
    expect(dentally.updateAppointment).toHaveBeenCalledWith("appt-9", { start_time: "2026-07-01T10:00:00Z" });
    expect(out).toContain("rescheduled");
    expect(out).toContain("appt-9");
  });

  it("cancel cancels an appointment via cancelAppointment (own appointment)", async () => {
    const dentally = {
      getAvailability: vi.fn(), createAppointment: vi.fn(), updateAppointment: vi.fn(),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [{ id: "appt-9", state: "booked" }] }),
      cancelAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-9", state: "cancelled" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context });
    const out = await dispatch("cancel", { appointmentId: "appt-9" });
    expect(dentally.cancelAppointment).toHaveBeenCalledWith("appt-9");
    expect(out).toContain("cancelled");
  });

  it("register_patient onboards a new patient and later book uses the new id", async () => {
    const dentally = {
      getAvailability: vi.fn(), getPatientAppointments: vi.fn(), updateAppointment: vi.fn(), cancelAppointment: vi.fn(),
      createPatient: vi.fn().mockResolvedValue({ patient: { id: "pat-new" } }),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-2" } }),
    };
    const leadContext = { ...context, patientId: "lead:+447403097379", phone: "+447403097379", isKnownPatient: false };
    const dispatch = makeDispatch({ dentally: dentally as never, context: leadContext });

    const reg = await dispatch("register_patient", { firstName: "John", lastName: "Smith", email: "john@example.com" });
    expect(dentally.createPatient).toHaveBeenCalledWith(
      expect.objectContaining({ first_name: "John", last_name: "Smith", mobile_phone: "+447403097379" }),
    );
    expect(reg).toContain("pat-new");

    await dispatch("book", { slotStart: "2026-07-01T09:00:00Z", finishTime: "2026-07-01T09:30:00Z", practitionerId: "42", treatment: "Checkup" });
    expect(dentally.createAppointment).toHaveBeenCalledWith(expect.objectContaining({ patient_id: "pat-new" }));
  });

  it("treatment_info returns non-clinical info from the catalogue", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    const out = await dispatch("treatment_info", { treatment: "how much is invisalign" });
    expect(out).toContain("Invisalign");
    expect(out).toContain("2500"); // priceFrom
    expect(out).toContain("found");
  });

  it("treatment_info returns found:false for a treatment we do not list", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    const out = await dispatch("treatment_info", { treatment: "spaceship repair" });
    expect(out).toContain("false");
  });

  it("send_onboarding_form returns the practice's public onboarding link", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    const out = JSON.parse(await dispatch("send_onboarding_form", {}));
    expect(out.url).toMatch(/\/onboard\/vitality$/); // site-cc -> client "vitality"
    expect(out.error).toBeUndefined();
  });

  it("send_onboarding_form honours a specific form slug when given one", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    const out = JSON.parse(await dispatch("send_onboarding_form", { slug: "implants" }));
    expect(out.url).toMatch(/\/onboard\/vitality\/implants$/);
  });

  it("escalate_to_human acknowledges without external calls", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    const out = await dispatch("escalate_to_human", { reason: "clinical question" });
    expect(out).toContain("escalated");
  });

  it("returns an error string for an unknown tool", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context });
    expect(await dispatch("nope", {})).toContain("unknown");
  });
});
