import { describe, it, expect } from "vitest";
import {
  normaliseAllocationPayment,
  normaliseAllocationPayments,
  explainedPence,
  derivedUnexplainedPence,
  distinctInvoiceIds,
  type AllocationPayment,
} from "./payment-explanations";
import { normalisePayment } from "@/lib/dashboard/normalise";

/** A live-shaped /v1/payments row: money as STRINGS, dated_on a bare day. */
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pay-1",
    amount: "120.0",
    dated_on: "2026-07-30",
    site_id: "site-cc",
    practitioner_id: "prac-1",
    patient_id: "pat-9",
    deleted: false,
    status: "paid",
    fully_explained: true,
    amount_unexplained: "0.0",
    explanations: [
      {
        id: "ex-1",
        amount: "120.0",
        comments: null,
        invoice_id: "inv-1",
        invoice_reference: "INV-1",
        payment_id: "pay-1",
        payment_reference: "P-1",
        user_id: "u-1",
      },
    ],
    ...over,
  };
}

function row(over: Partial<AllocationPayment> = {}): AllocationPayment {
  return {
    id: "p",
    day: "2026-07-30",
    amountPence: 12_000,
    amountUnexplainedPence: 0,
    fullyExplained: true,
    siteId: "site-cc",
    patientId: "pat-9",
    paymentPractitionerId: "prac-1",
    deleted: false,
    explanations: [{ invoiceId: "inv-1", amountPence: 12_000 }],
    ...over,
  };
}

describe("normaliseAllocationPayment", () => {
  it("reads the measured live row, legs and all", () => {
    const p = normaliseAllocationPayment(raw());
    expect(p).not.toBeNull();
    expect(p?.amountPence).toBe(12_000);
    expect(p?.day).toBe("2026-07-30");
    expect(p?.paymentPractitionerId).toBe("prac-1");
    expect(p?.amountUnexplainedPence).toBe(0);
    expect(p?.fullyExplained).toBe(true);
    expect(p?.explanations).toEqual([{ invoiceId: "inv-1", amountPence: 12_000 }]);
  });

  it("reads a leg with no invoice_id as a leg with a null invoice, not as no leg", () => {
    // 1.75% of money live: explained, but the explanation names no invoice.
    const p = normaliseAllocationPayment(
      raw({ explanations: [{ id: "ex-1", amount: "50.0", invoice_id: null }] }),
    );
    expect(p?.explanations).toEqual([{ invoiceId: null, amountPence: 5000 }]);
  });

  it("reads a payment with NO explanations key as zero legs — Dentally's own 'unallocated'", () => {
    const noKey = raw();
    delete noKey.explanations;
    const p = normaliseAllocationPayment(noKey);
    expect(p).not.toBeNull();
    expect(p?.explanations).toEqual([]);
    expect(derivedUnexplainedPence(p!)).toBe(12_000);
  });

  it("reads an EMPTY explanations array as zero legs", () => {
    const p = normaliseAllocationPayment(raw({ explanations: [] }));
    expect(p?.explanations).toEqual([]);
  });

  it("DROPS the whole payment when a leg amount is unreadable, never just the leg", () => {
    // Dropping the leg would move genuinely allocated money into the report's
    // "Not allocated in Dentally" row — a lie about the practice.
    const p = normaliseAllocationPayment(
      raw({ explanations: [{ amount: "120.0", invoice_id: "inv-1" }, { amount: "n/a", invoice_id: "inv-2" }] }),
    );
    expect(p).toBeNull();
  });

  it("refuses an explanations value that is present but not an array", () => {
    expect(normaliseAllocationPayment(raw({ explanations: { amount: "1.0" } }))).toBeNull();
    expect(normaliseAllocationPayment(raw({ explanations: [null] }))).toBeNull();
  });

  it("drops a row with no id, no readable amount or no day key", () => {
    expect(normaliseAllocationPayment(raw({ id: null }))).toBeNull();
    expect(normaliseAllocationPayment(raw({ amount: "" }))).toBeNull();
    expect(normaliseAllocationPayment(raw({ dated_on: "2026-07-30T00:00:00Z" }))).toBeNull();
    expect(normaliseAllocationPayment(null)).toBeNull();
  });

  it("carries amount_unexplained as REPORTED, nulling it when unreadable", () => {
    expect(normaliseAllocationPayment(raw({ amount_unexplained: "12.5" }))?.amountUnexplainedPence).toBe(1250);
    expect(normaliseAllocationPayment(raw({ amount_unexplained: null }))?.amountUnexplainedPence).toBeNull();
    expect(normaliseAllocationPayment(raw({ amount_unexplained: "n/a" }))?.amountUnexplainedPence).toBeNull();
    const noField = raw();
    delete noField.amount_unexplained;
    expect(normaliseAllocationPayment(noField)?.amountUnexplainedPence).toBeNull();
  });

  it("reads a refund's negative amount and negative leg", () => {
    const p = normaliseAllocationPayment(
      raw({ amount: "-40.0", explanations: [{ amount: "-40.0", invoice_id: "inv-1" }] }),
    );
    expect(p?.amountPence).toBe(-4000);
    expect(explainedPence(p!)).toBe(-4000);
    expect(derivedUnexplainedPence(p!)).toBe(0);
  });

  it("reads `deleted` so the report can exclude and count voided payments", () => {
    expect(normaliseAllocationPayment(raw({ deleted: true }))?.deleted).toBe(true);
    expect(normaliseAllocationPayment(raw({ deleted: "yes" }))?.deleted).toBe(false);
  });

  it("leaves the dashboard's own normaliser alone — the two agree on the shared fields", () => {
    // The takings strip depends on normalisePayment; this module is parallel to
    // it, not an extension of it.
    const dash = normalisePayment(raw());
    const alloc = normaliseAllocationPayment(raw());
    expect(dash?.amountPence).toBe(alloc?.amountPence);
    expect(dash?.day).toBe(alloc?.day);
    expect(dash?.practitionerId).toBe(alloc?.paymentPractitionerId);
    expect(dash).not.toHaveProperty("explanations");
  });
});

