import { describe, it, expect } from "vitest";
import { buildRecallPrompt } from "./draft";
import { stepDef, RECALL_CADENCE } from "./cadence";
import type { RecallTarget } from "./types";

function target(p: Partial<RecallTarget>): RecallTarget {
  return {
    id: "site-cc:123:dentist",
    siteId: "site-cc",
    dentallyPatientId: "123",
    patientName: "Sarah Lindqvist",
    recallType: "dentist",
    dueAt: "2026-06-25T00:00:00Z",
    overdueDays: -7,
    lastVisitAt: "2026-01-10T00:00:00Z",
    priorAttempts: 0,
    status: "due",
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: "x",
    ...p,
  };
}

describe("buildRecallPrompt", () => {
  it("forbids em-dashes and requires GBP in the system prompt", () => {
    const { system } = buildRecallPrompt(target({}), "sms", stepDef(1, RECALL_CADENCE)!);
    expect(system).not.toContain("—"); // em-dash
    expect(system.toLowerCase()).toContain("no em-dash");
    expect(system).toContain("£");
    expect(system.toLowerCase()).toContain("nhs or private"); // no funding jargon to patients
  });

  it("uses a checkup invitation for a dentist recall", () => {
    const { system } = buildRecallPrompt(target({ recallType: "dentist" }), "sms", stepDef(1, RECALL_CADENCE)!);
    expect(system.toLowerCase()).toContain("checkup");
  });

  it("uses a hygiene invitation for a hygienist recall", () => {
    const { system } = buildRecallPrompt(target({ recallType: "hygienist" }), "sms", stepDef(1, RECALL_CADENCE)!);
    expect(system.toLowerCase()).toContain("hygiene");
  });

  it("includes patient, channel, recall type and the step purpose", () => {
    const { user } = buildRecallPrompt(target({}), "whatsapp", stepDef(2, RECALL_CADENCE)!);
    expect(user).toContain("Sarah Lindqvist");
    expect(user).toContain("whatsapp");
    expect(user).toContain("dentist");
    expect(user.toLowerCase()).toContain("offer"); // step 2 purpose
  });

  it("describes a due-soon recall without an em-dash", () => {
    const { user } = buildRecallPrompt(target({ overdueDays: -7 }), "sms", stepDef(1, RECALL_CADENCE)!);
    expect(user).toContain("due in 7 days");
    expect(user).not.toContain("—");
  });
});
