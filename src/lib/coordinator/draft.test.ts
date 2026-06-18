import { describe, it, expect } from "vitest";
import { buildDraftPrompt } from "./draft";
import type { TreatmentOpportunity } from "./types";

const o: TreatmentOpportunity = {
  id: "o", siteId: "s", dentallyPatientId: "p", dentallyPlanId: "pl",
  patientName: "Sarah Lindqvist", treatment: "Invisalign full arch", plannedValue: 3400,
  amountOutstanding: 3400, acceptedAt: "2026-05-28T00:00:00Z", status: "stalled",
  financePresented: false, lastTouchAt: null, priorityScore: 1,
  consent: { sms: true, email: true, marketing: true }, updatedFromDentallyAt: "x",
};

describe("buildDraftPrompt", () => {
  it("forbids em-dashes and requires GBP in the system prompt", () => {
    const { system } = buildDraftPrompt(o, "sms");
    expect(system).not.toContain("—"); // no em-dash in our own instructions
    expect(system.toLowerCase()).toContain("no em-dash");
    expect(system).toContain("£");
  });

  it("includes patient, treatment, outstanding value and channel in the user message", () => {
    const { user } = buildDraftPrompt(o, "whatsapp");
    expect(user).toContain("Sarah Lindqvist");
    expect(user).toContain("Invisalign full arch");
    expect(user).toContain("3400");
    expect(user).toContain("whatsapp");
  });
});
