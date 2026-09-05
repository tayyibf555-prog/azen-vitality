import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// WAVE 2, LANE A: THE SEVEN TOOLS THAT LET THE CO-PILOT REACH THE WAVE-1
// MODULES, TESTED WHERE THE SCENARIO BATTERY CANNOT REACH.
//
// The battery (battery.test.ts) proves the DOORS — which login reaches which
// tool, and that a refusal happens before anything is read. This file proves the
// three things that are properties of the CODE rather than of a conversation:
//
//   1. THE BRIDGE. `previsit_summary` has to obey a rule the triage module owns
//      (W1-C/2: the manager gets the count and the flag, never the patient's
//      words), and that rule is written in ROLES while this dispatch holds an
//      ACCESS. The bridge is pinned here, in both directions, so a change to
//      CLINICAL_SUMMARY_ROLES cannot quietly widen what the front desk reads.
//   2. THE WRITE. `diary_write` must go through the W1-A gate and never a client
//      of its own, must send the fields Dentally actually needs, must record the
//      session's opaque id and never an email, and must never report a refusal as
//      a booking. Every one of those is asserted against the real dispatch with
//      the gate's five doors spied.
//   3. THE REUSE. The equipment desk's safety boundary and the IT desk's security
//      refusals are CALLED, not copied. A source crawl proves the copy does not
//      exist, because a second copy of a safety rule is the copy that stops being
//      updated.
// ===========================================================================

vi.mock("server-only", () => ({}));

const searchPatients = vi.fn();
const createAppointment = vi.fn();
const updateAppointment = vi.fn();
const cancelAppointment = vi.fn();
const logCopilotAction = vi.fn();
const performMove = vi.fn();

vi.mock("@/lib/dentally/read", () => ({
  searchPatients: (...a: unknown[]) => searchPatients(...a),
  dentallyFromEnv: () => ({ listPatients: vi.fn() }),
  listPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
}));

vi.mock("@/lib/dentally/write", async (importOriginal) => ({
  // The REAL buildManualBookingPayload: the point of several assertions below is
  // that the co-pilot sends what the shared, live-calibrated derivation produces.
  ...(await importOriginal<Record<string, unknown>>()),
  isDentallyWriteEnabled: () => true,
  dentallyAgentClient: () => {
    throw new Error("diary_write must go through the write gate, never a client of its own");
  },
}));

// Only the gate's five doors are stubbed. The real DentallyWriteRefused class is
// kept, so `err instanceof DentallyWriteRefused` in tools.ts matches what these
// throw; the gate's own behaviour (mode, master switch, ledger) is tested in
// src/lib/dentally/write-gate.test.ts and not re-tested here.
vi.mock("@/lib/dentally/write-gate", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    dentallyWriteMode: () => "dry_run",
    isDentallyWriteMasterOff: async () => false,
    dentallyWrite: {
      createPatient: vi.fn(),
      createAppointment: (ctx: unknown, payload: unknown) => createAppointment(ctx, payload),
      updateAppointment: (ctx: unknown, id: unknown, payload: unknown) => updateAppointment(ctx, id, payload),
      cancelAppointment: (ctx: unknown, id: unknown) => cancelAppointment(ctx, id),
    },
  };
});

vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: (...a: unknown[]) => logCopilotAction(...a) }));

// THE DIARY'S OWN MOVE PATH (ruling W3/1). `performMove` is the guarded body of
// PATCH /api/calendar/appointment/[id] — the session, the capability, the
// calendar-writes kill switch, the write gate, the re-read, the state and
// concurrency checks, every drop check, the `diary_move` audit row and the
// patient's reschedule text. It is stubbed here because its own behaviour is
// tested in src/lib/calendar/move-service*.test.ts and in the route test; what
// THIS file proves is that the co-pilot goes through it and hands it the right
// body, rather than making the same Dentally write with none of those checks.
vi.mock("@/lib/calendar/move-service", () => ({
  performMove: (id: string, body: unknown) => performMove(id, body),
}));

