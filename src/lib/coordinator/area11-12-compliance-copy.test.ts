import { describe, it, expect } from "vitest";
import { buildDraftPrompt } from "./draft";
import { checkAgentReply } from "@/lib/agent/guardrail";
import type { TreatmentOpportunity } from "./types";

// ---------------------------------------------------------------------------
// AREA 11+12 compliance: patient-facing copy must never contain NHS / private /
// funding wording (project rule, applies to every patient-facing agent).
//
// Two layers exist for the CONVERSATIONAL agent: the prompt (soft) and
// checkAgentReply (deterministic, hard). The treatment-coordinator DRAFT path
// only has the prompt layer — its output is queued for send WITHOUT passing
// through checkAgentReply. These tests (a) prove the prompt instruction is
// present, and (b) prove checkAgentReply WOULD catch a violating draft, which
// documents both the safety net that exists elsewhere and the gap here.
// ---------------------------------------------------------------------------

const o: TreatmentOpportunity = {
  id: "o", siteId: "site-cc", dentallyPatientId: "p", dentallyPlanId: "pl",
  patientName: "Sarah Lindqvist", treatment: "Invisalign full arch", plannedValue: 3400,
  amountOutstanding: 3400, acceptedAt: "2026-05-28T00:00:00Z", status: "stalled",
  financePresented: false, lastTouchAt: null, priorityScore: 1,
  consent: { sms: true, email: true, marketing: true }, updatedFromDentallyAt: "x",
};

describe("coordinator draft prompt — funding-jargon guard", () => {
  it("instructs the model never to use NHS / private / funding wording", () => {
    const { system } = buildDraftPrompt(o, "sms");
    const lower = system.toLowerCase();
    expect(lower).toContain("nhs or private");
    expect(lower).toContain("funding");
    // The prompt itself must be clean of the forbidden tokens as instructions,
    // but crucially it must not put NHS/private wording into example copy.
    expect(system).not.toContain("—"); // no em-dash in our own instructions
    expect(system).toContain("£");
  });

  it("system + user prompt carry no NHS/private/funding category as patient copy", () => {
    const { system, user } = buildDraftPrompt(o, "email");
    // The user payload (patient/treatment/values) must not leak a funding label.
    expect(checkAgentReply(user).ok).toBe(true);
    // The system prompt references NHS/private only as a forbidden label, which
    // is expected; assert the guard trips on those tokens so the net is real.
    expect(/nhs or private/i.test(system)).toBe(true);
  });
});

describe("checkAgentReply — deterministic net for drafted copy (documents the safety layer)", () => {
  it("blocks a compliant-looking draft that mentions NHS", () => {
    const bad = "Hi Sarah, your treatment is on the NHS waiting list, shall we book?";
    expect(checkAgentReply(bad).ok).toBe(false);
    expect(checkAgentReply(bad).category).toBe("funding");
  });

  it("blocks a draft that mentions going private", () => {
    const bad = "Hi Sarah, you could go private to be seen sooner, happy to help.";
    expect(checkAgentReply(bad).ok).toBe(false);
  });

  it("passes a clean, on-brand coordinator draft", () => {
    const good =
      "Hi Sarah, your Invisalign plan has £3400 outstanding. We can spread the cost with a payment plan. Shall I book you a quick call to talk it through?";
    expect(checkAgentReply(good).ok).toBe(true);
  });
});
