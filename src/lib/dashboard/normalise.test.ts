import { describe, expect, it } from "vitest";

import {
  normaliseAccountBalance,
  normaliseAccountBalances,
  normaliseAppointment,
  normaliseAppointments,
  normaliseNhsClaim,
  normaliseNhsClaims,
  normalisePatient,
  normalisePayment,
  normalisePayments,
  normaliseTreatmentPlan,
} from "@/lib/dashboard/normalise";

/** A payment in exactly the shape the live API returns. */
function payment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pay-1",
    amount: "27.9",
    dated_on: "2026-07-29",
    site_id: "site-cc",
    practitioner_id: "prac-1",
    patient_id: "pat-001",
    payment_plan_id: null,
    method: "Debit Card",
    deleted: false,
    status: "complete",
    account_id: "acc-1",
    reference: "ref-1",
    transaction_number: "1001",
    ...overrides,
  };
}

describe("normalisePayment", () => {
  it("reads the live field names and string amount", () => {
    expect(normalisePayment(payment())).toEqual({
      id: "pay-1",
      amountPence: 2790,
      day: "2026-07-29",
      siteId: "site-cc",
      practitionerId: "prac-1",
      patientId: "pat-001",
      deleted: false,
    });
  });

  it("drops a row whose amount cannot be parsed, rather than counting it as zero", () => {
    expect(normalisePayment(payment({ amount: "" }))).toBeNull();
    expect(normalisePayment(payment({ amount: "n/a" }))).toBeNull();
    expect(normalisePayment(payment({ amount: null }))).toBeNull();
  });

  it("drops a row with no usable dated_on", () => {
    expect(normalisePayment(payment({ dated_on: "29/07/2026" }))).toBeNull();
    expect(normalisePayment(payment({ dated_on: "2026-07-29T00:00:00Z" }))).toBeNull();
    expect(normalisePayment(payment({ dated_on: null }))).toBeNull();
  });

  it("drops a row with no id, and anything that is not an object", () => {
    expect(normalisePayment(payment({ id: null }))).toBeNull();
    expect(normalisePayment(null)).toBeNull();
    expect(normalisePayment("payment")).toBeNull();
    expect(normalisePayment([payment()])).toBeNull();
  });

  it("keeps the deleted flag rather than silently discarding the row", () => {
    expect(normalisePayment(payment({ deleted: true }))?.deleted).toBe(true);
  });

  it("keeps a refund as a negative amount", () => {
    expect(normalisePayment(payment({ amount: "-40.00" }))?.amountPence).toBe(-4000);
  });

  it("counts the drops across a batch", () => {
    const { rows, dropped } = normalisePayments([
      payment(),
      payment({ id: "pay-2", amount: "oops" }),
      payment({ id: "pay-3", amount: "10" }),
      "junk",
    ]);
    expect(rows.map((r) => r.id)).toEqual(["pay-1", "pay-3"]);
    expect(dropped).toBe(2);
  });
});

