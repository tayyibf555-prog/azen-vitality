// ===========================================================================
// W3/16 — A PATIENT'S TEXT IS A PRACTICE ACTION, AND IT IS RECORDED.
//
// "A patient SMS cancellation while write-back is off records a
// blocked/writes_disabled ledger row like the desk cancel (W1-A/1 record →
// refuse). The W1-E early-return trade was granted to copilot create_patient
// ONLY."
//
// The 24/7 booking agent is the OTHER patient-SMS door (src/lib/noshow/inbound.ts
// is the first, and already does this). Its four write tools refuse before they
// touch Dentally, which is right and stays; what changed is that the attempt is
// now filed through the shared gate first, so the owner's "what we tried to send
// to Dentally while write-back was off" screen shows the agent's cancellations
// beside the receptionist's rather than silently omitting them.
//
// These drive the REAL dispatch. Only three seams are faked: the ledger writer
// (so a row can be read back), the system toggles (so the verdict is the
// deployment's arming rather than a toggle table this environment has no access
// to), and the write-arming environment. The GATE ITSELF IS REAL — its policy is
// what decides the blocked reason, and a test that stubbed it would prove
// nothing about the row the practice actually gets.
// ===========================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  /** DENTALLY_WRITE_ENABLED, in effect. Production today is `false`. */
  writeEnv: false,
  /** Whether the deployment's Dentally base URL is the real practice book. */
  targetLive: true,
  recorded: [] as Array<Record<string, unknown>>,
  recorderThrows: false,
}));

vi.mock("@/lib/dentally/sync-ledger", () => ({
  recordWriteIntent: async (row: Record<string, unknown>) => {
    if (h.recorderThrows) throw new Error("dentally_write_intent is unreachable");
    h.recorded.push(row);
    return "intent-1";
  },
  sanitiseWriteError: (err: unknown) => String(err),
}));

vi.mock("@/lib/dentally/write", () => ({
  isDentallyWriteEnabled: () => h.writeEnv,
  targetsRealDentally: () => h.targetLive,
  // Booby-trapped: every path under test refuses BEFORE anything is performed,
  // so the gate resolving its own client would mean a write was about to happen.
  dentallyAgentClient: () => {
    throw new Error("the gate built its own Dentally client on a path that must never perform");
  },
}));

// The owner's switches are on; the deployment's arming is what is being tested.
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => true,
  isSystemExplicitlyDisabled: async () => false,
}));

import { makeDispatch, writeDisabledResult } from "./tools";

const SITE = "site-cc"; // N15 Vitality Dental → client "vitality"
const CLIENT = "vitality";
const SITE_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";
const PATIENT_ID = "pat-010";
const OWNED_APPOINTMENT = "appt-own";
const SOMEONE_ELSES = "appt-not-theirs";
const START = new Date(Date.now() + 3 * 86_400_000).toISOString();
const FINISH = new Date(Date.parse(START) + 30 * 60_000).toISOString();

const KNOWN_CONTEXT = {
  patientId: PATIENT_ID,
  siteId: SITE,
  patientName: "Harold",
  treatment: "Invisalign",
  fundingType: "private" as const,
};

/** An unrecognised number: the conversation key is `lead:<their mobile>`. */
const LEAD_CONTEXT = {
  ...KNOWN_CONTEXT,
  patientId: "lead:+447403097379",
  phone: "+447403097379",
  isKnownPatient: false,
};

/** A client that would happily write, so a refusal is the code's doing. */
function writableClient() {
  return {
    listPractitioners: vi.fn().mockResolvedValue({
      practitioners: [{ id: "42", active: true, site_id: SITE_UUID }],
    }),
    getAvailability: vi.fn().mockResolvedValue({
      availability: [{ start_time: START, finish_time: FINISH, practitioner_id: "42" }],
    }),
    getPatientAppointments: vi.fn().mockResolvedValue({
      appointments: [
        {
          id: OWNED_APPOINTMENT,
          start_time: START,
          finish_time: FINISH,
          practitioner_id: "42",
          state: "active",
        },
      ],
    }),
    createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-new" } }),
    updateAppointment: vi.fn().mockResolvedValue({ appointment: { id: OWNED_APPOINTMENT } }),
    cancelAppointment: vi.fn().mockResolvedValue({ appointment: { id: OWNED_APPOINTMENT, state: "cancelled" } }),
    createPatient: vi.fn().mockResolvedValue({ patient: { id: "pat-new" } }),
  };
}

const REGISTRATION = { firstName: "John", lastName: "Smith", title: "Mr", dateOfBirth: "1985-04-09" };

let baseUrl: string | undefined;
let paymentPlan: string | undefined;

beforeEach(() => {
  h.writeEnv = false;
  h.targetLive = true;
  h.recorded = [];
  h.recorderThrows = false;
  baseUrl = process.env.DENTALLY_BASE_URL;
  paymentPlan = process.env.DENTALLY_DEFAULT_PAYMENT_PLAN_ID;
  process.env.DENTALLY_BASE_URL = "https://api.dentally.co";
  delete process.env.DENTALLY_DEFAULT_PAYMENT_PLAN_ID;
});

