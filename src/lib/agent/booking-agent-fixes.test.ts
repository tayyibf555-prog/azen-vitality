// CLUSTER D: the SMS booking agent writes into the REAL practice diary, so these
// cover the correctness fixes on that write path:
//  D1 the slot is revalidated against LIVE availability immediately before the
//     write, so a time taken since it was offered is refused, not double-booked
//  D2 a retried write is idempotent: memoised per dispatch, and checked against
//     the patient's own appointments before writing
//  D3 a reschedule carries the new slot's clinician, so it lands in the right diary
//  D5 a booking is only "booked" when the tool RESULT says so, never on an attempt
import { describe, it, expect, vi } from "vitest";
import { makeDispatch, spanStillOpen, AGENT_TOOLS } from "./tools";
import { runAgentTurn } from "./run";
import type { BookingDay } from "@/lib/booking/slots";

const SITE_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";
const CONTEXT = {
  patientId: "pat-010",
  siteId: "site-cc",
  patientName: "Harold",
  treatment: "Checkup",
  fundingType: "private" as const,
};

// Live availability only ever returns future slots inside the booking horizon,
// so fixtures sit a few days ahead of the real clock.
const START = new Date(Date.now() + 3 * 86_400_000).toISOString();
const FINISH = new Date(Date.parse(START) + 30 * 60_000).toISOString();

function day(slots: Array<{ start: string; finish: string; practitionerId: string | null }>): BookingDay[] {
  return [{ date: START.slice(0, 10), slots }];
}

function diary(rows: Array<{ start: string; finish: string; practitionerId?: string }>) {
  return {
    listPractitioners: vi.fn().mockResolvedValue({
      practitioners: [{ id: "42", active: true, site_id: SITE_UUID }],
    }),
    getAvailability: vi.fn().mockResolvedValue({
      availability: rows.map((r) => ({
        start_time: r.start,
        finish_time: r.finish,
        practitioner_id: r.practitionerId ?? "42",
      })),
    }),
  };
}

describe("spanStillOpen", () => {
  it("accepts a span sitting inside one open window", () => {
    const days = day([{ start: "2030-01-06T09:00:00Z", finish: "2030-01-06T17:00:00Z", practitionerId: "42" }]);
    expect(spanStillOpen(days, "2030-01-06T10:00:00Z", "2030-01-06T11:00:00Z", "42")).toBe(true);
  });

  it("accepts a span spread across two back-to-back slots", () => {
    const days = day([
      { start: "2030-01-06T09:00:00Z", finish: "2030-01-06T09:30:00Z", practitionerId: "42" },
      { start: "2030-01-06T09:30:00Z", finish: "2030-01-06T10:00:00Z", practitionerId: "42" },
    ]);
    expect(spanStillOpen(days, "2030-01-06T09:00:00Z", "2030-01-06T10:00:00Z", "42")).toBe(true);
  });

  it("rejects a span with a taken slot in the middle of it", () => {
    // 09:30 to 10:00 has gone, so an hour from 09:00 no longer fits.
    const days = day([
      { start: "2030-01-06T09:00:00Z", finish: "2030-01-06T09:30:00Z", practitionerId: "42" },
      { start: "2030-01-06T10:00:00Z", finish: "2030-01-06T10:30:00Z", practitionerId: "42" },
    ]);
    expect(spanStillOpen(days, "2030-01-06T09:00:00Z", "2030-01-06T10:00:00Z", "42")).toBe(false);
  });

  it("only counts the pinned clinician's own slots", () => {
    const days = day([{ start: "2030-01-06T09:00:00Z", finish: "2030-01-06T17:00:00Z", practitionerId: "99" }]);
    expect(spanStillOpen(days, "2030-01-06T09:00:00Z", "2030-01-06T09:30:00Z", "42")).toBe(false);
    expect(spanStillOpen(days, "2030-01-06T09:00:00Z", "2030-01-06T09:30:00Z", "99")).toBe(true);
  });

  it("rejects an empty diary and a nonsense span", () => {
    expect(spanStillOpen([], START, FINISH, "42")).toBe(false);
    expect(spanStillOpen(day([{ start: START, finish: FINISH, practitionerId: "42" }]), "not a date", FINISH, "42")).toBe(false);
  });
});