import { runAgentTurn } from "@/lib/agent/run";
import { DentallyError } from "@/lib/dentally/client";
import { DentallyWriteRefused } from "@/lib/dentally/write-gate";
import { CLINICAL_SUMMARY_ROLES, canReadClinicalSummary } from "@/lib/triage/summary";
import { copilotAccessForRole } from "./scope";
import { COPILOT_ACCESS_LEVELS, TOOL_DOMAIN, type CopilotAccess } from "./clearance";
import { makeCopilotDispatch } from "./tools";
import type { Role } from "@/lib/types";
import { ALL_ROLES } from "@/lib/capabilities/defaults";

const PATIENT = {
  id: "p1",
  name: "Amina Ahmed",
  phone: "07700900123",
  email: "amina@example.com",
  siteId: "site-cc",
  active: true,
  archivedReason: null,
  dateOfBirth: "1984-04-02",
  recallDueAt: null,
  lastVisitAt: null,
  smsConsent: true,
  emailConsent: true,
};

/** The owner's dispatch, as the route builds it: the session's opaque id as actor. */
const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "full");

const BOOK = {
  action: "book",
  patient: "Amina",
  start: "2026-09-10T09:00:00Z",
  finish: "2026-09-10T09:30:00Z",
  practitionerId: "prac-1",
  confirm: true,
};

async function run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(await dispatch("diary_write", input)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  searchPatients.mockResolvedValue([PATIENT]);
  createAppointment.mockResolvedValue({ appointment: { id: "appt-9" } });
  updateAppointment.mockResolvedValue({ appointment: { id: "a1" } });
  cancelAppointment.mockResolvedValue({ appointment: { id: "a1", state: "cancelled" } });
  logCopilotAction.mockResolvedValue(undefined);
  // The diary's own answer to a move it SAVED, in the shape performMove returns:
  // a Response, because that is what the desk's route hands back.
  performMove.mockResolvedValue(
    Response.json(
      {
        ok: true,
        confirmed: true,
        moveId: "mv-1",
        notify: { queued: true, reason: null },
        appointment: { id: "a1", startTime: "2026-09-11T14:00:00Z", finishTime: "2026-09-11T14:30:00Z", practitionerId: "prac-2", practitionerName: "Dr Khan", day: "2026-09-11" },
      },
      { status: 200 },
    ),
  );
});

// ===========================================================================
describe("1. the pre-visit bridge: a rule written in ROLES, applied to an ACCESS", () => {
  it("the two viewer roles agree with the triage module's own predicate", () => {
    // tools.ts hands `projectSummary` one of exactly two concrete roles. Neither
    // is a second copy of the rule — the rule is CLINICAL_SUMMARY_ROLES — but if
    // the module's list ever moved either of them, the projection would silently
    // flip. This is the assertion that makes that loud.
    expect(canReadClinicalSummary("client_clinician")).toBe(true);
    expect(canReadClinicalSummary("client_coordinator")).toBe(false);
  });

  it("the access levels that may read a patient's words are exactly the owner's and the clinician's", () => {
    // Derived the same way tools.ts derives it — forward through the real
    // role -> access map, never inverted — and then checked against the module's
    // own predicate for EVERY role, so the two can never disagree.
    const mayRead = new Set<CopilotAccess>(CLINICAL_SUMMARY_ROLES.map((r) => copilotAccessForRole(r)));
    expect([...mayRead].sort()).toEqual(["clinician", "full"]);
    for (const role of ALL_ROLES as Role[]) {
      expect(
        mayRead.has(copilotAccessForRole(role)),
        `${role}: the access bridge and canReadClinicalSummary disagree`,
      ).toBe(canReadClinicalSummary(role));
    }
    // And the levels that may NOT: the manager, staff, and a session with no
    // co-pilot at all.
    for (const level of COPILOT_ACCESS_LEVELS) {
      if (level === "full" || level === "clinician") continue;
      expect(mayRead.has(level), `${level} may read a patient's words`).toBe(false);
    }
  });

  it("previsit_summary is filed under patients, so it inherits that domain's roles and no other", () => {
    // The narrower rule above is applied ON TOP of the domain, never instead of
    // it: a login without `patients` never reaches the tool at all.
    expect(TOOL_DOMAIN.previsit_summary).toEqual({ kind: "read", domain: "patients" });
  });
});

