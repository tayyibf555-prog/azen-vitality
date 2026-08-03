import { describe, it, expect, vi } from "vitest";
import { AGENT_TOOLS, makeDispatch, writeDisabledResult, type AgentWriteTool } from "./tools";

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

// Booking now REVALIDATES the slot against live availability immediately before
// the write, so every book fixture has to offer an open diary. Only future slots
// inside the booking horizon come back from that read, so the fixtures are pinned
// a few days ahead of the real clock rather than to a fixed date that ages out.
const SITE_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";
const SLOT_START = new Date(Date.now() + 3 * 86_400_000).toISOString();
const SLOT_FINISH = new Date(Date.parse(SLOT_START) + 30 * 60_000).toISOString();

/** An availability reader offering one clinician's open window around a slot. */
function openDiary(
  practitionerId = "42",
  start = SLOT_START,
  windowMinutes = 240,
): { listPractitioners: ReturnType<typeof vi.fn>; getAvailability: ReturnType<typeof vi.fn> } {
  return {
    listPractitioners: vi.fn().mockResolvedValue({
      practitioners: [{ id: practitionerId, active: true, site_id: SITE_UUID }],
    }),
    getAvailability: vi.fn().mockResolvedValue({
      availability: [
        {
          start_time: start,
          finish_time: new Date(Date.parse(start) + windowMinutes * 60_000).toISOString(),
          practitioner_id: practitionerId,
        },
      ],
    }),
  };
}

/** An availability reader with nothing free at all (the slot has just gone). */
function emptyDiary(): { listPractitioners: ReturnType<typeof vi.fn>; getAvailability: ReturnType<typeof vi.fn> } {
  return {
    listPractitioners: vi.fn().mockResolvedValue({
      practitioners: [{ id: "42", active: true, site_id: SITE_UUID }],
    }),
    getAvailability: vi.fn().mockResolvedValue({ availability: [] }),
  };
}

