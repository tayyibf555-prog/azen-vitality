import { describe, it, expect } from "vitest";
import {
  canonicalBand,
  classifyClaimOutcome,
  computeNhsBandReport,
  normaliseReportNhsClaim,
  normaliseReportNhsClaims,
  parseBandUdaConfig,
  udaForBand,
  BAND_KEYS,
  DEFAULT_BAND_UDA,
  type ReportNhsClaim,
} from "./nhs-activity";

// A minimal raw /v1/nhs_claims row, overridable per field.
function rawClaim(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "claim-1",
    expected_uda: "3.00",
    awarded_uda: "3.00",
    uda_band: "2",
    claim_status: "submitted",
    site_id: "site-cc",
    practitioner_id: "prac-1",
    patient_id: "pat-1",
    treatment_plan_id: "plan-1",
    submitted_date: "2026-08-10",
    approval_date: null,
    ...over,
  };
}

// A normalised claim, overridable, for driving the aggregator directly.
function claim(over: Partial<ReportNhsClaim> = {}): ReportNhsClaim {
  return {
    id: "c",
    siteId: "site-cc",
    practitionerId: "prac-1",
    day: "2026-08-10",
    band: "band2",
    rawBand: "2",
    status: "submitted",
    approvalDay: null,
    outcome: "awaiting",
    expectedUdaHundredths: 300,
    awardedUdaHundredths: 0,
    ...over,
  };
}

describe("canonicalBand", () => {
  it("maps the standard band strings, collapsing 2a/2b/2c into band2", () => {
    expect(canonicalBand("1")).toBe("band1");
    expect(canonicalBand("2")).toBe("band2");
    expect(canonicalBand("2a")).toBe("band2");
    expect(canonicalBand("2b")).toBe("band2");
    expect(canonicalBand("2c")).toBe("band2");
    expect(canonicalBand("3")).toBe("band3");
  });
  it("treats Dentally's 'Band 4' and 'urgent' as urgent", () => {
    expect(canonicalBand("urgent")).toBe("urgent");
    expect(canonicalBand("Urgent")).toBe("urgent");
    expect(canonicalBand("4")).toBe("urgent");
    expect(canonicalBand("Band 4")).toBe("urgent");
  });
  it("treats other/0 as other and anything unfamiliar as unknown (never guessed)", () => {
    expect(canonicalBand("other")).toBe("other");
    expect(canonicalBand("0")).toBe("other");
    expect(canonicalBand("")).toBe("unknown");
    expect(canonicalBand(null)).toBe("unknown");
    expect(canonicalBand("banana")).toBe("unknown");
  });
});

describe("parseBandUdaConfig / udaForBand", () => {
  it("defaults to the CHARTING.md mapping when nothing is configured", () => {
    const cfg = parseBandUdaConfig(undefined);
    expect(cfg).toEqual(DEFAULT_BAND_UDA);
    expect(udaForBand(cfg, "band1")).toBe(1);
    expect(udaForBand(cfg, "band3")).toBe(12);
  });
  it("lets the practice override the per-band UDA weight", () => {
    const cfg = parseBandUdaConfig("band1=1,band3=15,urgent=0");
    expect(udaForBand(cfg, "band3")).toBe(15);
    // A zero/blank override falls back to the default rather than becoming 0.
    expect(udaForBand(cfg, "band1")).toBe(1);
    // Unconfigured keys keep their default.
    expect(udaForBand(cfg, "band2")).toBe(DEFAULT_BAND_UDA.band2);
  });
  it("has no UDA weight for other/unknown", () => {
    const cfg = parseBandUdaConfig(undefined);
    expect(udaForBand(cfg, "other")).toBeNull();
    expect(udaForBand(cfg, "unknown")).toBeNull();
  });
});

