import { describe, it, expect } from "vitest";
import { reactivationScore, rankTargets } from "./scoring";
import type { ReactivationTarget } from "./types";

const NOW = new Date("2026-06-18T09:00:00Z");

function target(p: Partial<ReactivationTarget>): ReactivationTarget {
  return {
    id: "t", siteId: "s", dentallyPatientId: "p", patientName: "Test",
    reason: "lapsed", dentallyPlanId: null, treatment: null,
    recoverableValue: 1000, lastVisitAt: "2026-01-01T00:00:00Z", recallDueAt: null,
    priorAttempts: 0, status: "dormant", reactivationScore: 0,
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: NOW.toISOString(), ...p,
  };
}

describe("reactivationScore", () => {
  it("ranks higher recoverable value above lower, all else equal", () => {
    const big = reactivationScore(target({ recoverableValue: 4000 }), NOW);
    const small = reactivationScore(target({ recoverableValue: 1000 }), NOW);
    expect(big).toBeGreaterThan(small);
  });

  it("favours a more recently lapsed patient over a long-gone one", () => {
    const recent = reactivationScore(target({ lastVisitAt: "2026-05-01T00:00:00Z" }), NOW);
    const old = reactivationScore(target({ lastVisitAt: "2024-01-01T00:00:00Z" }), NOW);
    expect(recent).toBeGreaterThan(old);
  });

  it("penalises more prior attempts", () => {
    const fresh = reactivationScore(target({ priorAttempts: 0 }), NOW);
    const tired = reactivationScore(target({ priorAttempts: 3 }), NOW);
    expect(fresh).toBeGreaterThan(tired);
  });

  it("a large stalled plan outranks a tiny fresh checkup", () => {
    const plan = reactivationScore(
      target({ recoverableValue: 5000, priorAttempts: 2, lastVisitAt: "2024-06-01T00:00:00Z" }),
      NOW,
    );
    const checkup = reactivationScore(
      target({ recoverableValue: 80, priorAttempts: 0, lastVisitAt: "2026-06-01T00:00:00Z" }),
      NOW,
    );
    expect(plan).toBeGreaterThan(checkup);
  });
});

describe("rankTargets", () => {
  it("sorts descending by score and stamps reactivationScore", () => {
    const ranked = rankTargets(
      [target({ id: "a", recoverableValue: 200 }), target({ id: "b", recoverableValue: 5000 })],
      NOW,
    );
    expect(ranked.map((t) => t.id)).toEqual(["b", "a"]);
    expect(ranked[0].reactivationScore).toBeGreaterThan(0);
  });
});
