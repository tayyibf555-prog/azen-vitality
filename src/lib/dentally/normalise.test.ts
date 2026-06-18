import { describe, it, expect } from "vitest";
import { toOpportunity, type DentallyPlanInput } from "./normalise";

const NOW = new Date("2026-06-18T09:00:00Z");

const input: DentallyPlanInput = {
  siteId: "site-cc",
  patient: { id: "123", first_name: "Sarah", last_name: "Lindqvist",
    contact_details: { sms_marketing: true, email_marketing: false }, marketing: true },
  plan: { id: "pl-9", name: "Invisalign full arch", planned_private_treatment_value: 3400,
    accepted_at: "2026-04-01T00:00:00Z" },
  amountOutstanding: 3400,
  lastTouchAt: null,
};

describe("toOpportunity", () => {
  it("maps core fields and GBP values", () => {
    const o = toOpportunity(input, NOW);
    expect(o.dentallyPatientId).toBe("123");
    expect(o.patientName).toBe("Sarah Lindqvist");
    expect(o.plannedValue).toBe(3400);
    expect(o.amountOutstanding).toBe(3400);
    expect(o.consent).toEqual({ sms: true, email: false, marketing: true });
  });

  it("derives stalled when accepted over 30 days ago with no touch", () => {
    expect(toOpportunity(input, NOW).status).toBe("stalled");
  });

  it("derives completed when nothing outstanding", () => {
    expect(toOpportunity({ ...input, amountOutstanding: 0 }, NOW).status).toBe("completed");
  });

  it("does not copy any field outside the whitelist (no clinical data)", () => {
    const dirty = { ...input, patient: { ...input.patient, medical_notes: "SECRET" } as never };
    const o = toOpportunity(dirty, NOW);
    expect(JSON.stringify(o)).not.toContain("SECRET");
  });
});