describe("classifyClaimOutcome", () => {
  it("is approved when an approval date is present, whatever the status text", () => {
    expect(classifyClaimOutcome("submitted", "2026-08-20")).toBe("approved");
    expect(classifyClaimOutcome("approved", null)).toBe("approved");
  });
  it("is awaiting when submitted with no approval yet", () => {
    expect(classifyClaimOutcome("submitted", null)).toBe("awaiting");
  });
  it("is rejected for the invalid statuses", () => {
    expect(classifyClaimOutcome("rejected", null)).toBe("rejected");
    expect(classifyClaimOutcome("failed", null)).toBe("rejected");
  });
  it("is unrecognised for a status outside every known set", () => {
    expect(classifyClaimOutcome("awaiting_pcse_response", null)).toBe("unrecognised");
  });
});

describe("normaliseReportNhsClaim", () => {
  it("reads UDA strings to hundredths and derives the outcome", () => {
    const c = normaliseReportNhsClaim(rawClaim({ claim_status: "approved", approval_date: "2026-08-19" }));
    expect(c).not.toBeNull();
    expect(c!.expectedUdaHundredths).toBe(300);
    expect(c!.awardedUdaHundredths).toBe(300);
    expect(c!.band).toBe("band2");
    expect(c!.outcome).toBe("approved");
    expect(c!.approvalDay).toBe("2026-08-19");
  });
  it("drops a row with no id or an unreadable expected UDA (never counts it as zero)", () => {
    expect(normaliseReportNhsClaim(rawClaim({ id: null }))).toBeNull();
    expect(normaliseReportNhsClaim(rawClaim({ expected_uda: "" }))).toBeNull();
    expect(normaliseReportNhsClaim(rawClaim({ expected_uda: "n/a" }))).toBeNull();
  });
  it("counts drops across a batch", () => {
    const res = normaliseReportNhsClaims([rawClaim(), rawClaim({ id: null }), "nonsense"]);
    expect(res.rows).toHaveLength(1);
    expect(res.dropped).toBe(2);
  });
});

