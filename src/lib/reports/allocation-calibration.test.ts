import { describe, it, expect } from "vitest";
import {
  CALIBRATED_ON,
  CHAIN_HIT_RATE,
  CHAIN_HIT_LEGS,
  CHAIN_TOTAL_LEGS,
  PRACTITIONER_COVERAGE,
  PAYMENT_VS_INVOICE_DISAGREEMENT,
  MONEY_UNALLOCATED_IN_DENTALLY,
  MONEY_ON_MULTI_PRACTITIONER_INVOICES,
  SAMPLE_PAYMENTS,
  SAMPLE_INVOICES,
  SUNDRY_LINES_SEEN,
  RUN_CHAIN_RATE_FLOOR,
  mayClaimTreatingClinician,
  FORBIDDEN_CLAIMS,
  CALIBRATION_BANNER_SEGMENTS,
  CALIBRATION_BANNER_TEXT,
} from "./allocation-calibration";

describe("the measured constants", () => {
  it("are the figures probed on 3 August 2026, with their sample sizes", () => {
    expect(CALIBRATED_ON).toBe("2026-08-03");
    expect(SAMPLE_PAYMENTS).toBe(2052);
    expect(SAMPLE_INVOICES).toBe(235);
    expect(CHAIN_HIT_LEGS).toBe(256);
    expect(CHAIN_TOTAL_LEGS).toBe(258);
    expect(CHAIN_HIT_RATE).toBeCloseTo(0.992, 3);
    expect(PRACTITIONER_COVERAGE).toBe(1);
    expect(PAYMENT_VS_INVOICE_DISAGREEMENT).toBeCloseTo(0.0702, 4);
    expect(MONEY_UNALLOCATED_IN_DENTALLY).toBe(0.2063);
    expect(MONEY_ON_MULTI_PRACTITIONER_INVOICES).toBe(0.112);
    expect(SUNDRY_LINES_SEEN).toBe(0);
  });
});

describe("mayClaimTreatingClinician", () => {
  it("licenses the claim only when THIS RUN also cleared the floor", () => {
    expect(RUN_CHAIN_RATE_FLOOR).toBe(0.95);
    expect(mayClaimTreatingClinician(1)).toBe(true);
    expect(mayClaimTreatingClinician(0.992)).toBe(true);
    expect(mayClaimTreatingClinician(0.95)).toBe(true);
    expect(mayClaimTreatingClinician(0.9499)).toBe(false);
    expect(mayClaimTreatingClinician(0)).toBe(false);
  });

  it("licenses nothing when the run had no legs at all", () => {
    // 0/0 is not 100%: an empty period proves nothing about the chain.
    expect(mayClaimTreatingClinician(null)).toBe(false);
  });
});

describe("the forbidden claims", () => {
  it("still forbids 'owed', the NHS split and sundries, each with its measurement", () => {
    const claims = FORBIDDEN_CLAIMS.map((f) => f.claim).join(" | ");
    expect(claims).toContain("owed");
    expect(claims).toContain("NHS");
    expect(claims).toContain("undries");
    expect(FORBIDDEN_CLAIMS).toHaveLength(3);
    for (const entry of FORBIDDEN_CLAIMS) expect(entry.because.length).toBeGreaterThan(30);
  });

  it("names the unreadable `closed` field as the reason 'owed' is forbidden", () => {
    const owed = FORBIDDEN_CLAIMS.find((f) => f.claim.includes("owed"));
    expect(owed?.because).toContain("closed");
    expect(owed?.because).toContain("2026-08-03");
    expect(owed?.because).toContain("20.6%");
  });
});

describe("the calibration-preview banner", () => {
  it("opens by saying it is not the pay run, in bold", () => {
    expect(CALIBRATION_BANNER_SEGMENTS[0]).toEqual({
      text: "Calibration preview — not the pay run.",
      emphasis: "strong",
    });
  });

  it("carries both of the two things it cannot do, verbatim", () => {
    expect(CALIBRATION_BANNER_TEXT).toContain(
      "20.6% of the money the practice took in the last 60 days is not allocated to anything in Dentally itself",
    );
    expect(CALIBRATION_BANNER_TEXT).toContain("no report can attribute it");
    expect(CALIBRATION_BANNER_TEXT).toContain('Dentally’s API exposes no "closed" field');
    expect(CALIBRATION_BANNER_TEXT).toContain("treatment_plans");
    expect(CALIBRATION_BANNER_TEXT).toContain("completed_at");
    expect(CALIBRATION_BANNER_TEXT).toContain("end_date");
    expect(CALIBRATION_BANNER_TEXT).toContain(
      "Dentally’s own reporting distinguishes completed from closed",
    );
  });

  it("states the sample sizes and the chain rate the method was measured at", () => {
    expect(CALIBRATION_BANNER_TEXT).toContain("2,052 payments and 235 invoices");
    expect(CALIBRATION_BANNER_TEXT).toContain("99.2% of allocations");
    expect(CALIBRATION_BANNER_TEXT).toContain("every invoice line carried a clinician");
    expect(CALIBRATION_BANNER_TEXT).toContain("3 August 2026");
  });

  it("ends on money received and attributed, never money owed", () => {
    expect(CALIBRATION_BANNER_TEXT).toContain(
      "these figures are money received and attributed, never money owed.",
    );
    expect(CALIBRATION_BANNER_SEGMENTS.filter((s) => s.emphasis === "em").map((s) => s.text)).toEqual([
      "money received and attributed",
      "money owed",
    ]);
  });

  it("never promises payable, approved, NHS or private", () => {
    const lower = CALIBRATION_BANNER_TEXT.toLowerCase();
    for (const banned of ["payable", "approved", "nhs", "private"]) {
      expect(lower).not.toContain(banned);
    }
  });

  it("is emphasis-annotated data, so the component adds no wording of its own", () => {
    expect(CALIBRATION_BANNER_SEGMENTS.length).toBeGreaterThan(5);
    for (const segment of CALIBRATION_BANNER_SEGMENTS) {
      expect(typeof segment.text).toBe("string");
      expect(segment.text.length).toBeGreaterThan(0);
      if (segment.emphasis !== undefined) {
        expect(["strong", "em", "code"]).toContain(segment.emphasis);
      }
    }
  });
});
