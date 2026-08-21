// Recall-aware booking replies: the whole walk, end to end, on the mock.
//
// recall text -> "yes please" -> the RIGHT appointment type offered -> read-back
// -> "yes that works" -> booked.
//
// This is the test that proves the feature does the thing it was built for, and
// the two tests after it prove it did not buy that by loosening anything: the
// confirmation gate still refuses a book with no read-back behind it, and the
// same walk with NO context resolved reaches the model with the old prompt.
//
// The model is scripted rather than called: what is under test is the wiring
// (which prompt, which treatment, which tool result, which write), not Claude.
import { describe, it, expect, vi } from "vitest";
import { AGENT_TOOLS, makeDispatch, reasonForTreatment } from "./tools";
import { runAgentTurn } from "./run";
import { buildSystemPrompt } from "./prompt";
import { chooseReplyContext } from "./reply-context";
import type { AgentContext } from "./types";

const SITE_UUID = "3286d822-68c5-48ff-b1a2-065780dfcd15";
const SITE = "site-cc";
const PATIENT = "pat-4021";

// Live availability only ever returns future slots, so the fixture sits ahead of
// the real clock, exactly as the sibling booking tests do.
const START = new Date(Date.now() + 3 * 86_400_000).toISOString();
const FINISH = new Date(Date.parse(START) + 30 * 60_000).toISOString();
const READBACK = `I have ${START.slice(11, 16)} on that day with our hygienist. Does that work for you?`;

/** A hygienist recall we texted yesterday, correlated to THIS patient and site. */
function recallReplyContext() {
  return chooseReplyContext({
    candidates: [
      {
        module: "recall",
        reference: `${SITE}:${PATIENT}:hygienist`,
        siteId: SITE,
        patientId: PATIENT,
        sentAt: new Date(Date.now() - 86_400_000).toISOString(),
        recallType: "hygienist",
      },
    ],
    conversationSiteId: SITE,
    conversationPatientId: PATIENT,
    now: Date.now(),
  });
}

function contextWith(replyContext: AgentContext["replyContext"]): AgentContext {
  return {
    patientId: PATIENT,
    siteId: SITE,
    channel: "sms",
    patientName: "Aisha Khan",
    treatment: null,
    fundingType: null,
    isKnownPatient: true,
    replyContext,
  };
}

function dentallyMock() {
  return {
    listPractitioners: vi.fn().mockResolvedValue({
      practitioners: [{ id: "42", active: true, site_id: SITE_UUID }],
    }),
    getAvailability: vi.fn().mockResolvedValue({
      availability: [{ start_time: START, finish_time: FINISH, practitioner_id: "42" }],
    }),
    getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [] }),
    createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-hygiene-1" } }),
  };
}

/** A scripted Claude: each entry is one round's response. */
function scriptedModel(rounds: unknown[]) {
  const create = vi.fn();
  for (const r of rounds) create.mockResolvedValueOnce(r);
  return { anthropic: { messages: { create } } as never, create };
}

function toolUse(name: string, input: Record<string, unknown>) {
  return {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: `tu-${name}`, name, input }],
  };
}

function says(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

describe("THE WALK: a hygienist recall text, answered 'yes please', ends in the right appointment", () => {
  it("offers the hygiene appointment, reads it back, and books it on the confirmation", async () => {
    const replyContext = recallReplyContext();
    // 1. The correlation resolved the RIGHT thing off the recall we sent.
    expect(replyContext).toMatchObject({
      module: "recall",
      bookingTreatment: "Hygiene visit",
      invitedFor: "their hygiene appointment",
    });

    const context = contextWith(replyContext ?? undefined);
    const systemPrompt = buildSystemPrompt(context);
    // 2. The agent opens the turn already knowing what we sent.
    expect(systemPrompt).toContain("WHAT WE LAST SENT THEM:");
    expect(systemPrompt).toContain('call find_slots with the treatment "Hygiene visit"');

    // ---- TURN ONE: "yes please" ------------------------------------------
    const dentally = dentallyMock();
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const turnOne = scriptedModel([
      toolUse("find_slots", { treatment: "Hygiene visit" }),
      says(READBACK),
    ]);
    const one = await runAgentTurn([{ role: "user", content: "Yes please" }], {
      anthropic: turnOne.anthropic,
      dispatch,
      systemPrompt,
      tools: AGENT_TOOLS,
    });

    // 3. It went straight to availability for the RIGHT appointment type.
    expect(one.toolCalls).toEqual([
      { name: "find_slots", input: { treatment: "Hygiene visit" } },
    ]);
    // ...and asked Dentally for a hygiene visit's own length, not a default block.
    expect(dentally.getAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 30 }),
    );
    // 4. Nothing was written on the "yes please": it read the slot back instead.
    expect(dentally.createAppointment).not.toHaveBeenCalled();
    expect(one.booked).toBe(false);
    expect(one.escalated).toBe(false);
    expect(one.replyText).toBe(READBACK);

    // ---- TURN TWO: "yes that works" --------------------------------------
    const turnTwo = scriptedModel([
      toolUse("book", {
        slotStart: START,
        finishTime: FINISH,
        practitionerId: "42",
        treatment: "Hygiene visit",
      }),
      says("Lovely, you are booked in. See you then."),
    ]);
    const two = await runAgentTurn(
      [
        { role: "user", content: "Yes please" },
        { role: "assistant", content: READBACK },
        { role: "user", content: "Yes that works" },
      ],
      { anthropic: turnTwo.anthropic, dispatch, systemPrompt, tools: AGENT_TOOLS },
    );

    // 5. BOOKED, into the hygienist's diary, under the right Dentally reason.
    expect(two.booked).toBe(true);
    expect(dentally.createAppointment).toHaveBeenCalledTimes(1);
    expect(dentally.createAppointment).toHaveBeenCalledWith(
      expect.objectContaining({
        patient_id: PATIENT,
        start_time: START,
        finish_time: FINISH,
        practitioner_id: "42",
        reason: "Scale & Polish",
      }),
    );
    expect(two.replyText).toContain("booked in");
  });
});