describe("computeNhsBandReport", () => {
  it("a clinician with only pending work shows zero completed", () => {
    const report = computeNhsBandReport({
      claims: [
        claim({ id: "a", practitionerId: "prac-9", outcome: "awaiting", awardedUdaHundredths: 0 }),
        claim({ id: "b", practitionerId: "prac-9", outcome: "awaiting", awardedUdaHundredths: 0 }),
      ],
    });
    const row = report.practitioners.find((p) => p.practitionerId === "prac-9");
    expect(row).toBeDefined();
    expect(row!.total.cotCount).toBe(2);
    expect(row!.total.awaitingCount).toBe(2);
    expect(row!.total.approvedCount).toBe(0);
    expect(row!.total.awardedUdaHundredths).toBe(0);
  });

  it("the band split sums to the grand total, every column", () => {
    const report = computeNhsBandReport({
      claims: [
        claim({ id: "1", band: "band1", outcome: "approved", expectedUdaHundredths: 100, awardedUdaHundredths: 100 }),
        claim({ id: "2", band: "band1", outcome: "awaiting", expectedUdaHundredths: 100, awardedUdaHundredths: 0 }),
        claim({ id: "3", band: "band2", outcome: "approved", expectedUdaHundredths: 300, awardedUdaHundredths: 300 }),
        claim({ id: "4", band: "band3", outcome: "rejected", expectedUdaHundredths: 1200, awardedUdaHundredths: 0 }),
        claim({ id: "5", band: "urgent", outcome: "unrecognised", expectedUdaHundredths: 120, awardedUdaHundredths: 0 }),
      ],
    });
    const bandSum = report.byBand.reduce(
      (acc, b) => ({
        cotCount: acc.cotCount + b.cotCount,
        approvedCount: acc.approvedCount + b.approvedCount,
        awaitingCount: acc.awaitingCount + b.awaitingCount,
        rejectedCount: acc.rejectedCount + b.rejectedCount,
        unrecognisedCount: acc.unrecognisedCount + b.unrecognisedCount,
        expectedUdaHundredths: acc.expectedUdaHundredths + b.expectedUdaHundredths,
        awardedUdaHundredths: acc.awardedUdaHundredths + b.awardedUdaHundredths,
      }),
      {
        cotCount: 0,
        approvedCount: 0,
        awaitingCount: 0,
        rejectedCount: 0,
        unrecognisedCount: 0,
        expectedUdaHundredths: 0,
        awardedUdaHundredths: 0,
      },
    );
    expect(bandSum).toEqual(report.grandTotal);
    expect(report.grandTotal.cotCount).toBe(5);
    expect(report.grandTotal.expectedUdaHundredths).toBe(1820);
    expect(report.grandTotal.awardedUdaHundredths).toBe(400);
  });

  it("each practitioner's totals sum to the grand total", () => {
    const report = computeNhsBandReport({
      claims: [
        claim({ id: "1", practitionerId: "prac-1", band: "band1" }),
        claim({ id: "2", practitionerId: "prac-2", band: "band2" }),
        claim({ id: "3", practitionerId: "prac-2", band: "band2" }),
        claim({ id: "4", practitionerId: null, band: "band1" }),
      ],
    });
    const totalCot = report.practitioners.reduce((n, p) => n + p.total.cotCount, 0);
    expect(totalCot).toBe(report.grandTotal.cotCount);
    expect(report.grandTotal.cotCount).toBe(4);
    // A claim with no practitioner is grouped under its own null row, never dropped.
    expect(report.practitioners.some((p) => p.practitionerId === null)).toBe(true);
  });

  it("counts distinct claims/COTs, so a repeated id does not inflate the count", () => {
    const report = computeNhsBandReport({
      claims: [claim({ id: "dup" }), claim({ id: "dup" }), claim({ id: "other" })],
    });
    expect(report.grandTotal.cotCount).toBe(2);
  });

  it("scopes by window on the submitted day, excluding claims with no day", () => {
    const report = computeNhsBandReport({
      claims: [
        claim({ id: "in", day: "2026-08-10" }),
        claim({ id: "out", day: "2026-07-01" }),
        claim({ id: "noday", day: null }),
      ],
      window: { from: "2026-08-01", to: "2026-08-31" },
    });
    expect(report.grandTotal.cotCount).toBe(1);
  });

  it("filters by practitioner and by band when asked", () => {
    const claims = [
      claim({ id: "1", practitionerId: "prac-1", band: "band1" }),
      claim({ id: "2", practitionerId: "prac-2", band: "band1" }),
      claim({ id: "3", practitionerId: "prac-1", band: "band2" }),
    ];
    expect(computeNhsBandReport({ claims, practitionerId: "prac-1" }).grandTotal.cotCount).toBe(2);
    expect(computeNhsBandReport({ claims, band: "band1" }).grandTotal.cotCount).toBe(2);
    expect(
      computeNhsBandReport({ claims, practitionerId: "prac-1", band: "band1" }).grandTotal.cotCount,
    ).toBe(1);
  });

  it("surfaces unrecognised statuses for calibration rather than hiding them", () => {
    const c = normaliseReportNhsClaim(rawClaim({ claim_status: "awaiting_pcse_response" }))!;
    const report = computeNhsBandReport({ claims: [c] });
    expect(report.grandTotal.unrecognisedCount).toBe(1);
    expect(report.unknownStatuses).toContain("awaiting_pcse_response");
  });

  it("orders byBand by the canonical band order", () => {
    const report = computeNhsBandReport({
      claims: [claim({ id: "u", band: "urgent" }), claim({ id: "b1", band: "band1" })],
    });
    const order = report.byBand.map((b) => b.band);
    const expectedOrder = BAND_KEYS.filter((k) => order.includes(k));
    expect(order).toEqual(expectedOrder);
  });
});
