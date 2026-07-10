// AREA 6: WhatsApp / SMS conversational agent guardrails.
//
// The agent (src/lib/agent/*) is a real two-way Claude tool-calling loop, wired
// from the Twilio inbound webhook. These tests deep-test the GUARDABLE parts:
//   1. System-prompt constraints (no clinical advice, no unverified prices,
//      no NHS/private funding jargon to patients) actually exist in the prompt.
//   2. Tool safety: the reschedule/cancel/book dispatch and the IDOR surface.
//   3. Failure handling: the runAgentTurn loop under LLM error, empty/oversized
//      input, and a runaway tool loop degrades to a safe fallback, never a crash.
//   4. Cost: documents the ABSENCE of a per-window budget guard on the loop.
//
// Where a constraint is only enforced by the LLM at runtime (not by code) the
// test asserts the prompt instruction and the comment flags it as prompt-only.

import { describe, it, expect, vi } from "vitest";
import { buildSystemPrompt } from "./prompt";
import { runAgentTurn } from "./run";
import { makeDispatch, AGENT_TOOLS } from "./tools";
import type { AgentContext } from "./types";

const KNOWN_CTX: AgentContext = {
  patientId: "pat-010",
  siteId: "site-cc",
  patientName: "Harold Pemberton",
  treatment: "Invisalign",
  fundingType: "private",
  isKnownPatient: true,
};

// ---------------------------------------------------------------------------
// 1. SYSTEM-PROMPT GUARDRAILS (the actual constraint text)
// ---------------------------------------------------------------------------
describe("guardrails: system prompt constraints", () => {
  it("NEVER give clinical advice: escalates clinical, forbids opinion on suitability", () => {
    const s = buildSystemPrompt(KNOWN_CTX);
    const low = s.toLowerCase();
    // Escalation is mandated for the clinical surface.
    expect(low).toContain("anything clinical or medical");
    expect(low).toContain("never give clinical advice");
    // Named clinical triggers so the model cannot rationalise "just this once".
    for (const trigger of ["symptoms", "pain", "swelling", "bleeding", "medication"]) {
      expect(low).toContain(trigger);
    }
    // Emergency path tells the patient to seek urgent care AND escalates.
    expect(low).toContain("emergency");
    expect(low).toContain("urgent");
  });

  it("NEVER quote an unverified price: only the treatment_info 'from' price, never invent", () => {
    const s = buildSystemPrompt(KNOWN_CTX).toLowerCase();
    expect(s).toContain("never invent a price");
    // Prices must come from the tool, hedged with "a coordinator confirms".
    expect(s).toContain("treatment_info");
    expect(s).toContain("coordinator confirms the exact price");
  });

  it("NEVER use NHS/private/funding jargon to the patient", () => {
    const s = buildSystemPrompt(KNOWN_CTX);
    // The instruction naming the forbidden internal labels must be present.
    expect(s.toLowerCase()).toContain("nhs or private");
    expect(s.toLowerCase()).toContain("internal labels, not patient-facing");
    // And even for a 'private' patient the prompt must not tell the model to say it.
    expect(s).not.toMatch(/tell (the|them) .*private/i);
  });

  it("uses GBP and never an em-dash, for every context shape", () => {
    for (const ctx of [
      KNOWN_CTX,
      { ...KNOWN_CTX, isKnownPatient: false, patientName: "there", treatment: null, fundingType: null },
      { ...KNOWN_CTX, lastVisitAt: "2024-05-10T09:00:00Z", recallDueAt: "2026-01-05T00:00:00Z" },
    ] as AgentContext[]) {
      const s = buildSystemPrompt(ctx);
      expect(s).toContain("£");
      expect(s).not.toContain("—"); // em-dash
      expect(s).not.toContain("–"); // en-dash
    }
  });

  it("owner USPs are sanitised before injection: an em-dash USP never reaches the prompt raw", () => {
    // A malicious/sloppy owner USP with an em-dash and a clinical over-claim.
    const s = buildSystemPrompt({
      ...KNOWN_CTX,
      usps: ["Painless implants — guaranteed results"],
    });
    expect(s).not.toContain("—");
    // The guard line reminds the model these are never a clinical guarantee.
    expect(s.toLowerCase()).toContain("never present these as a clinical guarantee");
  });
});