describe("D1: book revalidates the slot against live availability", () => {
  it("REFUSES a slot that has been taken since it was offered", async () => {
    const dentally = {
      ...diary([]), // the clinician's diary no longer offers it
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [] }),
      createAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    const out = JSON.parse(
      await dispatch("book", { slotStart: START, finishTime: FINISH, practitionerId: "42", treatment: "Checkup" }),
    );
    expect(dentally.createAppointment).not.toHaveBeenCalled();
    expect(out.booked).toBe(false);
    expect(out.error).toContain("just been taken");
  });

  it("writes the LIVE slot's own finish and clinician when it matches exactly", async () => {
    const dentally = {
      ...diary([{ start: START, finish: FINISH, practitionerId: "42" }]),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [] }),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-live" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    const out = JSON.parse(
      await dispatch("book", { slotStart: START, finishTime: FINISH, practitionerId: "42", treatment: "Checkup" }),
    );
    expect(dentally.createAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ start_time: START, finish_time: FINISH, practitioner_id: "42" }),
    );
    expect(out).toMatchObject({ booked: true, appointmentId: "appt-live" });
  });

  it("still books a slot further ahead than the public booking horizon", async () => {
    // 90 days out: the availability reader would drop that day from a read anchored
    // at today, and the patient would be told a free slot had been taken.
    const farStart = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const farFinish = new Date(Date.parse(farStart) + 30 * 60_000).toISOString();
    const dentally = {
      ...diary([{ start: farStart, finish: farFinish, practitionerId: "42" }]),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [] }),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-far" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    const out = JSON.parse(
      await dispatch("book", { slotStart: farStart, finishTime: farFinish, practitionerId: "42", treatment: "Checkup" }),
    );
    expect(out).toMatchObject({ booked: true, appointmentId: "appt-far" });
  });

  it("REFUSES a slot in the past, however the model came by it", async () => {
    const pastStart = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const pastFinish = new Date(Date.parse(pastStart) + 30 * 60_000).toISOString();
    const dentally = {
      ...diary([{ start: pastStart, finish: pastFinish, practitionerId: "42" }]),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [] }),
      createAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    const out = JSON.parse(
      await dispatch("book", { slotStart: pastStart, finishTime: pastFinish, practitionerId: "42", treatment: "Checkup" }),
    );
    expect(dentally.createAppointment).not.toHaveBeenCalled();
    expect(out.booked).toBe(false);
  });

  it("does NOT write when the availability read fails (the slot is unproven)", async () => {
    const dentally = {
      listPractitioners: vi.fn().mockRejectedValue(new Error("Dentally timeout")),
      getAvailability: vi.fn(),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [] }),
      createAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    await expect(
      dispatch("book", { slotStart: START, finishTime: FINISH, practitionerId: "42", treatment: "Checkup" }),
    ).rejects.toThrow();
    expect(dentally.createAppointment).not.toHaveBeenCalled();
  });
});

describe("D2: a retried booking is idempotent", () => {
  it("replays the first result instead of writing the same slot twice in one turn", async () => {
    const dentally = {
      ...diary([{ start: START, finish: FINISH, practitionerId: "42" }]),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [] }),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-1" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    const args = { slotStart: START, finishTime: FINISH, practitionerId: "42", treatment: "Checkup" };
    const first = await dispatch("book", args);
    const second = await dispatch("book", args);
    expect(dentally.createAppointment).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("confirms an appointment the patient already holds at that time rather than booking again", async () => {
    // The earlier write timed out on our side but landed at Dentally; the retry
    // arrives on a later message, so a fresh dispatch has no memo to fall back on.
    const dentally = {
      ...diary([]),
      getPatientAppointments: vi.fn().mockResolvedValue({
        appointments: [{ id: "appt-earlier", state: "booked", start_time: START, finish_time: FINISH }],
      }),
      createAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    const out = JSON.parse(
      await dispatch("book", { slotStart: START, finishTime: FINISH, practitionerId: "42", treatment: "Checkup" }),
    );
    expect(dentally.createAppointment).not.toHaveBeenCalled();
    expect(out).toMatchObject({ booked: true, appointmentId: "appt-earlier", alreadyBooked: true });
  });

  it("ignores a cancelled appointment at that time and books normally", async () => {
    const dentally = {
      ...diary([{ start: START, finish: FINISH, practitionerId: "42" }]),
      getPatientAppointments: vi.fn().mockResolvedValue({
        appointments: [{ id: "appt-gone", state: "cancelled", start_time: START, finish_time: FINISH }],
      }),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-new" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    const out = JSON.parse(
      await dispatch("book", { slotStart: START, finishTime: FINISH, practitionerId: "42", treatment: "Checkup" }),
    );
    expect(out).toMatchObject({ booked: true, appointmentId: "appt-new" });
  });
});

describe("D3: reschedule keeps the appointment with the right clinician", () => {
  const owned = {
    appointments: [
      {
        id: "appt-9",
        state: "booked",
        start_time: "2030-01-06T09:00:00Z",
        finish_time: "2030-01-06T09:30:00Z",
        practitioner_id: "42",
      },
    ],
  };

  it("exposes practitionerId on the tool schema", () => {
    const reschedule = AGENT_TOOLS.find((t) => t.name === "reschedule")!;
    expect(Object.keys(reschedule.input_schema.properties ?? {})).toContain("practitionerId");
  });

  it("patches the NEW slot's clinician through to Dentally", async () => {
    const dentally = {
      ...diary([]),
      getPatientAppointments: vi.fn().mockResolvedValue(owned),
      updateAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-9" } }),
      createAppointment: vi.fn(),
      cancelAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    await dispatch("reschedule", {
      appointmentId: "appt-9",
      newSlotStart: "2030-01-07T10:00:00Z",
      newFinishTime: "2030-01-07T10:30:00Z",
      practitionerId: "77",
    });
    expect(dentally.updateAppointment).toHaveBeenCalledWith("appt-9", {
      start_time: "2030-01-07T10:00:00Z",
      finish_time: "2030-01-07T10:30:00Z",
      practitioner_id: "77",
    });
  });

  it("restates the appointment's own clinician when the model supplies none", async () => {
    const dentally = {
      ...diary([]),
      getPatientAppointments: vi.fn().mockResolvedValue(owned),
      updateAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-9" } }),
      createAppointment: vi.fn(),
      cancelAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: CONTEXT });
    await dispatch("reschedule", { appointmentId: "appt-9", newSlotStart: "2030-01-07T10:00:00Z" });
    expect(dentally.updateAppointment).toHaveBeenCalledWith(
      "appt-9",
      expect.objectContaining({ practitioner_id: "42" }),
    );
  });
});

// ---------------------------------------------------------------------------
// D5: the turn reports what HAPPENED, not what the model attempted.
// ---------------------------------------------------------------------------
function toolUseMessage(id: string, name: string, input: object) {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] };
}
function textMessage(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}
// A confirmation the appointment-write gate accepts: an affirmative answering a
// read-back that named a concrete time.
const CONFIRMED_HISTORY = [
  { role: "assistant" as const, content: "Shall I book you in for Monday at 9am?" },
  { role: "user" as const, content: "yes please" },
];

