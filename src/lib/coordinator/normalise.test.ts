import { describe, it, expect } from "vitest";
import {
  toTreatmentOpportunity,
  toRankedOpportunities,
  type CoordinatorInput,
} from "./normalise";

const NOW = new Date("2026-06-26T09:00:00.000Z");

function input(overrides: Partial<CoordinatorInput> = {}): CoordinatorInput {
  return {
    siteId: "site-cc",
    patient: {
      id: "pat-1",
      first_name: "Sam",
      last_name: "Lee",
      use_sms: true,
      use_email: true,
      marketing: 1,
    },
    plan: {
      id: "plan-1",
      name: "Invisalign full arch",
      plannedValue: 3200,
      amountOutstanding: 3200,
      acceptedAt: "2026-05-01T10:00:00.000Z",
      financePresented: false,
    },
    lastTouchAt: null,
    ...overrides,
  };
}

describe("toTreatmentOpportunity", () => {
  it("maps a Dentally plan + patient into an opportunity", () => {
    const o = toTreatmentOpportunity(input(), NOW);
    expect(o).not.toBeNull();
    expect(o!.id).toBe("site-cc:pat-1:plan-1");
    expect(o!.siteId).toBe("site-cc");
    expect(o!.dentallyPatientId).toBe("pat-1");
    expect(o!.dentallyPlanId).toBe("plan-1");
    expect(o!.patientName).toBe("Sam Lee");
    expect(o!.treatment).toBe("Invisalign full arch");
    expect(o!.plannedValue).toBe(3200);
    expect(o!.amountOutstanding).toBe(3200);
    expect(o!.acceptedAt).toBe("2026-05-01T10:00:00.000Z");
    expect(o!.status).toBe("accepted");
    expect(o!.financePresented).toBe(false);
    expect(o!.consent).toEqual({ sms: true, email: true, marketing: true });
    expect(o!.priorityScore).toBeGreaterThan(0);
  });

  it("skips a completed plan (no money left, terminal status)", () => {
    expect(
      toTreatmentOpportunity(
        input({ plan: { ...input().plan, status: "completed" } }),
        NOW,
      ),
    ).toBeNull();
  });

  it("skips a declined plan", () => {
    expect(
      toTreatmentOpportunity(
        input({ plan: { ...input().plan, status: "declined" } }),
        NOW,
      ),
    ).toBeNull();
  });

  it("skips a plan with nothing left outstanding", () => {
    expect(
      toTreatmentOpportunity(
        input({ plan: { ...input().plan, amountOutstanding: 0 } }),
        NOW,
      ),
    ).toBeNull();
  });

  it("respects each consent flag", () => {
    const o = toTreatmentOpportunity(
      input({
        patient: {
          id: "pat-2",
          first_name: "No",
          last_name: "Consent",
          use_sms: false,
          use_email: false,
          marketing: 0,
        },
      }),
      NOW,
    );
    expect(o!.consent).toEqual({ sms: false, email: false, marketing: false });
  });
});

describe("toRankedOpportunities", () => {
  it("drops non-opportunities and ranks by recovery value (highest first)", () => {
    const inputs: CoordinatorInput[] = [
      input({
        patient: { id: "p-small", first_name: "Small", last_name: "Plan" },
        plan: { id: "pl-small", name: "Whitening", plannedValue: 400, amountOutstanding: 400, acceptedAt: "2026-05-01T10:00:00.000Z" },
      }),
      input({
        patient: { id: "p-big", first_name: "Big", last_name: "Plan" },
        plan: { id: "pl-big", name: "Full rehab", plannedValue: 8000, amountOutstanding: 8000, acceptedAt: "2026-05-01T10:00:00.000Z" },
      }),
      // Not an opportunity: nothing outstanding. Must be dropped.
      input({
        patient: { id: "p-done", first_name: "Done", last_name: "Plan" },
        plan: { id: "pl-done", name: "Crown", plannedValue: 600, amountOutstanding: 0, acceptedAt: "2026-05-01T10:00:00.000Z" },
      }),
    ];
    const ranked = toRankedOpportunities(inputs, NOW);
    expect(ranked.map((o) => o.dentallyPatientId)).toEqual(["p-big", "p-small"]);
    expect(ranked[0].priorityScore).toBeGreaterThan(ranked[1].priorityScore);
  });
});
