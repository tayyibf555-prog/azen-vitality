import { describe, expect, it } from "vitest";

import type { DashboardNhsClaim } from "@/lib/dashboard/normalise";
import {
  claimStatusKey,
  computeUdaByPractitioner,
  computeUdaProgress,
  computeUdaTotals,
  nhsContractYear,
} from "@/lib/dashboard/uda";

const NOW = new Date("2026-07-30T09:00:00Z");

function claim(over: Partial<DashboardNhsClaim> & { id: string }): DashboardNhsClaim {
  return {
    siteId: "site-cc",
    practitionerId: "prac-1",
    day: "2026-07-20",
    expectedUdaHundredths: 300,
    awardedUdaHundredths: 300,
    status: "submitted",
    band: "2",
    ...over,
  };
}

describe("claimStatusKey", () => {
  it("reduces a status to a comparable key", () => {
    expect(claimStatusKey("Submitted")).toBe("submitted");
    expect(claimStatusKey(" FP17 Rejected ")).toBe("fp17_rejected");
  });
});

describe("computeUdaTotals", () => {
  it("counts awarded UDAs as completed and expected UDAs on rejected claims as invalid", () => {
    const totals = computeUdaTotals({
      claims: [
        claim({ id: "c1", expectedUdaHundredths: 300, awardedUdaHundredths: 300 }),
        claim({ id: "c2", expectedUdaHundredths: 1200, awardedUdaHundredths: 1200, status: "approved" }),
        claim({ id: "c3", expectedUdaHundredths: 100, awardedUdaHundredths: 0, status: "rejected" }),
      ],
    });
    expect(totals.completedUda).toBe(15);
    expect(totals.invalidUda).toBe(1);
    expect(totals.claimCount).toBe(2);
    expect(totals.invalidClaimCount).toBe(1);
  });

  it("sums fractional UDAs exactly, where floats would drift", () => {
    const claims = Array.from({ length: 100 }, (_, i) =>
      claim({ id: `c${i}`, expectedUdaHundredths: 156, awardedUdaHundredths: 156 }),
    );
    expect(computeUdaTotals({ claims }).completedUda).toBe(156);
  });

  it("counts an unrecognised status toward neither figure and reports it", () => {
    const totals = computeUdaTotals({
      claims: [claim({ id: "c1" }), claim({ id: "c2", status: "awaiting_triage_review" })],
    });
    expect(totals.completedUda).toBe(3);
    expect(totals.invalidUda).toBe(0);
    expect(totals.unrecognisedClaimCount).toBe(1);
    expect(totals.unknownStatuses).toEqual(["awaiting_triage_review"]);
  });

  it("accepts a contract-specific invalid status list", () => {
    const totals = computeUdaTotals({
      claims: [claim({ id: "c1", status: "clawback", expectedUdaHundredths: 250 })],
      invalidStatuses: ["clawback"],
    });
    expect(totals.invalidUda).toBe(2.5);
    expect(totals.invalidClaimCount).toBe(1);
  });

  it("scopes by window, site and practitioner", () => {
    const claims = [
      claim({ id: "c1", day: "2026-07-20", siteId: "site-cc", practitionerId: "prac-1" }),
      claim({ id: "c2", day: "2026-07-20", siteId: "site-rv", practitionerId: "prac-2" }),
      claim({ id: "c3", day: "2026-05-01", siteId: "site-cc", practitionerId: "prac-1" }),
    ];
    expect(computeUdaTotals({ claims }).completedUda).toBe(9);
    expect(
      computeUdaTotals({ claims, window: { from: "2026-07-01", to: "2026-07-31" } }).completedUda,
    ).toBe(6);
    expect(computeUdaTotals({ claims, siteId: "site-cc" }).completedUda).toBe(6);
    expect(computeUdaTotals({ claims, practitionerId: "prac-2" }).completedUda).toBe(3);
  });

  it("excludes a claim with no submitted date from a windowed total rather than assuming it is inside", () => {
    const claims = [claim({ id: "c1", day: null })];
    expect(computeUdaTotals({ claims }).completedUda).toBe(3);
    expect(computeUdaTotals({ claims, window: { from: "2026-07-01", to: "2026-07-31" } }).completedUda).toBe(0);
  });
});

describe("computeUdaByPractitioner", () => {
  it("breaks the practice total down, largest first", () => {
    const rows = computeUdaByPractitioner({
      claims: [
        claim({ id: "c1", practitionerId: "prac-1", awardedUdaHundredths: 300 }),
        claim({ id: "c2", practitionerId: "prac-2", awardedUdaHundredths: 1200 }),
        claim({ id: "c3", practitionerId: "prac-2", awardedUdaHundredths: 100 }),
        claim({ id: "c4", practitionerId: null, awardedUdaHundredths: 50 }),
      ],
    });
    expect(rows.map((r) => [r.practitionerId, r.completedUda])).toEqual([
      ["prac-2", 13],
      ["prac-1", 3],
      [null, 0.5],
    ]);
  });

  it("adds up to the practice-wide figure", () => {
    const claims = [
      claim({ id: "c1", practitionerId: "prac-1", awardedUdaHundredths: 156 }),
      claim({ id: "c2", practitionerId: "prac-2", awardedUdaHundredths: 344 }),
    ];
    const practice = computeUdaTotals({ claims });
    const perPractitioner = computeUdaByPractitioner({ claims });
    const summed = perPractitioner.reduce((acc, r) => acc + r.completedUda, 0);
    expect(summed).toBeCloseTo(practice.completedUda, 10);
  });
});

