import { describe, expect, it } from "vitest";

import {
  parseAggregateAmountPence,
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

// ---------------------------------------------------------------------------
// meta.total_amount — Dentally's own windowed total, which the takings strip now
// shows instead of a figure assembled from rows. Getting the unit or the precision
// wrong here would be worse than the 38%-short bug it replaced, because it would be
// wrong quietly and by a factor.
// ---------------------------------------------------------------------------

describe("parseAggregateAmountPence", () => {
  it("reads the real live values to the exact penny", () => {
    // The three figures the practice owner checked against Dentally on 2026-08-21.
    expect(parseAggregateAmountPence("588.9")).toBe(58_890);
    expect(parseAggregateAmountPence("27240.9")).toBe(2_724_090);
    expect(parseAggregateAmountPence("114429.78")).toBe(11_442_978);
  });

  it("does NOT go through a float, which loses the penny on real Dentally figures", () => {
    // These are not hypotheticals: every one of these strings is the shape Dentally
    // sends, and multiplying by 100 leaves each of them off the integer.
    expect(Number.isInteger(Number("70.1") * 100)).toBe(false);       // 7009.999999999999
    expect(Number.isInteger(Number("8.2") * 100)).toBe(false);        // 819.9999999999999
    expect(Number.isInteger(Number("1145.85") * 100)).toBe(false);    // 114584.99999999999
    // And on a half-penny the float path rounds the WRONG WAY, so Math.round is not
    // a rescue: 1.005 * 100 is 100.49999999999999, which rounds down to 100.
    expect(Math.round(Number("1.005") * 100)).toBe(100);
    expect(parseAggregateAmountPence("1.005")).toBe(101);
    // All exact here, by construction rather than by rounding luck.
    expect(parseAggregateAmountPence("70.1")).toBe(7_010);
    expect(parseAggregateAmountPence("8.2")).toBe(820);
    expect(parseAggregateAmountPence("1145.85")).toBe(114_585);
  });

  it("rounds the sub-penny tail rather than refusing the whole window", () => {
    // Live payment 28647 is "0.0015", so a window containing it yields an aggregate
    // with more decimals than a row is allowed. parseMoneyPence rightly refuses
    // those; an aggregate must not, or one fractional payment blanks a real total.
    expect(parseMoneyPence("46721.8015")).toBeNull();
    expect(parseAggregateAmountPence("46721.8015")).toBe(4_672_180);
    expect(parseAggregateAmountPence("0.0015")).toBe(0);
    expect(parseAggregateAmountPence("3602268.06693")).toBe(360_226_807);
    // Half away from zero, in both directions.
    expect(parseAggregateAmountPence("1.005")).toBe(101);
    expect(parseAggregateAmountPence("-1.005")).toBe(-101);
    expect(parseAggregateAmountPence("1.004")).toBe(100);
  });

  it("keeps a real zero apart from an unreadable one", () => {
    // A Sunday answers "0.0". That is takings of nothing, not a failed read, and the
    // caller files it as a genuine zero.
    expect(parseAggregateAmountPence("0.0")).toBe(0);
    expect(parseAggregateAmountPence("0")).toBe(0);
    // Everything it cannot read exactly is null, so the panel says unavailable.
    for (const bad of ["", "  ", "n/a", "1,234.56", "1e3", "+27.9", ".9", "27.", "NaN", null, undefined, {}, []]) {
      expect(parseAggregateAmountPence(bad), `${JSON.stringify(bad)} must not parse`).toBeNull();
    }
  });

  it("refuses a figure too large to hold exactly", () => {
    expect(parseAggregateAmountPence("999999999999999999999.99")).toBeNull();
  });

  it("keeps refunds negative", () => {
    expect(parseAggregateAmountPence("-148846.6")).toBe(-14_884_660);
  });
});
