import { describe, it, expect } from "vitest";
import { buildDraftPrompt } from "./draft";
import { stepDef } from "./cadence";
import type { ReactivationTarget } from "./types";

function target(p: Partial<ReactivationTarget>): ReactivationTarget {
  return {
    id: "t", siteId: "s", dentallyPatientId: "p", patientName: "Sarah Lindqvist",
    reason: "stalled_plan", dentallyPlanId: "pl", treatment: "Invisalign full arch",
    recoverableValue: 3400, lastVisitAt: null, recallDueAt: null, priorAttempts: 0,
    status: "in_cadence", reactivationScore: 1,
    consent: { sms: true, email: true, marketing: true }, updatedFromDentallyAt: "x", ...p,
  };
}

describe("buildDraftPrompt", () => {
  it("forbids em-dashes and requires GBP in the system prompt", () => {
    const { system } = buildDraftPrompt(target({}), "sms", stepDef(1)!);
    expect(system).not.toContain("—"); // em-dash
    expect(system.toLowerCase()).toContain("no em-dash");
    expect(system).toContain("£"); // £
  });

  it("includes patient, channel, step purpose and the stalled-plan value", () => {
    const { user, system } = buildDraftPrompt(target({}), "whatsapp", stepDef(2)!);
    expect(user).toContain("Sarah Lindqvist");
    expect(user).toContain("whatsapp");
    expect(user).toContain("3400");
    expect(user.toLowerCase()).toContain("offer");      // step 2 purpose
    expect(system.toLowerCase()).toContain("finance");  // stalled_plan branch
  });

  it("uses a checkup invitation for a lapsed patient, not finance", () => {
    const { system } = buildDraftPrompt(target({ reason: "lapsed", treatment: null, recoverableValue: 80 }), "sms", stepDef(1)!);
    expect(system.toLowerCase()).toContain("checkup");
  });
});