describe("normaliseAppointment", () => {
  it("buckets start_time on its London day", () => {
    const row = normaliseAppointment({
      id: "appt-1",
      start_time: "2026-07-30T23:30:00Z",
      site_id: "site-cc",
      practitioner_id: "prac-1",
      patient_id: "pat-001",
      state: "Completed",
    });
    expect(row?.day).toBe("2026-07-31");
    expect(row?.state).toBe("Completed");
  });

  it("drops a row with no parseable start_time", () => {
    expect(normaliseAppointment({ id: "a", start_time: "nope" })).toBeNull();
    expect(normaliseAppointment({ id: "a" })).toBeNull();
  });

  it("counts the drops across a batch", () => {
    const { rows, dropped } = normaliseAppointments([
      { id: "a1", start_time: "2026-07-30T09:00:00Z", state: "Completed" },
      { id: "a2" },
    ]);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

describe("normaliseAccountBalance", () => {
  it("reads amount_outstanding and composes a name", () => {
    expect(
      normaliseAccountBalance({
        patient_id: "pat-001",
        first_name: "Eleanor",
        last_name: "Whitfield",
        amount_outstanding: "1500.00",
      }),
    ).toEqual({ patientId: "pat-001", patientName: "Eleanor Whitfield", owedPence: 150000 });
  });

  it("falls back to outstanding, then balance", () => {
    expect(normaliseAccountBalance({ patient_id: "p", outstanding: "12.50" })?.owedPence).toBe(1250);
    expect(normaliseAccountBalance({ patient_id: "p", balance: "-30" })?.owedPence).toBe(-3000);
  });

  it("drops a row with no balance field at all rather than reading it as settled", () => {
    expect(normaliseAccountBalance({ patient_id: "p" })).toBeNull();
    expect(normaliseAccountBalance({ patient_id: "p", amount_outstanding: "??" })).toBeNull();
  });

  it("counts the drops across a batch", () => {
    const { rows, dropped } = normaliseAccountBalances([
      { patient_id: "p1", amount_outstanding: "10" },
      { patient_id: "p2" },
    ]);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

describe("normalisePatient", () => {
  it("reads created_at as either a day key or an instant", () => {
    expect(normalisePatient({ id: "p", created_at: "2026-07-01" })?.createdDay).toBe("2026-07-01");
    expect(normalisePatient({ id: "p", created_at: "2026-07-30T23:30:00Z" })?.createdDay).toBe("2026-07-31");
  });

  it("reports a missing created_at or active flag as absent, not as a value", () => {
    const row = normalisePatient({ id: "p" });
    expect(row?.createdDay).toBeNull();
    expect(row?.active).toBeNull();
    expect(row?.archived).toBe(false);
  });
});

describe("normaliseTreatmentPlan", () => {
  it("prefers accepted_at as the start and records that a finish field exists", () => {
    const row = normaliseTreatmentPlan({
      id: "plan-1",
      site_id: "site-cc",
      accepted_at: "2026-06-02T13:30:00Z",
      created_at: "2026-05-01T09:00:00Z",
      completed_at: null,
    });
    expect(row?.startedDay).toBe("2026-06-02");
    expect(row?.finishedDay).toBeNull();
    expect(row?.hasFinishField).toBe(true);
  });

  it("reports a source with no finish field at all as unable to answer", () => {
    const row = normaliseTreatmentPlan({ id: "plan-1", accepted_at: "2026-06-02T13:30:00Z" });
    expect(row?.hasFinishField).toBe(false);
  });
});

/** An NHS claim in exactly the shape the live API returns. */
function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "claim-1",
    expected_uda: "1.56",
    awarded_uda: "1.56",
    uda_band: "1",
    claim_status: "submitted",
    site_id: "site-cc",
    practitioner_id: "prac-1",
    patient_id: "pat-001",
    treatment_plan_id: "plan-1",
    submitted_date: "2026-07-20",
    approval_date: null,
    patient_charge: "27.40",
    dentist_charge: "0.0",
    contract_id: "contract-1",
    ortho: false,
    triage: false,
    ...overrides,
  };
}

describe("normaliseNhsClaim", () => {
  it("reads the string UDA fields into exact hundredths", () => {
    const row = normaliseNhsClaim(claim());
    expect(row?.expectedUdaHundredths).toBe(156);
    expect(row?.awardedUdaHundredths).toBe(156);
    expect(row?.day).toBe("2026-07-20");
    expect(row?.status).toBe("submitted");
  });

  it("treats a null awarded_uda as nothing awarded yet, not as unreadable", () => {
    expect(normaliseNhsClaim(claim({ awarded_uda: null }))?.awardedUdaHundredths).toBe(0);
  });

  it("drops a claim with no readable expected_uda", () => {
    expect(normaliseNhsClaim(claim({ expected_uda: "" }))).toBeNull();
    expect(normaliseNhsClaim(claim({ expected_uda: "pending" }))).toBeNull();
  });

  it("drops a claim whose awarded_uda is present but unreadable", () => {
    expect(normaliseNhsClaim(claim({ awarded_uda: "n/a" }))).toBeNull();
  });

  it("counts the drops across a batch", () => {
    const { rows, dropped } = normaliseNhsClaims([claim(), claim({ id: "c2", expected_uda: "x" })]);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});