describe("nhsContractYear", () => {
  it("runs 1 April to 31 March", () => {
    expect(nhsContractYear(new Date("2026-07-30T09:00:00Z"))).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
    });
    expect(nhsContractYear(new Date("2026-03-31T09:00:00Z"))).toEqual({
      start: "2025-04-01",
      end: "2026-03-31",
    });
    expect(nhsContractYear(new Date("2026-04-01T09:00:00Z"))).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
    });
  });

  it("uses the London day at the year boundary, not the UTC day", () => {
    // 2026-03-31 23:30 UTC is 2026-04-01 00:30 in London: a new contract year.
    expect(nhsContractYear(new Date("2026-03-31T23:30:00Z")).start).toBe("2026-04-01");
  });
});

describe("computeUdaProgress", () => {
  it("reports progress and pace against the annual target", () => {
    // 2026-04-01 to 2027-03-31 is 365 days; 2026-07-30 is day 121.
    const progress = computeUdaProgress({ completedUda: 2000, targetUda: 6000, now: NOW });
    expect(progress).not.toBeNull();
    expect(progress?.daysTotal).toBe(365);
    expect(progress?.daysElapsed).toBe(121);
    expect(progress?.daysRemaining).toBe(244);
    expect(progress?.percentOfTarget).toBe(33.33);
    expect(progress?.expectedUdaByNow).toBe(1989.04);
    expect(progress?.varianceUda).toBe(10.96);
    expect(progress?.onTrack).toBe(true);
  });

  it("flags a practice behind pace, and says what it now needs per day", () => {
    const progress = computeUdaProgress({ completedUda: 1200, targetUda: 6000, now: NOW });
    expect(progress?.onTrack).toBe(false);
    expect(progress?.varianceUda).toBe(round(1200 - (6000 * 121) / 365));
    expect(progress?.requiredUdaPerDay).toBe(round(4800 / 244));
    expect(progress?.projectedYearEndUda).toBe(round((1200 / 121) * 365));
    expect(progress?.projectedShortfallUda).toBeGreaterThan(0);
  });

  it("reports no shortfall when the projection beats the target", () => {
    const progress = computeUdaProgress({ completedUda: 3000, targetUda: 6000, now: NOW });
    expect(progress?.projectedShortfallUda).toBe(0);
    expect(progress?.requiredUdaPerDay).toBe(round(3000 / 244));
  });

  it("asks for nothing more once the target is already met", () => {
    const progress = computeUdaProgress({ completedUda: 7000, targetUda: 6000, now: NOW });
    expect(progress?.requiredUdaPerDay).toBe(0);
    expect(progress?.percentOfTarget).toBe(116.67);
    expect(progress?.onTrack).toBe(true);
  });

  it("returns null rather than inventing a percentage when there is no target", () => {
    expect(computeUdaProgress({ completedUda: 2000, targetUda: 0, now: NOW })).toBeNull();
    expect(computeUdaProgress({ completedUda: 2000, targetUda: -1, now: NOW })).toBeNull();
    expect(computeUdaProgress({ completedUda: 2000, targetUda: Number.NaN, now: NOW })).toBeNull();
  });

  it("never divides by zero on the first day of the contract year", () => {
    const firstDay = computeUdaProgress({
      completedUda: 12,
      targetUda: 6000,
      now: new Date("2026-04-01T09:00:00Z"),
    });
    expect(firstDay?.daysElapsed).toBe(1);
    expect(firstDay?.paceUdaPerDay).toBe(12);
    expect(firstDay?.daysRemaining).toBe(364);
  });

  it("stops asking for a daily rate once the year has closed", () => {
    const lastDay = computeUdaProgress({
      completedUda: 5900,
      targetUda: 6000,
      now: new Date("2027-03-31T09:00:00Z"),
    });
    expect(lastDay?.daysRemaining).toBe(0);
    expect(lastDay?.requiredUdaPerDay).toBeNull();
    expect(lastDay?.onTrack).toBe(false);
  });

  it("accepts a contract year that does not run April to March", () => {
    const progress = computeUdaProgress({
      completedUda: 100,
      targetUda: 1000,
      now: NOW,
      contractYear: { start: "2026-07-01", end: "2026-07-31" },
    });
    expect(progress?.daysTotal).toBe(31);
    expect(progress?.daysElapsed).toBe(30);
  });
});

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