afterEach(() => {
  if (baseUrl === undefined) delete process.env.DENTALLY_BASE_URL;
  else process.env.DENTALLY_BASE_URL = baseUrl;
  if (paymentPlan === undefined) delete process.env.DENTALLY_DEFAULT_PAYMENT_PLAN_ID;
  else process.env.DENTALLY_DEFAULT_PAYMENT_PLAN_ID = paymentPlan;
});

describe("W3/16: the booking agent records the write it would have made, then refuses", () => {
  it("a patient's SMS cancellation files one blocked/writes_disabled intent", async () => {
    const dentally = writableClient();
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CONTEXT, writesEnabled: false });

    const out = await dispatch("cancel", { appointmentId: OWNED_APPOINTMENT });

    // The words the model reads are byte-for-byte what they always were.
    expect(out).toBe(writeDisabledResult("cancel"));
    expect(dentally.cancelAppointment, "a refusal reached Dentally").not.toHaveBeenCalled();

    expect(h.recorded, "the patient's cancellation left no trace").toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      kind: "appointment.cancel",
      status: "blocked",
      blockedReason: "writes_disabled",
      source: "booking-agent",
      moduleSlug: "booking-agent",
      clientId: CLIENT,
      siteId: SITE,
      dentallyAppointmentId: OWNED_APPOINTMENT,
      dentallyPatientId: PATIENT_ID,
      // An agent slug, never a person and never an address (W1-A/2).
      actor: "agent:booking-agent",
      target: "api.dentally.co",
    });
  });

  it("a patient's SMS reschedule files a blocked appointment.update carrying the time it wanted", async () => {
    const dentally = writableClient();
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CONTEXT, writesEnabled: false });

    const out = await dispatch("reschedule", {
      appointmentId: OWNED_APPOINTMENT,
      newSlotStart: START,
      newFinishTime: FINISH,
    });

    expect(out).toBe(writeDisabledResult("reschedule"));
    expect(dentally.updateAppointment).not.toHaveBeenCalled();
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      kind: "appointment.update",
      status: "blocked",
      blockedReason: "writes_disabled",
      dentallyAppointmentId: OWNED_APPOINTMENT,
    });
    expect((h.recorded[0].payloadSummary as { values: Record<string, unknown> }).values.start_time).toBe(START);
  });

  it("a booking files a blocked appointment.create naming the patient, the time and the reason", async () => {
    const dentally = writableClient();
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CONTEXT, writesEnabled: false });

    const out = await dispatch("book", {
      slotStart: START,
      finishTime: FINISH,
      practitionerId: "42",
      treatment: "Hygiene visit",
    });

    expect(out).toBe(writeDisabledResult("book"));
    expect(dentally.createAppointment).not.toHaveBeenCalled();
    // Still refused BEFORE the availability read: none of that work can matter.
    expect(dentally.getAvailability, "a refused booking still spent a Dentally read").not.toHaveBeenCalled();

    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      kind: "appointment.create",
      status: "blocked",
      blockedReason: "writes_disabled",
      dentallyPatientId: PATIENT_ID,
    });
    const summary = h.recorded[0].payloadSummary as { values: Record<string, unknown>; fields: string[] };
    expect(summary.values).toMatchObject({
      patient_id: PATIENT_ID,
      start_time: START,
      // Our own catalogue value, not the patient's words.
      reason: "Scale & Polish",
      booked_via_api: true,
    });
    expect(summary.fields).toEqual(["booked_via_api", "patient_id", "reason", "start_time"]);
  });

  it("a conversational registration files a blocked patient.create", async () => {
    const dentally = writableClient();
    const dispatch = makeDispatch({ dentally: dentally as never, context: LEAD_CONTEXT, writesEnabled: false });

    const out = await dispatch("register_patient", REGISTRATION);

    expect(out).toBe(writeDisabledResult("register_patient"));
    expect(dentally.createPatient).not.toHaveBeenCalled();
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      kind: "patient.create",
      status: "blocked",
      blockedReason: "writes_disabled",
      source: "booking-agent",
    });
  });

  it("the four tools are the four the registry says this source makes", async () => {
    // Every kind DENTALLY_WRITE_SOURCES declares for `booking-agent` is reachable
    // while writes are off, so the Sync Status screen's "Comes from: Booking
    // agent" line cannot name a surface that never produces a row.
    const dispatch = makeDispatch({
      dentally: writableClient() as never,
      context: KNOWN_CONTEXT,
      writesEnabled: false,
    });
    await dispatch("book", { slotStart: START, finishTime: FINISH, practitionerId: "42", treatment: "Checkup" });
    await dispatch("reschedule", { appointmentId: OWNED_APPOINTMENT, newSlotStart: START, newFinishTime: FINISH });
    await dispatch("cancel", { appointmentId: OWNED_APPOINTMENT });
    await dispatch("register_patient", REGISTRATION);

    expect(h.recorded.map((r) => r.kind).sort()).toEqual([
      "appointment.cancel",
      "appointment.create",
      "appointment.update",
      "patient.create",
    ]);
    expect(h.recorded.every((r) => r.status === "blocked" && r.blockedReason === "writes_disabled")).toBe(true);
  });
});