describe("the confirmation gate is untouched by the priming", () => {
  it("still REFUSES a book when the 'yes' answers nothing that was read back", async () => {
    // The exact conversation the feature makes more likely: a bare "yes please"
    // to a recall text, and a model that tries to skip straight to the write. The
    // deterministic gate in run.ts must still refuse it, primed or not.
    const context = contextWith(recallReplyContext() ?? undefined);
    const dentally = dentallyMock();
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const model = scriptedModel([
      toolUse("book", {
        slotStart: START,
        finishTime: FINISH,
        practitionerId: "42",
        treatment: "Hygiene visit",
      }),
      says("Sorry, let me check what is free first."),
    ]);
    const out = await runAgentTurn([{ role: "user", content: "Yes please" }], {
      anthropic: model.anthropic,
      dispatch,
      systemPrompt: buildSystemPrompt(context),
      tools: AGENT_TOOLS,
    });

    expect(dentally.createAppointment).not.toHaveBeenCalled();
    expect(out.booked).toBe(false);
    // The model was handed a refusal telling it to read the slot back first.
    const secondCall = model.create.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(JSON.stringify(secondCall.messages)).toContain("Not confirmed.");
  });

  it("refuses even when the patient says yes to a read-back with no time in it", async () => {
    const context = contextWith(recallReplyContext() ?? undefined);
    const dentally = dentallyMock();
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const model = scriptedModel([
      toolUse("book", { slotStart: START, finishTime: FINISH, practitionerId: "42", treatment: "Hygiene visit" }),
      says("Let me confirm the time with you first."),
    ]);
    await runAgentTurn(
      [
        { role: "user", content: "Yes please" },
        { role: "assistant", content: "Great, I can get that sorted for you." },
        { role: "user", content: "Yes" },
      ],
      { anthropic: model.anthropic, dispatch, systemPrompt: buildSystemPrompt(context), tools: AGENT_TOOLS },
    );
    expect(dentally.createAppointment).not.toHaveBeenCalled();
  });
});

describe("with nothing resolved, the same walk is the agent we already had", () => {
  it("runs on the pre-feature prompt and never mentions an invite", async () => {
    const context = contextWith(undefined);
    const systemPrompt = buildSystemPrompt(context);
    expect(systemPrompt).not.toContain("WHAT WE LAST SENT THEM");

    const dentally = dentallyMock();
    const dispatch = makeDispatch({ dentally: dentally as never, context, writesEnabled: true });
    const model = scriptedModel([says("Hi Aisha, what can I help you with?")]);
    const out = await runAgentTurn([{ role: "user", content: "Yes please" }], {
      anthropic: model.anthropic,
      dispatch,
      systemPrompt,
      tools: AGENT_TOOLS,
    });
    expect(out.replyText).toBe("Hi Aisha, what can I help you with?");
    // The prompt the model was handed is the one with no priming in it.
    const firstCall = model.create.mock.calls[0][0] as { system: Array<{ text: string }> };
    expect(firstCall.system[0].text).toBe(systemPrompt);
    expect(firstCall.system[0].text).not.toContain("Hygiene visit");
  });
});

describe("the Dentally reason our own catalogue names map to", () => {
  // Found by the walk above. "Hygiene visit" is the canonical name in
  // src/lib/treatments/catalog.ts, so it is the exact string the agent is told to
  // pass to find_slots and then to book, and it used to write into the practice's
  // real diary as reason "Other" because the pattern ended "hygien" with a word
  // boundary. Nothing tested the mapping, so every hygiene appointment the agent
  // has written went in mislabelled.
  it("maps every catalogue name the agent can be primed with", () => {
    expect(reasonForTreatment("Hygiene visit")).toBe("Scale & Polish");
    expect(reasonForTreatment("Checkup")).toBe("Exam");
    expect(reasonForTreatment("Invisalign")).toBe("Other");
    expect(reasonForTreatment("Dental implant")).toBe("Other");
  });

  it("maps the words a patient or a receptionist actually types", () => {
    expect(reasonForTreatment("hygienist")).toBe("Scale & Polish");
    expect(reasonForTreatment("scale and polish")).toBe("Scale & Polish");
    expect(reasonForTreatment("a cleaning")).toBe("Scale & Polish");
    expect(reasonForTreatment("examination")).toBe("Exam");
    expect(reasonForTreatment("check up")).toBe("Exam");
    expect(reasonForTreatment("check-ups")).toBe("Exam");
  });

  it("labels a combined visit as both, rather than dropping half of it", () => {
    expect(reasonForTreatment("Check-up and hygiene clean")).toBe("Exam + Scale & Polish");
  });

  it("an emergency outranks a routine word in the same string", () => {
    expect(reasonForTreatment("emergency check-up, in a lot of pain")).toBe("Emergency");
    expect(reasonForTreatment("broken tooth")).toBe("Emergency");
  });

  it("does not let a loose stem book the wrong thing", () => {
    // A "\\w*" suffix would have made these an Exam. This string lands on a real
    // clinical record, so an unrecognised treatment stays "Other".
    expect(reasonForTreatment("example treatment")).toBe("Other");
    expect(reasonForTreatment("")).toBe("Other");
    expect(reasonForTreatment("veneers")).toBe("Other");
  });
});