// ---------------------------------------------------------------------------
// 2. TOOL SAFETY + IDOR SURFACE
// ---------------------------------------------------------------------------
describe("tool safety: mutation scoping and the IDOR surface", () => {
  it("book is pinned to the CONTEXT patient/site, not any model-supplied id", async () => {
    const dentally = {
      getAvailability: vi.fn(),
      createAppointment: vi.fn().mockResolvedValue({ appointment: { id: "a1" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CTX });
    // Even if a crafted message coaxed the model to pass a patient_id, the tool
    // schema has no such field and dispatch injects context.patientId itself.
    await dispatch("book", { slotStart: "2026-06-22T09:00:00Z", finishTime: "2026-06-22T09:30:00Z", practitionerId: "42", treatment: "Invisalign", patient_id: "pat-999" });
    const payload = dentally.createAppointment.mock.calls[0][0];
    expect(payload.patient_id).toBe("pat-010"); // context-pinned, ignores the crafted pat-999
    // site_id is no longer sent (the site is implied by the practitioner in real Dentally).
    // The book tool schema exposes no patient/site override.
    const bookTool = AGENT_TOOLS.find((t) => t.name === "book")!;
    expect(Object.keys(bookTool.input_schema.properties ?? {})).not.toContain("patient_id");
    expect(Object.keys(bookTool.input_schema.properties ?? {})).not.toContain("site_id");
  });

  it("book refuses for an unregistered lead (forces register_patient first)", async () => {
    const dentally = { getAvailability: vi.fn(), createAppointment: vi.fn() };
    const leadCtx = { ...KNOWN_CTX, patientId: "lead:+447400000000", isKnownPatient: false };
    const dispatch = makeDispatch({ dentally: dentally as never, context: leadCtx });
    const out = await dispatch("book", { slotStart: "2026-06-22T09:00:00Z", treatment: "Checkup" });
    expect(out).toContain("Register this new patient");
    expect(dentally.createAppointment).not.toHaveBeenCalled();
  });

  it("IDOR FIXED: reschedule refuses a FOREIGN appointmentId (server-side ownership)", async () => {
    // dispatch now verifies the appointment belongs to context.patientId by
    // re-deriving the caller's own appointments from Dentally. A crafted message
    // that supplies another patient's appointment id is refused before any mutate.
    const dentally = {
      getAvailability: vi.fn(), createAppointment: vi.fn(),
      // The caller owns appt-MINE only; appt-OTHER-PATIENT is not theirs.
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [{ id: "appt-MINE", state: "booked" }] }),
      updateAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-OTHER-PATIENT" } }),
      cancelAppointment: vi.fn(),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CTX });
    const out = await dispatch("reschedule", { appointmentId: "appt-OTHER-PATIENT", newSlotStart: "2026-07-01T10:00:00Z" });
    expect(out).toContain("could not find that appointment");
    // Ownership WAS checked against the caller's own appointments...
    expect(dentally.getPatientAppointments).toHaveBeenCalledWith("pat-010");
    // ...and the foreign id never reached the mutation.
    expect(dentally.updateAppointment).not.toHaveBeenCalled();
  });

  it("IDOR FIXED: cancel refuses a FOREIGN appointmentId (server-side ownership)", async () => {
    const dentally = {
      getAvailability: vi.fn(), createAppointment: vi.fn(),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [{ id: "appt-MINE", state: "booked" }] }),
      updateAppointment: vi.fn(),
      cancelAppointment: vi.fn().mockResolvedValue({ appointment: { id: "appt-OTHER", state: "cancelled" } }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CTX });
    const out = await dispatch("cancel", { appointmentId: "appt-OTHER" });
    expect(out).toContain("could not find that appointment");
    expect(dentally.getPatientAppointments).toHaveBeenCalledWith("pat-010");
    expect(dentally.cancelAppointment).not.toHaveBeenCalled();
  });

  it("find_appointments IS scoped to the context patient (the intended safe path)", async () => {
    const dentally = {
      getAvailability: vi.fn(), createAppointment: vi.fn(), updateAppointment: vi.fn(), cancelAppointment: vi.fn(),
      getPatientAppointments: vi.fn().mockResolvedValue({ appointments: [] }),
    };
    const dispatch = makeDispatch({ dentally: dentally as never, context: KNOWN_CTX });
    await dispatch("find_appointments", {});
    // The read path pins to the caller's own patient id.
    expect(dentally.getPatientAppointments).toHaveBeenCalledWith("pat-010");
  });

  it("an unknown/hallucinated tool name is rejected, never throws", async () => {
    const dispatch = makeDispatch({
      dentally: { getAvailability: vi.fn(), createAppointment: vi.fn() } as never,
      context: KNOWN_CTX,
    });
    await expect(dispatch("delete_all_patients", { evil: true })).resolves.toContain("unknown tool");
  });
});