// ===========================================================================
describe("2. diary_write goes through the gate, and only through the gate", () => {
  it("a PREVIEW writes nothing and says whether confirming would reach Dentally", async () => {
    const out = await run({ ...BOOK, confirm: false });
    expect(out.preview).toBe(true);
    expect(out.done).toBe(false);
    expect(createAppointment).not.toHaveBeenCalled();
    expect(updateAppointment).not.toHaveBeenCalled();
    expect(cancelAppointment).not.toHaveBeenCalled();
    // The mocked mode is dry_run with the master switch on, so the honest answer
    // is "off" and the owner is told before they are asked to confirm.
    expect(out.writingBackToDentally).toBe("off");
  });

  it("a confirmed booking sends the SHARED calibrated payload, through the gate", async () => {
    const out = await run(BOOK);
    expect(out.done).toBe(true);
    expect(out.appointmentId).toBe("appt-9");
    expect(createAppointment).toHaveBeenCalledTimes(1);
    const [ctx, payload] = createAppointment.mock.calls[0];
    // THE FIELDS LIVE DENTALLY ENFORCES. A booking with no finish time or no
    // practitioner is refused by Dentally, and the payload comes from the same
    // derivation the staff booking path uses rather than being assembled here.
    expect(payload).toEqual({
      patient_id: "p1",
      start_time: "2026-09-10T09:00:00Z",
      finish_time: "2026-09-10T09:30:00Z",
      practitioner_id: "prac-1",
      reason: "Other",
      notes: "Booked via dashboard",
      booked_via_api: true,
    });
    expect(ctx.source).toBe("copilot");
    expect(ctx.clientId).toBe("vitality");
    expect(ctx.siteId).toBe("site-cc");
    expect(ctx.patientId).toBe("p1");
  });

  it("THE ACTOR IS THE SESSION'S OPAQUE ID, never an email", async () => {
    await run(BOOK);
    const [ctx] = createAppointment.mock.calls[0];
    expect(ctx.actor).toBe("user-42");
    expect(String(ctx.actor)).not.toMatch(/@/);
  });

  const MOVE = {
    action: "move",
    appointmentId: "a1",
    start: "2026-09-11T14:00:00Z",
    finish: "2026-09-11T14:30:00Z",
    practitionerId: "prac-2",
    // The appointment AS IT STANDS: the diary's `expected` block, which is what
    // makes a co-pilot move refuse rather than overwrite a change the desk made
    // while the owner was talking.
    currentStart: "2026-09-10T09:00:00Z",
    currentFinish: "2026-09-10T09:30:00Z",
    currentPractitionerId: "prac-1",
    confirm: true,
  };

  it("A MOVE GOES THROUGH THE DIARY'S OWN MOVE PATH, never a bare gate call", async () => {
    // RULING W3/1. The co-pilot used to call dentallyWrite.updateAppointment
    // directly: the same write the desk makes, with none of the checks the desk
    // makes around it (no re-read, no cancelled-row refusal, no concurrency
    // check, no clash or continuity validation, no diary_move audit row and no
    // text to the patient, who then arrives at the old hour). This asserts the
    // co-pilot now drives `performMove` — and that it does not ALSO write.
    const out = await run(MOVE);
    expect(out.done).toBe(true);
    expect(performMove).toHaveBeenCalledTimes(1);
    expect(updateAppointment).not.toHaveBeenCalled();
    const [id, body] = performMove.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe("a1");
    expect(body).toEqual({
      siteId: "site-cc",
      // Derived from the START the server validated, never from anything the
      // model said the day was: performMove refuses a day that disagrees.
      day: "2026-09-11",
      startTime: "2026-09-11T14:00:00Z",
      finishTime: "2026-09-11T14:30:00Z",
      practitionerId: "prac-2",
      expected: {
        startTime: "2026-09-10T09:00:00Z",
        finishTime: "2026-09-10T09:30:00Z",
        practitionerId: "prac-1",
      },
      // THE DESK'S OWN BEHAVIOUR, not a wider one: the diary queues the patient's
      // reschedule text whenever the time changed and nothing blocks it, and
      // every blocker is re-derived inside performMove.
      notifyPatient: true,
    });
  });

  it("a saved move reports whether the PATIENT was told, and never assumes it", async () => {
    const out = await run(MOVE);
    expect(out.patientTextQueued).toBe(true);
    expect(String(out.note)).toMatch(/text telling the patient their new time has been queued/i);

    performMove.mockResolvedValueOnce(
      Response.json({ ok: true, confirmed: true, moveId: "mv-2", notify: { queued: false, reason: "no_phone" }, appointment: { id: "a1" } }, { status: 200 }),
    );
    const quiet = await run(MOVE);
    expect(quiet.done).toBe(true);
    expect(quiet.patientTextQueued).toBe(false);
    expect(quiet.patientTextNotSentBecause).toBe("no_phone");
    expect(String(quiet.note)).toMatch(/No text has been queued for the patient/i);
  });

  it("REFUSES A MOVE WITH NO SNAPSHOT of the appointment as it stands", async () => {
    // Fail closed: without `expected` the diary cannot tell "the owner is moving
    // the appointment they were looking at" from "somebody changed it two minutes
    // ago", so nothing is attempted at all.
    for (const missing of ["currentStart", "currentFinish", "currentPractitionerId"]) {
      const input = { ...MOVE } as Record<string, unknown>;
      delete input[missing];
      const out = JSON.parse(await dispatch("diary_write", input)) as Record<string, unknown>;
      expect(out.done, missing).toBe(false);
      expect(String(out.error), missing).toMatch(/as it stands NOW/i);
      expect(performMove, missing).not.toHaveBeenCalled();
      expect(updateAppointment, missing).not.toHaveBeenCalled();
    }
  });

  it("a diary refusal is relayed as a refusal, in the diary's own words", async () => {
    // A 409 is the concurrency check, a clash or a cancelled row. None of them is
    // a move, and the co-pilot must not dress one up as one.
    performMove.mockResolvedValueOnce(
      Response.json({ ok: false, error: "This appointment changed while you were moving it. Reload the diary and try again." }, { status: 409 }),
    );
    const out = await run(MOVE);
    expect(out.done).toBe(false);
    expect(out.refused).toBe(true);
    expect(out.status).toBe(409);
    expect(String(out.message)).toMatch(/changed while you were moving it/i);
    expect(String(out.message)).toMatch(/appointment is unchanged/i);
    expect(JSON.stringify(out)).not.toMatch(/"done":true/);
    expect(logCopilotAction).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked:diary_409" }));
  });

  it("a move that could not be verified says so, and says not to retry", async () => {
    // The diary answers 200 with confirmed:false when the read-back could not
    // settle it. A second attempt is how one move becomes two.
    performMove.mockResolvedValueOnce(
      Response.json(
        { ok: false, confirmed: false, reason: "unknown", moveId: "mv-3", error: "The move may or may not have saved. Open this appointment in Dentally and check before telling the patient." },
        { status: 200 },
      ),
    );
    const out = await run(MOVE);
    expect(out.done).toBe(false);
    expect(out.reason).toBe("unknown");
    expect(String(out.message)).toMatch(/may or may not have saved/i);
    expect(String(out.message)).toMatch(/Do not retry/i);
  });

  it("a cancel names the appointment and sends no payload of its own", async () => {
    const out = await run({ action: "cancel", appointmentId: "a1", confirm: true });
    expect(out.done).toBe(true);
    expect(cancelAppointment).toHaveBeenCalledTimes(1);
    expect(cancelAppointment.mock.calls[0][1]).toBe("a1");
    // ...and it does not pretend the freed slot went anywhere.
    expect(String(out.note)).toMatch(/not offered to anybody automatically/i);
  });

  it("A GATE REFUSAL IS REPORTED AS A REFUSAL, never as a booking", async () => {
    createAppointment.mockRejectedValueOnce(
      new DentallyWriteRefused("writes_disabled", "Writing back to Dentally is switched off."),
    );
    const out = await run(BOOK);
    expect(out.done).toBe(false);
    expect(out.refused).toBe(true);
    expect(out.blockedReason).toBe("writes_disabled");
    expect(String(out.message)).toMatch(/recorded in Sync status/i);
    // The word that must never appear on a refusal.
    expect(JSON.stringify(out)).not.toMatch(/"done":true/);
    expect(logCopilotAction).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked:writes_disabled" }),
    );
  });

  it("a master-switch refusal names the switch, and still changes nothing", async () => {
    cancelAppointment.mockRejectedValueOnce(
      new DentallyWriteRefused("master_off", "Refusing appointment.cancel: Dentally write-back is switched off in System controls."),
    );
    const out = await run({ action: "cancel", appointmentId: "a1", confirm: true });
    expect(out.blockedReason).toBe("master_off");
    expect(String(out.message)).toMatch(/System controls/i);
  });

  it("a Dentally 422 is reported honestly and never retried", async () => {
    createAppointment.mockRejectedValueOnce(new DentallyError(422, "unprocessable"));
    const out = await run(BOOK);
    expect(out.done).toBe(false);
    expect(out.reason).toBe("dentally_error");
    expect(out.status).toBe(422);
    expect(createAppointment).toHaveBeenCalledTimes(1);
  });

  it("an unclassifiable error says it cannot tell whether it landed", async () => {
    // The one honest answer to a timeout: the write MAY have landed, so a second
    // attempt is how one booking becomes two. Asserted on the CANCEL path, which
    // is still a direct gate call; the move's own version of this is the
    // "could not be verified" case above, which the diary reports for itself.
    cancelAppointment.mockRejectedValueOnce(new Error("socket hang up"));
    const out = await run({ action: "cancel", appointmentId: "a1", confirm: true });
    expect(out.done).toBe(false);
    expect(String(out.message)).toMatch(/cannot tell you whether it landed/i);
    expect(String(out.message)).toMatch(/do not retry/i);
    expect(cancelAppointment).toHaveBeenCalledTimes(1);
  });

  it("refuses a time with no timezone, before anything is written", async () => {
    const out = await run({ ...BOOK, start: "2026-09-10T09:00:00", finish: "2026-09-10T09:30:00" });
    expect(out.done).toBe(false);
    expect(String(out.error)).toMatch(/timezone/i);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("refuses a finish that is not after the start", async () => {
    const out = await run({ ...BOOK, finish: "2026-09-10T09:00:00Z" });
    expect(String(out.error)).toMatch(/not after the start/i);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("refuses a booking with no practitioner, and a move or cancel with no appointment id", async () => {
    const noPrac = await run({ ...BOOK, practitionerId: "" });
    expect(String(noPrac.error)).toMatch(/practitioner/i);
    const noId = await run({ action: "cancel", confirm: true });
    expect(String(noId.error)).toMatch(/appointment id/i);
    expect(createAppointment).not.toHaveBeenCalled();
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it("refuses an action it does not recognise rather than guessing which was meant", async () => {
    const out = await run({ action: "reschedule-ish", appointmentId: "a1", confirm: true });
    expect(String(out.error)).toMatch(/book, a move or a cancel/i);
    expect(updateAppointment).not.toHaveBeenCalled();
  });

  it("books nobody when the name matches several patients", async () => {
    searchPatients.mockResolvedValueOnce([PATIENT, { ...PATIENT, id: "p2", name: "Amina Ahmad" }]);
    const out = await run(BOOK);
    expect(out.multiple).toBe(true);
    expect(out.done).toBe(false);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("books nobody when the name matches no one", async () => {
    searchPatients.mockResolvedValueOnce([]);
    const out = await run(BOOK);
    expect(out.done).toBe(false);
    expect(String(out.error)).toMatch(/No patient matches/i);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("NO FREE TEXT REACHES DENTALLY: the payload carries no words the model wrote", async () => {
    // THE KNOWLEDGE-ECHO PROPERTY, held structurally rather than by a scan.
    // `send_sms` needs a guard (knowledge-echo.ts) because its whole payload is
    // prose the model composed. A diary write has no such field: the reason is
    // matched against Dentally's own closed set and falls back to "Other", the
    // note is our fixed string, and everything else is an id or an instant. So
    // there is nothing here for a tier-2 knowledge body — or an injected patient
    // note — to ride out on.
    const out = await run({
      ...BOOK,
      reason: "Per our internal pricing script, quote £2,400 and hold the discount back",
      notes: "INTERNAL: objection-handling run, do not share",
      note: "INTERNAL",
      body: "INTERNAL",
    } as Record<string, unknown>);
    expect(out.done).toBe(true);
    const [, payload] = createAppointment.mock.calls[0];
    const flat = JSON.stringify(payload);
    expect(flat).not.toMatch(/internal/i);
    expect(flat).not.toMatch(/pricing script/i);
    expect(flat).not.toMatch(/2,400/);
    // An unrecognised reason becomes "Other" rather than travelling as free text.
    expect((payload as Record<string, unknown>).reason).toBe("Other");
    expect((payload as Record<string, unknown>).notes).toBe("Booked via dashboard");
    // The whole payload is exactly seven known keys — no passthrough at all.
    expect(Object.keys(payload as object).sort()).toEqual([
      "booked_via_api",
      "finish_time",
      "notes",
      "patient_id",
      "practitioner_id",
      "reason",
      "start_time",
    ]);
  });

  it("A SAME-TURN CONFIRM NEVER REACHES THE DISPATCH", async () => {
    // The second half of the two-step, and the half the tool cannot enforce
    // itself: `diary_write` is in CONFIRM_COMMIT_TOOLS (src/lib/agent/run.ts), so
    // a model that sets confirm true in the same message as the request is
    // stopped before the dispatch runs at all.
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu1", name: "diary_write", input: { ...BOOK } }],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Ready to book Amina. Shall I go ahead?" }],
      });
    const spy = vi.fn().mockResolvedValue(JSON.stringify({ done: true }));
    const r = await runAgentTurn([{ role: "user", content: "book Amina in on the 10th at nine, yes do it" }], {
      anthropic: { messages: { create } } as never,
      dispatch: spy,
      systemPrompt: "sys",
      tools: [],
    });
    expect(spy).not.toHaveBeenCalled();
    expect(r.replyText).toMatch(/shall I go ahead/i);
  });

  it("a confirm that answers a prior read-back DOES reach the dispatch", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu1", name: "diary_write", input: { ...BOOK } }],
      })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Booked." }] });
    const spy = vi.fn().mockResolvedValue(JSON.stringify({ done: true }));
    await runAgentTurn(
      [
        { role: "user", content: "book Amina in on the 10th at nine" },
        { role: "assistant", content: "Ready to book Amina Ahmed with prac-1 on 10 September, 9:00 to 9:30. Shall I go ahead?" },
        { role: "user", content: "yes please" },
      ],
      { anthropic: { messages: { create } } as never, dispatch: spy, systemPrompt: "sys", tools: [] },
    );
    expect(spy).toHaveBeenCalledWith("diary_write", expect.objectContaining({ confirm: true }));
  });
});

// ===========================================================================
describe("3. the modules' own rules are CALLED, not copied", () => {
  const source = readFileSync(new URL("./tools.ts", import.meta.url), "utf8");

  it("the equipment gate and its refusals are imported from the equipment module", () => {
    expect(source).toMatch(/import \{[^}]*gateEquipmentQuestion[^}]*\} from "@\/lib\/equipment\/topic-gate"/);
    expect(source).toMatch(/gateEquipmentQuestion\(\{/);
    expect(source).toMatch(/EQUIPMENT_REFUSALS\.judgement/);
    // AND THE COPY DOES NOT EXIST. The refusal sentences live in exactly one
    // file; if one of them appeared here it would be the version that stops
    // being updated when the boundary moves.
    expect(source).not.toMatch(/defeats a safety interlock or guard/);
    expect(source).not.toMatch(/I can't tell you whether it is safe to keep using it/);
    // Nor are the gate's rules restated: no interlock/bypass regex anywhere here.
    expect(source).not.toMatch(/interlock\|/);
  });

  it("the IT desk gate is imported, and no credential rule is restated here", () => {
    expect(source).toMatch(/import \{[^}]*gateItDeskQuestion[^}]*\} from "@\/lib\/itdesk\/topic-gate"/);
    expect(source).toMatch(/gateItDeskQuestion\(\{/);
    expect(source).not.toMatch(/I never handle passwords, PINs or access codes/);
    expect(source).not.toMatch(/passcode\|pass \?phrase/);
  });

  it("both desks are asked for their own kill switch before they answer", () => {
    // A domain grant is permission to TRY, never permission to bypass. Both slugs
    // are defaultEnabled:false, so a missing row and an unreadable table both
    // resolve to off.
    expect(source).toMatch(/isSystemEnabled\(clientId, EQUIPMENT_SLUG\)/);
    expect(source).toMatch(/isSystemEnabled\(clientId, IT_DESK_SLUG\)/);
  });

  it("the pre-visit projection and the sync surface come from their own modules", () => {
    // The RESOLVED entry point, not the pure projection: it is what fetches the
    // practice's own question labels, so a tool that reached past it would render
    // an owner-authored question under its raw key.
    expect(source).toMatch(/import \{ previsitSummaryFor \} from "@\/lib\/triage\/summary-read"/);
    expect(source).toMatch(/previsitSummaryFor\(\{/);
    expect(source).toMatch(/assembleSyncStatus\(clientId, limit\)/);
    // The roster is the ONLY list of every agent; agent_status does not keep a
    // second one.
    expect(source).toMatch(/import \{ AGENTS \} from "@\/lib\/agent-wiring\/roster"/);
  });

  it("the diary write reaches Dentally ONLY through the gate façade, and the MOVE through the diary", () => {
    // The write-gate source crawl (write-gate-sites.test.ts) enforces this across
    // the whole tree; this is the same claim stated where the tool lives, so a
    // reviewer reading this file sees it.
    for (const method of ["createAppointment", "cancelAppointment"]) {
      expect(source).toMatch(new RegExp(`dentallyWrite\\.${method}\\(`));
    }
    // AND THE MOVE IS NOT ONE OF THEM ANY MORE (ruling W3/1). It goes through the
    // diary's own guarded path, which makes that write itself — so a second,
    // unguarded `updateAppointment` here would be the defect coming back.
    expect(source).toMatch(/import \{ performMove \} from "@\/lib\/calendar\/move-service"/);
    expect(source).toMatch(/await performMove\(appointmentId, \{/);
    expect(source).not.toMatch(/dentallyWrite\.updateAppointment\(/);
    // Comment-stripped, the same way write-gate-sites.test.ts strips them: three
    // paragraphs in this file DISCUSS the client the create_patient tool used to
    // build, and counting prose as a call would drown the signal.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(code).not.toMatch(/dentallyAgentClient\s*\(/);
  });
});
