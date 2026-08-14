import { describe, it, expect } from "vitest";
import { costPence, poundsLabel, poundsToPence, priceDays, rateOnDay } from "./cost";
import type { PayRate } from "./types";

const rate = (from: string, pence: number, to: string | null = null): PayRate => ({
  staffId: "s1",
  hourlyPence: pence,
  effectiveFrom: from,
  effectiveTo: to,
});

describe("rateOnDay", () => {
  it("returns null when nothing covers the day, and null is not zero", () => {
    expect(rateOnDay("2026-06-10", [])).toBeNull();
    expect(rateOnDay("2026-06-10", [rate("2026-07-01", 1250)])).toBeNull();
  });

  it("A RISE ON THE 15th: earlier days keep the old rate", () => {
    // The defect this rule exists to prevent: pricing the whole month at the
    // newest rate back-dates a pay rise over work already done.
    const rates = [rate("2026-06-01", 1200), rate("2026-06-15", 1300)];
    expect(rateOnDay("2026-06-14", rates)).toBe(1200);
    expect(rateOnDay("2026-06-15", rates)).toBe(1300);
    expect(rateOnDay("2026-06-30", rates)).toBe(1300);
  });

  it("overlapping OPEN ENDED rows resolve to the latest start, because that is the normal state", () => {
    // Append-only history means the old row is usually never closed.
    const rates = [rate("2026-01-01", 1100), rate("2026-06-15", 1300)];
    expect(rateOnDay("2026-06-01", rates)).toBe(1100);
    expect(rateOnDay("2026-06-15", rates)).toBe(1300);
  });

  it("honours a closed row's last day, inclusive", () => {
    const rates = [rate("2026-06-01", 1200, "2026-06-14")];
    expect(rateOnDay("2026-06-14", rates)).toBe(1200);
    expect(rateOnDay("2026-06-15", rates)).toBeNull();
  });

  it("is order independent: the rows may arrive in any order", () => {
    const forwards = [rate("2026-06-01", 1200), rate("2026-06-15", 1300)];
    const backwards = [...forwards].reverse();
    expect(rateOnDay("2026-06-20", backwards)).toBe(rateOnDay("2026-06-20", forwards));
  });
});

describe("costPence", () => {
  it("is exact when the minutes divide the hour", () => {
    expect(costPence(60, 1250)).toBe(1250);
    expect(costPence(30, 1250)).toBe(625);
    expect(costPence(480, 1250)).toBe(10_000);
  });

  it("rounds to a whole penny rather than carrying a fraction", () => {
    // 10 minutes at £10.00/hr is 166.66..p.
    expect(costPence(10, 1000)).toBe(167);
    expect(Number.isInteger(costPence(7, 1337))).toBe(true);
  });

  it("never returns a negative or a NaN from bad input", () => {
    expect(costPence(-10, 1000)).toBe(0);
    expect(costPence(10, -1000)).toBe(0);
    expect(costPence(Number.NaN, 1000)).toBe(0);
  });
});

describe("priceDays", () => {
  const days = [
    { dayKey: "2026-06-10", minutes: 480 },
    { dayKey: "2026-06-20", minutes: 480 },
  ];

  it("A MID-MONTH RATE CHANGE prices each day at the rate in force that day", () => {
    const priced = priceDays(days, [rate("2026-06-01", 1200), rate("2026-06-15", 1300)]);
    // 8h at £12 = 9600p, 8h at £13 = 10400p.
    expect(priced.costPence).toBe(20_000);
    expect(priced.ratesApplied).toBe(2);
    expect(priced.lastRatePence).toBe(1300);
  });

  it("A MONTH WITH NO RATE COSTS null, NEVER 0", () => {
    const priced = priceDays(days, []);
    expect(priced.costPence).toBeNull();
    expect(priced.costPence).not.toBe(0);
    expect(priced.unpricedDays).toBe(2);
  });

  it("ONE unpriced day nulls the whole total rather than quietly undercounting", () => {
    // The rate starts on the 15th, so the 10th cannot be priced. Returning 10400
    // here would be a payroll figure that is silently short by a day.
    const priced = priceDays(days, [rate("2026-06-15", 1300)]);
    expect(priced.costPence).toBeNull();
    expect(priced.unpricedDays).toBe(1);
  });

  it("days with no minutes are not counted as unpriced", () => {
    const priced = priceDays([{ dayKey: "2026-06-10", minutes: 0 }], []);
    expect(priced.unpricedDays).toBe(0);
    expect(priced.costPence).toBe(0);
  });

  it("the days may arrive in any order and the last rate is still the latest day's", () => {
    const priced = priceDays([...days].reverse(), [rate("2026-06-01", 1200), rate("2026-06-15", 1300)]);
    expect(priced.lastRatePence).toBe(1300);
    expect(priced.costPence).toBe(20_000);
  });
});

describe("poundsToPence", () => {
  it("reads a typed rate exactly, without a float in the middle", () => {
    // parseFloat("12.10") * 100 is 1209.9999999999998, and a rate a penny short
    // is wrong on every hour anybody works.
    expect(poundsToPence("12.10")).toBe(1210);
    expect(poundsToPence("12.50")).toBe(1250);
    expect(poundsToPence("12.5")).toBe(1250);
    expect(poundsToPence("12")).toBe(1200);
    expect(poundsToPence("0.05")).toBe(5);
  });

  it("tolerates what a person actually types", () => {
    expect(poundsToPence("£12.50")).toBe(1250);
    expect(poundsToPence(" 1,234.56 ")).toBe(123_456);
  });

  it("REFUSES more than two decimal places rather than rounding somebody's rate", () => {
    expect(poundsToPence("12.345")).toBeNull();
  });

  it("refuses anything that is not an amount", () => {
    expect(poundsToPence("")).toBeNull();
    expect(poundsToPence("twelve")).toBeNull();
    expect(poundsToPence("12.50.50")).toBeNull();
    expect(poundsToPence("1e3")).toBeNull();
  });

  it("round-trips against poundsLabel", () => {
    for (const pence of [0, 5, 1250, 123_456]) {
      expect(poundsToPence(poundsLabel(pence))).toBe(pence);
    }
  });
});

describe("poundsLabel", () => {
  it("formats pence without ever going through a float", () => {
    expect(poundsLabel(1250)).toBe("£12.50");
    expect(poundsLabel(5)).toBe("£0.05");
    expect(poundsLabel(0)).toBe("£0.00");
    expect(poundsLabel(123_456)).toBe("£1,234.56");
  });

  it("keeps the trailing zero a money column needs", () => {
    expect(poundsLabel(1200)).toBe("£12.00");
    expect(poundsLabel(1210)).toBe("£12.10");
  });

  it("handles a negative without losing the sign", () => {
    expect(poundsLabel(-1250)).toBe("-£12.50");
  });
});
