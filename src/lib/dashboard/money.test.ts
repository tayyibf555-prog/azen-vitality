import { describe, expect, it } from "vitest";

import {
  formatPenceGbp,
  hundredthsToUda,
  parseMoneyPence,
  parseUdaHundredths,
  penceToPounds,
  round2,
} from "@/lib/dashboard/money";

describe("parseMoneyPence", () => {
  it("reads the exact string shapes Dentally returns", () => {
    expect(parseMoneyPence("27.9")).toBe(2790);
    expect(parseMoneyPence("27.90")).toBe(2790);
    expect(parseMoneyPence("185")).toBe(18500);
    expect(parseMoneyPence("0")).toBe(0);
    expect(parseMoneyPence("0.05")).toBe(5);
    expect(parseMoneyPence("3060.20")).toBe(306020);
  });

  it("keeps refunds negative rather than dropping them", () => {
    expect(parseMoneyPence("-12.34")).toBe(-1234);
    expect(parseMoneyPence("-0.01")).toBe(-1);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseMoneyPence("  27.9  ")).toBe(2790);
  });

  it("drops a malformed amount rather than counting it as zero", () => {
    for (const bad of ["", "   ", "n/a", "abc", "1,234.56", "27.999", "1e3", ".5", "27.", "+27.9", "NaN"]) {
      expect(parseMoneyPence(bad), `expected ${JSON.stringify(bad)} to drop`).toBeNull();
    }
  });

  it("drops non-string, non-number values", () => {
    for (const bad of [null, undefined, true, false, {}, [], () => 1]) {
      expect(parseMoneyPence(bad)).toBeNull();
    }
  });

  it("drops non-finite numbers but accepts finite ones", () => {
    expect(parseMoneyPence(27.9)).toBe(2790);
    expect(parseMoneyPence(0)).toBe(0);
    expect(parseMoneyPence(Number.NaN)).toBeNull();
    expect(parseMoneyPence(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("drops values too large to hold exactly in pence", () => {
    expect(parseMoneyPence("999999999999999999999")).toBeNull();
  });

  it("sums exactly across many rows, where floats would drift", () => {
    const rows = Array.from({ length: 1000 }, () => "0.10");
    const total = rows.reduce((acc, r) => acc + (parseMoneyPence(r) ?? 0), 0);
    expect(total).toBe(10_000);
    expect(penceToPounds(total)).toBe(100);
  });
});

describe("parseUdaHundredths", () => {
  it("reads the UDA strings the claims endpoint returns", () => {
    expect(parseUdaHundredths("1.56")).toBe(156);
    expect(parseUdaHundredths("3")).toBe(300);
    expect(parseUdaHundredths("0")).toBe(0);
    expect(parseUdaHundredths("12.00")).toBe(1200);
  });

  it("drops an unreadable UDA figure", () => {
    expect(parseUdaHundredths("")).toBeNull();
    expect(parseUdaHundredths("pending")).toBeNull();
  });
});

describe("formatPenceGbp", () => {
  it("formats sterling British style", () => {
    expect(formatPenceGbp(306020)).toBe("£3,060.20");
    expect(formatPenceGbp(0)).toBe("£0.00");
    expect(formatPenceGbp(-14884660)).toBe("-£148,846.60");
  });
});

describe("helpers", () => {
  it("converts units", () => {
    expect(penceToPounds(2790)).toBe(27.9);
    expect(hundredthsToUda(156)).toBe(1.56);
  });

  it("rounds derived figures to two places", () => {
    expect(round2(33.333333)).toBe(33.33);
    expect(round2(1.239)).toBe(1.24);
    expect(round2(-2.349)).toBe(-2.35);
    expect(round2(2.5)).toBe(2.5);
    expect(round2(0)).toBe(0);
  });
});
