import { describe, it, expect } from "vitest";
import { priorityScore, rankOpportunities } from "./scoring";
import type { TreatmentOpportunity } from "./types";

const NOW = new Date("2026-06-18T09:00:00Z");

function opp(p: Partial<TreatmentOpportunity>): TreatmentOpportunity {
  return {
    id: "o", siteId: "s", dentallyPatientId: "p", dentallyPlanId: "pl",
    patientName: "Test", treatment: "Invisalign", plannedValue: 3000,
    amountOutstanding: 3000, acceptedAt: "2026-06-01T00:00:00Z", status: "stalled",
    financePresented: false, lastTouchAt: null, priorityScore: 0,
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: NOW.toISOString(), ...p,
  };
}

describe("priorityScore", () => {
  it("ranks higher outstanding value above lower, all else equal", () => {
    const big = priorityScore(opp({ amountOutstanding: 4000 }), NOW);
    const small = priorityScore(opp({ amountOutstanding: 1000 }), NOW);
    expect(big).toBeGreaterThan(small);
  });

  it("gives a bonus when finance not yet presented", () => {
    const noFinance = priorityScore(opp({ financePresented: false }), NOW);
    const withFinance = priorityScore(opp({ financePresented: true }), NOW);
    expect(noFinance).toBeGreaterThan(withFinance);
  });

  it("a large plan outranks a tiny recent one", () => {
    const large = priorityScore(opp({ amountOutstanding: 5000, acceptedAt: "2026-01-01T00:00:00Z" }), NOW);
    const tiny = priorityScore(opp({ amountOutstanding: 200, acceptedAt: "2026-06-17T00:00:00Z" }), NOW);
    expect(large).toBeGreaterThan(tiny);
  });

  it("stays finite when acceptedAt is empty or invalid", () => {
    const empty = priorityScore(opp({ acceptedAt: "" }), NOW);
    const invalid = priorityScore(opp({ acceptedAt: "not-a-date" }), NOW);
    expect(Number.isFinite(empty)).toBe(true);
    expect(Number.isFinite(invalid)).toBe(true);
  });
});

describe("rankOpportunities", () => {
  it("sorts descending by score and stamps priorityScore", () => {
    const ranked = rankOpportunities([opp({ id: "a", amountOutstanding: 500 }), opp({ id: "b", amountOutstanding: 5000 })], NOW);
    expect(ranked.map((o) => o.id)).toEqual(["b", "a"]);
    expect(ranked[0].priorityScore).toBeGreaterThan(0);
  });
});