describe("D5: booked reflects the tool RESULT, never the attempt", () => {
  it("reports booked when the tool confirms the appointment", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "book", { slotStart: "2030-01-06T09:00:00Z", treatment: "Checkup" }))
      .mockResolvedValueOnce(textMessage("Booked, see you Monday at 9am."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ booked: true, appointmentId: "appt-1" }));
    const r = await runAgentTurn(CONFIRMED_HISTORY, {
      anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [],
    });
    expect(r.booked).toBe(true);
  });

  it("does NOT report booked when the slot had gone", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "book", { slotStart: "2030-01-06T09:00:00Z", treatment: "Checkup" }))
      .mockResolvedValueOnce(textMessage("Sorry, that time has just gone. Would Tuesday at 10am suit?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ booked: false, error: "That time has just been taken." }));
    const r = await runAgentTurn(CONFIRMED_HISTORY, {
      anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [],
    });
    // The model ATTEMPTED a booking, so the old attempt-based flag would have said
    // booked here and staff would have skipped a patient with no appointment.
    expect(r.toolCalls.map((t) => t.name)).toEqual(["book"]);
    expect(r.booked).toBe(false);
  });

  it("does NOT report booked when the write was blocked for want of a confirmation", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "book", { slotStart: "2030-01-06T09:00:00Z", treatment: "Checkup" }))
      .mockResolvedValueOnce(textMessage("Just to confirm, shall I book Monday at 9am?"));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ booked: true, appointmentId: "appt-1" }));
    const r = await runAgentTurn([{ role: "user", content: "what have you got on monday?" }], {
      anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [],
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.booked).toBe(false);
  });

  it("does NOT report booked when the tool threw", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "book", { slotStart: "2030-01-06T09:00:00Z", treatment: "Checkup" }))
      .mockResolvedValueOnce(textMessage("Let me pass you to a colleague."));
    const dispatch = vi.fn().mockRejectedValue(new Error("Dentally 500"));
    const r = await runAgentTurn(CONFIRMED_HISTORY, {
      anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [],
    });
    expect(r.booked).toBe(false);
    expect(r.escalated).toBe(true);
  });

  it("surfaces the patient registered this turn, for the thread and the directory", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu1", "register_patient", { firstName: "Jane", lastName: "Doe" }))
      .mockResolvedValueOnce(textMessage("Thanks Jane, you are on our records now."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ registered: true, patientId: "pat-new" }));
    const r = await runAgentTurn([{ role: "user", content: "I am Jane Doe" }], {
      anthropic: { messages: { create } } as never, dispatch, systemPrompt: "sys", tools: [],
    });
    expect(r.registeredPatientId).toBe("pat-new");
    expect(r.registeredPatientName).toBe("Jane Doe");
  });
});