// ---------------------------------------------------------------------------
// 3. FAILURE HANDLING (the runAgentTurn loop)
// ---------------------------------------------------------------------------
function textMessage(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}
function toolUseMessage(id: string, name: string, input: object) {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] };
}

describe("failure handling: runAgentTurn degrades safely", () => {
  it("LLM/API error propagates as a rejection (caught by the webhook -> needs_human)", async () => {
    // The loop itself does not swallow; the webhook wraps it in try/catch and
    // routes to a human. We assert the rejection so that contract is explicit.
    const create = vi.fn().mockRejectedValue(new Error("529 overloaded"));
    const deps = { anthropic: { messages: { create } } as never, dispatch: vi.fn(), systemPrompt: "s", tools: [] };
    await expect(runAgentTurn([{ role: "user", content: "hi" }], deps)).rejects.toThrow("overloaded");
  });

  it("a runaway tool loop is bounded by maxRounds and returns escalated, never hangs", async () => {
    // Model never stops calling tools -> after maxRounds we bail with escalate.
    const create = vi.fn().mockResolvedValue(toolUseMessage("tu", "find_slots", { treatment: "x" }));
    const dispatch = vi.fn().mockResolvedValue("{}");
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "s", tools: [], maxRounds: 3 };
    const r = await runAgentTurn([{ role: "user", content: "loop" }], deps);
    expect(r.escalated).toBe(true);
    expect(r.replyText).toBe("");
    expect(create).toHaveBeenCalledTimes(3); // hard bound, no infinite spend
  });

  it("empty model reply (no text, end_turn) yields empty replyText -> webhook fallback message", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "end_turn", content: [] });
    const deps = { anthropic: { messages: { create } } as never, dispatch: vi.fn(), systemPrompt: "s", tools: [] };
    const r = await runAgentTurn([{ role: "user", content: "" }], deps);
    expect(r.replyText).toBe("");
    expect(r.escalated).toBe(false);
  });

  it("a dispatch that throws mid-loop escalates to a human instead of silently proceeding", async () => {
    // A thrown tool must not silently send wrong data, but it also must not abort the
    // turn and discard a mutation an earlier tool already committed. The model gets an
    // error tool_result and the turn is flagged escalated so a human still takes over.
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("tu", "book", { slotStart: "x", treatment: "y" }))
      .mockResolvedValueOnce(textMessage("Sorry, I couldn't finish that. A colleague will be in touch shortly."));
    const dispatch = vi.fn().mockRejectedValue(new Error("Dentally 500"));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "s", tools: [] };
    const r = await runAgentTurn(
      [
        { role: "assistant", content: "I can do Monday at 9:00am. Shall I book that in?" },
        { role: "user", content: "book it" },
      ],
      deps,
    );
    expect(r.escalated).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("escalate_to_human sets the escalated flag so the webhook hands over", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(toolUseMessage("tu", "escalate_to_human", { reason: "clinical" }))
      .mockResolvedValueOnce(textMessage("A member of our team will be in touch shortly."));
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify({ escalated: true }));
    const deps = { anthropic: { messages: { create } } as never, dispatch, systemPrompt: "s", tools: [] };
    const r = await runAgentTurn([{ role: "user", content: "I have terrible tooth pain" }], deps);
    expect(r.escalated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. COST GUARD
// ---------------------------------------------------------------------------
describe("cost: per-window budget guard on the inbound agent loop", () => {
  it("maxRounds and maxTokens bound the spend PER inbound message", async () => {
    // Per-message spend is capped by the round/token limits.
    const create = vi.fn().mockResolvedValue(toolUseMessage("tu", "find_slots", { treatment: "x" }));
    const deps = {
      anthropic: { messages: { create } } as never,
      dispatch: vi.fn().mockResolvedValue("{}"),
      systemPrompt: "s", tools: [], maxRounds: 2, maxTokens: 100,
    };
    await runAgentTurn([{ role: "user", content: "hi" }], deps);
    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) expect(call[0].max_tokens).toBe(100);
  });

  // The ACROSS-inbound-messages ceiling is now enforced by a per-sender
  // consumeBudget() gate on the inbound route (matching the other public AI
  // endpoints). That behaviour is asserted at the webhook level in
  // area6-agent-webhook-guardrails.test.ts and fixWA-inbound-hardening.test.ts.
});
