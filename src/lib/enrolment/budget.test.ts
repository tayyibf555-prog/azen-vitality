import { describe, it, expect } from "vitest";
import { enrolmentBudget, type EnrolmentBudgetInput } from "./budget";

function input(over: Partial<EnrolmentBudgetInput> = {}): EnrolmentBudgetInput {
  return {
    systemEnabled: true,
    dailyLimit: 25,
    usedToday: 0,
    pendingDue: 0,
    perRunCap: 25,
    ...over,
  };
}

describe("enrolmentBudget", () => {
  it("allows a full run when the day is untouched", () => {
    expect(enrolmentBudget(input())).toBe(25);
  });

  it("never exceeds the per-run ceiling, however large the daily cap", () => {
    expect(enrolmentBudget(input({ dailyLimit: 500, perRunCap: 25 }))).toBe(25);
  });

  it("spends only what is left of today's cap", () => {
    expect(enrolmentBudget(input({ dailyLimit: 25, usedToday: 20 }))).toBe(5);
  });

  it("counts the cadences already waiting to send against the budget", () => {
    // 25/day, 10 already queued and 12 cadences due: only 3 more may be started,
    // otherwise a run would keep piling up cadences the sweep cannot serve today.
    expect(enrolmentBudget(input({ dailyLimit: 25, usedToday: 10, pendingDue: 12 }))).toBe(3);
  });

  it("returns 0 once the day's budget is spent", () => {
    expect(enrolmentBudget(input({ usedToday: 25 }))).toBe(0);
    expect(enrolmentBudget(input({ usedToday: 40 }))).toBe(0);
    expect(enrolmentBudget(input({ pendingDue: 25 }))).toBe(0);
  });

  it("enrols nobody while the owner has the module switched off", () => {
    expect(enrolmentBudget(input({ systemEnabled: false }))).toBe(0);
    // Even with the whole day free.
    expect(enrolmentBudget(input({ systemEnabled: false, dailyLimit: 500 }))).toBe(0);
  });

  it("treats a zero or negative daily cap as paused, not unlimited", () => {
    expect(enrolmentBudget(input({ dailyLimit: 0 }))).toBe(0);
    expect(enrolmentBudget(input({ dailyLimit: -5 }))).toBe(0);
  });

  it("fails closed on a non-finite input rather than enrolling everyone", () => {
    expect(enrolmentBudget(input({ dailyLimit: Number.NaN }))).toBe(0);
    expect(enrolmentBudget(input({ usedToday: Number.NaN }))).toBe(0);
    expect(enrolmentBudget(input({ pendingDue: Number.NaN }))).toBe(0);
    expect(enrolmentBudget(input({ perRunCap: Number.NaN }))).toBe(0);
    expect(enrolmentBudget(input({ dailyLimit: Number.POSITIVE_INFINITY }))).toBe(0);
  });

  it("always returns a whole number", () => {
    expect(enrolmentBudget(input({ dailyLimit: 10.7, perRunCap: 25 }))).toBe(10);
    expect(enrolmentBudget(input({ perRunCap: 4.9 }))).toBe(4);
  });
});