describe("makeDispatch", () => {
  const context = { patientId: "pat-010", siteId: "site-cc", patientName: "Harold", treatment: "Invisalign", fundingType: "private" as const };

  it("find_slots lists the site's active practitioners then queries their availability", async () => {
    const dentally = {
      listPractitioners: vi.fn().mockResolvedValue({
        practitioners: [
          { id: 10383, active: true, site_id: "3286d822-68c5-48ff-b1a2-065780dfcd15" },
          { id: 999, active: false, site_id: "3286d822-68c5-48ff-b1a2-065780dfcd15" }, // inactive: excluded
        ],
      }),
      // finish_time is part of the live Dentally availability contract and is now
      // required: rows are chunked into bookable units, so a row without an end
      // cannot be sized and is dropped rather than offered whole.
      getAvailability: vi.fn().mockResolvedValue({
        availability: [{ start_time: "2026-06-22T09:00:00Z", finish_time: "2026-06-22T09:30:00Z" }],
      }),
      createAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const out = await dispatch("find_slots", { treatment: "Invisalign" });
    // The internal id is mapped to Dentally's own site UUID before the API call,
    // and availability is queried per practitioner with datetimes (live contract).
    expect(dentally.listPractitioners).toHaveBeenCalledWith("3286d822-68c5-48ff-b1a2-065780dfcd15");
    expect(dentally.getAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ practitionerIds: ["10383"] }),
    );
    // Slots are re-serialised when the availability window is chunked into bookable
    // units, so the string gains milliseconds. Compare the instant, not the spelling.
    const { slots } = JSON.parse(out) as { slots: Array<{ start_time: string; finish_time: string }> };
    expect(slots).toHaveLength(1);
    expect(Date.parse(slots[0]!.start_time)).toBe(Date.parse("2026-06-22T09:00:00Z"));
  });

  it("book sends the calibrated real-Dentally fields: reason/practitioner/finish, not treatment/site_id", async () => {
    const dentally = {
      ...openDiary(),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-1" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const out = await dispatch("book", {
      slotStart: SLOT_START,
      finishTime: SLOT_FINISH,
      practitionerId: "42",
      treatment: "Invisalign",
    });
    const payload = dentally.createAppointment.mock.calls[0][0];
    expect(payload).toMatchObject({
      patient_id: "pat-010",
      start_time: SLOT_START,
      finish_time: SLOT_FINISH,
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
    const dentally = { ...openDiary(), createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "a" } }) };
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    await dispatch("book", { slotStart: SLOT_START, finishTime: SLOT_FINISH, practitionerId: "42", treatment: "checkup" });
    expect(dentally.createAppointment.mock.calls[0][0]).toMatchObject({ reason: "Exam" }); // checkup -> Exam
  });

  it("book REFUSES to write a slot with no practitioner (never sends an invalid payload)", async () => {
    const dentally = { getAvailability: vi.fn(), createAppointment: vi.fn() };
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const out = await dispatch("book", { slotStart: SLOT_START, finishTime: SLOT_FINISH, treatment: "Invisalign" });
    expect(dentally.createAppointment).not.toHaveBeenCalled();
    expect(JSON.parse(out).error).toBeTruthy();
  });

  it("book derives finish_time from the treatment length when the slot omits it", async () => {
    const dentally = { ...openDiary(), createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-3" } }) };
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    await dispatch("book", { slotStart: SLOT_START, practitionerId: "42", treatment: "Invisalign" });
    const payload = dentally.createAppointment.mock.calls[0][0];
    expect(typeof payload.finish_time).toBe("string");
    expect(Date.parse(payload.finish_time as string)).toBeGreaterThan(Date.parse(SLOT_START));
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
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const out = await dispatch("find_appointments", {});
    expect(out).toContain("appt-up");
    expect(out).not.toContain("appt-past");
    expect(out).not.toContain("appt-cancelled");
  });

  it("reschedule moves an appointment via updateAppointment (own appointment)", async () => {
    const dentally = {
      getAvailability: vi.fn(), createAppointment: vi.fn(),
      // Ownership check re-derives the caller's appointments; appt-9 is theirs.
      getPatientAppointments: vi.fn().mockResolvedValue({
        appointments: [
          { id: "appt-9", state: "booked", start_time: "2026-06-25T09:00:00Z", finish_time: "2026-06-25T09:30:00Z" },
        ],
      }),
      updateAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-9", start_time: "2026-07-01T10:00:00Z" } }),
      cancelAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const out = await dispatch("reschedule", { appointmentId: "appt-9", newSlotStart: "2026-07-01T10:00:00Z" });
    // finish_time is derived from the appointment's own duration (30 min here).
    expect(dentally.updateAppointment).toHaveBeenCalledWith("appt-9", {
      start_time: "2026-07-01T10:00:00Z",
      finish_time: "2026-07-01T10:30:00.000Z",
    });
    expect(out).toContain("rescheduled");
    expect(out).toContain("appt-9");
  });

  it("cancel cancels an appointment via cancelAppointment (own appointment)", async () => {
    const dentally = {
      getAvailability: vi.fn(), createAppointment: vi.fn(), updateAppointment: vi.fn(),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [{ id: "appt-9", state: "booked" }] }),
      cancelAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-9", state: "cancelled" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const out = await dispatch("cancel", { appointmentId: "appt-9" });
    expect(dentally.cancelAppointment).toHaveBeenCalledWith("appt-9");
    expect(out).toContain("cancelled");
  });

  it("register_patient onboards a new patient and later book uses the new id", async () => {
    const dentally = {
      ...openDiary(),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [] }),
      updateAppointment: vi.fn(), cancelAppointment: vi.fn(),
      createPatient: vi.fn().mockResolvedValue({ patient: { id: "pat-new" } }),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-2" } }),
    };
    const leadContext = { ...context, patientId: "lead:+447403097379", phone: "+447403097379", isKnownPatient: false };
    const dispatch = makeDispatch({ dentally: dentally as never, context: leadContext, writesEnabled: true });

    const reg = await dispatch("register_patient", { firstName: "John", lastName: "Smith", email: "john@example.com" });
    expect(dentally.createPatient).toHaveBeenCalledWith(
      expect.objectContaining({ first_name: "John", last_name: "Smith", mobile_phone: "+447403097379" }),
    );
    expect(reg).toContain("pat-new");

    await dispatch("book", { slotStart: SLOT_START, finishTime: SLOT_FINISH, practitionerId: "42", treatment: "Checkup" });
    expect(dentally.createAppointment).toHaveBeenCalledWith(expect.objectContaining({ patient_id: "pat-new" }));
  });

  it("treatment_info returns non-clinical info from the catalogue", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context, writesEnabled: true });
    const out = await dispatch("treatment_info", { treatment: "how much is invisalign" });
    expect(out).toContain("Invisalign");
    expect(out).toContain("2500"); // priceFrom
    expect(out).toContain("found");
  });

  it("treatment_info returns found:false for a treatment we do not list", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context, writesEnabled: true });
    const out = await dispatch("treatment_info", { treatment: "spaceship repair" });
    expect(out).toContain("false");
  });

  it("send_onboarding_form returns the practice's public onboarding link", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context, writesEnabled: true });
    const out = JSON.parse(await dispatch("send_onboarding_form", {}));
    expect(out.url).toMatch(/\/onboard\/vitality$/); // site-cc -> client "vitality"
    expect(out.error).toBeUndefined();
  });

  it("send_onboarding_form honours a specific form slug when given one", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context, writesEnabled: true });
    const out = JSON.parse(await dispatch("send_onboarding_form", { slug: "implants" }));
    expect(out.url).toMatch(/\/onboard\/vitality\/implants$/);
  });

  it("escalate_to_human acknowledges without external calls", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context, writesEnabled: true });
    const out = await dispatch("escalate_to_human", { reason: "clinical question" });
    expect(out).toContain("escalated");
  });

  it("returns an error string for an unknown tool", async () => {
    const dispatch = makeDispatch({ dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never, context, writesEnabled: true });
    expect(await dispatch("nope", {})).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// THE AGENT'S WRITE GATE.
//
// Every other Dentally write in this codebase checks isDentallyWriteEnabled()
// before it writes. These four tools were the outlier: nothing stood between the
// model and Dentally but whichever client the caller injected — and this is the
// one write path a language model drives. Two entry points already build them
// (the inbound webhook and the dev harness), so a route-level check would have
// been forgotten by the third.
//
// Every case below asserts BOTH halves: that Dentally is not touched, and that
// what comes back does not read as a success. A refusal a model reads as a
// confirmation is worse than no gate at all — the patient is then told they have
// an appointment that does not exist.
// ---------------------------------------------------------------------------
describe("makeDispatch with writes disabled", () => {
  const context = {
    patientId: "pat-010",
    siteId: "site-cc",
    patientName: "Harold",
    treatment: "Invisalign",
    fundingType: "private" as const,
  };

  /**
   * A fully capable client. If a write happens, it is the gate that failed.
   *
   * The patient's existing appointment is deliberately at a DIFFERENT time from the
   * slot `book` is asked for. With it at the same time, `book`'s idempotency check
   * ("you already hold an appointment at this exact time") short-circuits before
   * createAppointment — so the write assertion below would have passed with the gate
   * removed, pinning nothing. It still carries the id reschedule/cancel act on,
   * which they match by id, not by time.
   */
  const OWNED_START = new Date(Date.parse(SLOT_START) + 86_400_000).toISOString();
  function writableClient() {
    return {
      ...openDiary(),
      getPatientAppointments: vi.fn().mockResolvedValue({
        appointments: [
          {
            id: "appt-own",
            start_time: OWNED_START,
            finish_time: new Date(Date.parse(OWNED_START) + 30 * 60_000).toISOString(),
            practitioner_id: "42",
            state: "active",
          },
        ],
      }),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-1" } }),
      updateAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-own" } }),
      cancelAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-own", state: "cancelled" } }),
      createPatient: vi.fn().mockResolvedValue({ patient: { id: "pat-new" } }),
    };
  }

  const calls: Array<[string, string, Record<string, unknown>]> = [
    ["book", "createAppointment", { slotStart: SLOT_START, finishTime: SLOT_FINISH, practitionerId: "42", treatment: "Checkup" }],
    ["reschedule", "updateAppointment", { appointmentId: "appt-own", newSlotStart: SLOT_START, newFinishTime: SLOT_FINISH }],
    ["cancel", "cancelAppointment", { appointmentId: "appt-own" }],
    ["register_patient", "createPatient", { firstName: "John", lastName: "Smith" }],
  ];

  for (const [tool, method, input] of calls) {
    it(`${tool} never reaches Dentally's ${method}`, async () => {
      const dentally = writableClient();
      const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: false });
      await dispatch(tool, input);
      expect(dentally[method as keyof typeof dentally]).not.toHaveBeenCalled();
    });

    it(`${tool} returns the refusal, and nothing a model can read as success`, async () => {
      const dispatch = makeDispatch({ dentally: writableClient() as never, context, writesEnabled: false });
      const out = await dispatch(tool, input);
      expect(out).toBe(writeDisabledResult(tool as AgentWriteTool));
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed.error).toBeTruthy();
      // No field a model might skim for confirmation is truthy — including the id
      // fields, which are what a model quotes back to the patient.
      for (const flag of ["booked", "rescheduled", "cancelled", "registered", "appointmentId", "patientId"]) {
        expect(parsed[flag]).toBeFalsy();
      }
    });
  }

  it("still lets the READ tools work, so the agent can still answer the patient", async () => {
    const dentally = writableClient();
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: false });
    const { slots } = JSON.parse(await dispatch("find_slots", { treatment: "Checkup" })) as { slots: unknown[] };
    expect(slots.length).toBeGreaterThan(0);
    expect(JSON.parse(await dispatch("find_appointments", {})) as { appointments: unknown[] }).toHaveProperty("appointments");
    expect(await dispatch("treatment_info", { treatment: "Invisalign" })).toContain("Invisalign");
    expect(await dispatch("escalate_to_human", { reason: "writes off" })).toContain("escalated");
  });

  // register_patient sets registeredPatientId, which a later `book` in the same
  // turn books against. A refusal that still set it would have `book` write for a
  // patient id that was never created.
  it("a refused register_patient does not leave a phantom patient for a later book", async () => {
    const dentally = writableClient();
    const leadContext = { ...context, patientId: "lead:+447403097379", phone: "+447403097379", isKnownPatient: false };
    const dispatch = makeDispatch({ dentally: dentally as never, context: leadContext, writesEnabled: false });
    await dispatch("register_patient", { firstName: "John", lastName: "Smith" });
    await dispatch("book", { slotStart: SLOT_START, finishTime: SLOT_FINISH, practitionerId: "42", treatment: "Checkup" });
    expect(dentally.createPatient).not.toHaveBeenCalled();
    expect(dentally.createAppointment).not.toHaveBeenCalled();
  });
});