describe("normaliseAllocationPayments", () => {
  it("collects the drop count instead of hiding a bad row", () => {
    const { rows, dropped } = normaliseAllocationPayments([raw(), raw({ amount: "" }), raw({ id: "pay-2" })]);
    expect(rows).toHaveLength(2);
    expect(dropped).toBe(1);
  });
});

describe("derivedUnexplainedPence", () => {
  it("is derived from the legs, NOT from Dentally's amount_unexplained", () => {
    // Live disagrees with itself on one row in 2,052: fully_explained/
    // amount_unexplained said one thing and the legs summed to another. Only the
    // derived figure closes the no-money-vanishes identity.
    const p = row({ amountUnexplainedPence: 0, explanations: [{ invoiceId: "inv-1", amountPence: 9000 }] });
    expect(derivedUnexplainedPence(p)).toBe(3000);
  });

  it("goes negative when the legs over-explain, surfacing it rather than clamping", () => {
    const p = row({ explanations: [{ invoiceId: "inv-1", amountPence: 15_000 }] });
    expect(derivedUnexplainedPence(p)).toBe(-3000);
  });

  it("is the whole payment when there are no legs", () => {
    expect(derivedUnexplainedPence(row({ explanations: [] }))).toBe(12_000);
  });
});

describe("distinctInvoiceIds", () => {
  it("lists each invoice once, in first-seen order, skipping null links", () => {
    const payments = [
      row({ id: "a", explanations: [{ invoiceId: "inv-2", amountPence: 1 }, { invoiceId: null, amountPence: 1 }] }),
      row({ id: "b", explanations: [{ invoiceId: "inv-1", amountPence: 1 }, { invoiceId: "inv-2", amountPence: 1 }] }),
    ];
    expect(distinctInvoiceIds(payments)).toEqual(["inv-2", "inv-1"]);
  });

  it("is empty when nothing is linked", () => {
    expect(distinctInvoiceIds([row({ explanations: [] })])).toEqual([]);
  });
});