describe("what the ledger must NEVER be made to hold", () => {
  it("an appointment that is not on this patient's record is never filed", async () => {
    // The appointment id is supplied by a language model reading an inbound text.
    // Recording before the ownership check would let a crafted message write any
    // id it liked into the practice's ledger.
    const dentally = writableClient();
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CONTEXT, writesEnabled: false });

    const cancelled = await dispatch("cancel", { appointmentId: SOMEONE_ELSES });
    const moved = await dispatch("reschedule", { appointmentId: SOMEONE_ELSES, newSlotStart: START });

    // The patient is told the same thing either way: this is a ledger rule.
    expect(cancelled).toBe(writeDisabledResult("cancel"));
    expect(moved).toBe(writeDisabledResult("reschedule"));
    expect(h.recorded, "an id the patient does not own reached the ledger").toEqual([]);
  });

  it("a lead's mobile number is never filed as a Dentally patient id", async () => {
    // `lead:+4477...` is the conversation key, not a Dentally record, and the
    // sync ledger holds no personal data.
    const dispatch = makeDispatch({
      dentally: writableClient() as never,
      context: LEAD_CONTEXT,
      writesEnabled: false,
    });
    await dispatch("register_patient", REGISTRATION);

    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].dentallyPatientId ?? null).toBeNull();
    expect(JSON.stringify(h.recorded)).not.toContain("447403097379");
  });

  it("a lead's booking files nothing at all: it is refused for a second reason regardless", async () => {
    const dispatch = makeDispatch({
      dentally: writableClient() as never,
      context: LEAD_CONTEXT,
      writesEnabled: false,
    });
    await dispatch("book", { slotStart: START, finishTime: FINISH, practitionerId: "42", treatment: "Checkup" });

    expect(h.recorded, "a write the platform would never make was filed as one").toEqual([]);
  });

  it("an ARMED registration does not file the lead's number either", async () => {
    // THE SAME RULE ON THE PATH THAT REALLY WRITES, and this is where the leak
    // was: register_patient hands the gate a context with no patient id of its
    // own, which fell back to `context.patientId` — the conversation key, i.e.
    // the caller's mobile — and it landed in dentally_patient_id on every
    // conversational registration the agent ever completed.
    //
    // Armed, with a payment plan configured, so the write REALLY HAPPENS and the
    // row is a `dry_run` performed against the injected client rather than a
    // refusal. Anything less would pass without the write ever being attempted.
    h.writeEnv = true;
    h.targetLive = false; // performed, but not against the real practice book
    process.env.DENTALLY_DEFAULT_PAYMENT_PLAN_ID = "47752";
    const dentally = writableClient();
    const dispatch = makeDispatch({ dentally: dentally as never, context: LEAD_CONTEXT, writesEnabled: true });

    const out = await dispatch("register_patient", { ...REGISTRATION, email: "j@example.com" });

    expect(JSON.parse(out), out).toMatchObject({ registered: true, patientId: "pat-new" });
    expect(dentally.createPatient, "the registration never reached Dentally").toHaveBeenCalledTimes(1);
    expect(h.recorded, "the completed registration filed no ledger row").toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ kind: "patient.create", status: "dry_run" });
    expect(h.recorded[0].dentallyPatientId ?? null).toBeNull();
    expect(JSON.stringify(h.recorded)).not.toContain("447403097379");
  });
});

describe("recording may never change what the patient is told", () => {
  it("an unreachable ledger still returns the refusal, and never throws at Twilio", async () => {
    h.recorderThrows = true;
    const dispatch = makeDispatch({
      dentally: writableClient() as never,
      context: KNOWN_CONTEXT,
      writesEnabled: false,
    });

    await expect(dispatch("cancel", { appointmentId: OWNED_APPOINTMENT })).resolves.toBe(
      writeDisabledResult("cancel"),
    );
  });

  it("a Dentally read failure during the ownership check refuses cleanly and files nothing", async () => {
    const dentally = writableClient();
    dentally.getPatientAppointments.mockRejectedValue(new Error("Dentally 500"));
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CONTEXT, writesEnabled: false });

    await expect(dispatch("cancel", { appointmentId: OWNED_APPOINTMENT })).resolves.toBe(
      writeDisabledResult("cancel"),
    );
    expect(h.recorded).toEqual([]);
  });

  it("a deployment pointed at the local mock files nothing, and still performs nothing", async () => {
    // The gate would have ALLOWED this write (nothing can reach the real book), so
    // there is no refusal and so no row. The agent's own flag still means the
    // Dentally client is not touched — the pre-existing safety property.
    h.targetLive = false;
    process.env.DENTALLY_BASE_URL = "http://localhost:3002";
    const dentally = writableClient();
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CONTEXT, writesEnabled: false });

    const out = await dispatch("cancel", { appointmentId: OWNED_APPOINTMENT });

    expect(out).toBe(writeDisabledResult("cancel"));
    expect(dentally.cancelAppointment).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([]);
  });
});