describe("writeDisabledResult", () => {
  const tools: AgentWriteTool[] = ["book", "reschedule", "cancel", "register_patient"];

  it("carries the NEGATIVE of each tool's own success flag", () => {
    expect(JSON.parse(writeDisabledResult("book"))).toMatchObject({ booked: false });
    expect(JSON.parse(writeDisabledResult("reschedule"))).toMatchObject({ rescheduled: false });
    expect(JSON.parse(writeDisabledResult("cancel"))).toMatchObject({ cancelled: false });
    expect(JSON.parse(writeDisabledResult("register_patient"))).toMatchObject({ registered: false });
  });

  // The model speaks next. It must hand over rather than improvise a confirmation.
  it("tells the model to escalate to a human", () => {
    for (const t of tools) expect(writeDisabledResult(t)).toContain("escalate_to_human");
  });

  it("states that nothing happened, in words the model can repeat", () => {
    for (const t of tools) {
      expect(JSON.parse(writeDisabledResult(t)).error as string).toMatch(
        /nothing has been (booked|created)|nothing has moved|still stands|still in the diary/i,
      );
    }
  });

  // Project rule: nothing the agent says may name a funding regime, and this text
  // is written to be paraphrased straight into a patient message.
  it("names no funding regime", () => {
    for (const t of tools) expect(writeDisabledResult(t)).not.toMatch(/\b(NHS|private|band [123])\b/i);
  });
});
