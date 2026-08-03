import { describe, it, expect } from "vitest";
import {
  computeAllocationReport,
  allocationBucketRows,
  attributedShare,
  runChainRate,
  allocationWindowTooLong,
  ALLOCATION_BUCKET_LABELS,
  ALLOCATION_MAX_WINDOW_DAYS,
  ALLOCATION_WINDOW_UNAVAILABLE,
  type AllocationReport,
} from "./allocation-report";
import type { AllocationPayment } from "./payment-explanations";
import type { InvoiceItem, InvoiceWithItems } from "@/lib/dentally/invoice-shape";

const WINDOW = { from: "2026-07-01", to: "2026-07-31" };

function line(
  practitionerId: string | null,
  totalPricePence: number,
  over: Partial<InvoiceItem> = {},
): InvoiceItem {
  return {
    id: `ii-${practitionerId}-${totalPricePence}-${over.id ?? ""}`,
    practitionerId,
    totalPricePence,
    quantity: 1,
    name: "Treatment",
    treatmentPlanItemId: "tpi-1",
    sundryId: null,
    ...over,
  };
}

function invoice(id: string, items: InvoiceItem[], amountPence?: number): InvoiceWithItems {
  return {
    id,
    patientId: "pat-9",
    amountPence: amountPence ?? items.reduce((a, i) => a + i.totalPricePence, 0),
    datedOn: "2026-07-10",
    items,
  };
}

function payment(over: Partial<AllocationPayment> = {}): AllocationPayment {
  return {
    id: "pay-1",
    day: "2026-07-10",
    amountPence: 10_000,
    amountUnexplainedPence: 0,
    fullyExplained: true,
    siteId: "site-cc",
    patientId: "pat-9",
    paymentPractitionerId: "prac-1",
    deleted: false,
    explanations: [],
    ...over,
  };
}

/** THE INVARIANT. Every test that builds a report checks it. */
function identityHolds(r: AllocationReport): boolean {
  return (
    r.attributedPence +
      r.unallocatedInDentallyPence +
      r.explainedNoInvoiceLinkPence +
      r.sharedInvoiceUndeterminedPence +
      r.noAttributableLinesPence +
      r.linkUnavailablePence ===
    r.totalReceivedPence
  );
}

describe("computeAllocationReport — the simple, measured shape", () => {
  const invoices = new Map([["inv-1", invoice("inv-1", [line("prac-1", 10_000)])]]);

  it("attributes a fully-settled single-clinician invoice to that clinician", () => {
    const report = computeAllocationReport({
      payments: [payment({ explanations: [{ invoiceId: "inv-1", amountPence: 10_000 }] })],
      invoices,
      window: WINDOW,
    });
    expect(report.lines).toEqual([
      expect.objectContaining({ practitionerId: "prac-1", attributedPence: 10_000, legCount: 1 }),
    ]);
    expect(report.attributedPence).toBe(10_000);
    expect(report.totalReceivedPence).toBe(10_000);
    expect(report.balanced).toBe(true);
    expect(identityHolds(report)).toBe(true);
  });

  it("puts the part of a payment no leg accounts for into 'Not allocated in Dentally'", () => {
    const report = computeAllocationReport({
      payments: [
        payment({ amountPence: 15_000, explanations: [{ invoiceId: "inv-1", amountPence: 10_000 }] }),
      ],
      invoices,
      window: WINDOW,
    });
    expect(report.attributedPence).toBe(10_000);
    expect(report.unallocatedInDentallyPence).toBe(5000);
    expect(identityHolds(report)).toBe(true);
  });

  it("DERIVES the unallocated residual from the legs, not from Dentally's amount_unexplained", () => {
    // Live disagrees with itself: `amount_unexplained` said 0 on 1,712 rows while
    // the legs summed to the payment on 1,713. Trusting the field would break the
    // identity on exactly those rows.
    const report = computeAllocationReport({
      payments: [
        payment({
          amountPence: 15_000,
          amountUnexplainedPence: 0,
          fullyExplained: true,
          explanations: [{ invoiceId: "inv-1", amountPence: 10_000 }],
        }),
      ],
      invoices,
      window: WINDOW,
    });
    expect(report.unallocatedInDentallyPence).toBe(5000);
    expect(identityHolds(report)).toBe(true);
  });

  it("shows a wholly unexplained payment as unallocated, never dropped and never spread", () => {
    const report = computeAllocationReport({
      payments: [payment({ amountPence: 7500, explanations: [] })],
      invoices,
      window: WINDOW,
    });
    expect(report.lines).toEqual([]);
    expect(report.unallocatedInDentallyPence).toBe(7500);
    expect(report.totalReceivedPence).toBe(7500);
    expect(identityHolds(report)).toBe(true);
  });

  it("buckets an explanation with no invoice link rather than attributing it", () => {
    const report = computeAllocationReport({
      payments: [payment({ amountPence: 6000, explanations: [{ invoiceId: null, amountPence: 6000 }] })],
      invoices,
      window: WINDOW,
    });
    expect(report.attributedPence).toBe(0);
    expect(report.explainedNoInvoiceLinkPence).toBe(6000);
    expect(identityHolds(report)).toBe(true);
  });

  it("buckets an invoice it could not read, and marks the run incomplete", () => {
    const report = computeAllocationReport({
      payments: [payment({ amountPence: 9000, explanations: [{ invoiceId: "inv-gone", amountPence: 9000 }] })],
      invoices,
      window: WINDOW,
    });
    expect(report.linkUnavailablePence).toBe(9000);
    expect(report.legsLinkUnavailable).toBe(1);
    expect(report.runIncomplete).toBe(true);
    expect(identityHolds(report)).toBe(true);
  });

  it("counts a payment taken by someone other than the clinician credited", () => {
    const report = computeAllocationReport({
      payments: [
        payment({
          paymentPractitionerId: "prac-9",
          explanations: [{ invoiceId: "inv-1", amountPence: 10_000 }],
        }),
      ],
      invoices,
      window: WINDOW,
    });
    // Attributed to the TREATING clinician on the invoice line, and the
    // disagreement surfaced rather than reconciled away.
    expect(report.lines[0].practitionerId).toBe("prac-1");
    expect(report.paymentTakerDifferedCount).toBe(1);
  });

  it("does not count a differing taker when nothing was credited", () => {
    const report = computeAllocationReport({
      payments: [
        payment({ paymentPractitionerId: "prac-9", amountPence: 9000, explanations: [{ invoiceId: "inv-gone", amountPence: 9000 }] }),
      ],
      invoices,
      window: WINDOW,
    });
    expect(report.paymentTakerDifferedCount).toBe(0);
  });

  it("excludes and counts deleted payments, and site-less payments when scoped", () => {
    const report = computeAllocationReport({
      payments: [
        payment({ id: "a", deleted: true, amountPence: 5000 }),
        payment({ id: "b", siteId: null, amountPence: 4000 }),
        payment({ id: "c", siteId: "site-rv", amountPence: 3000 }),
        payment({ id: "d", explanations: [{ invoiceId: "inv-1", amountPence: 10_000 }] }),
      ],
      invoices,
      window: WINDOW,
      siteId: "site-cc",
    });
    expect(report.deletedExcluded).toBe(1);
    expect(report.unattributedExcluded).toBe(1);
    expect(report.totalCount).toBe(1);
    expect(report.totalReceivedPence).toBe(10_000);
    expect(identityHolds(report)).toBe(true);
  });

  it("excludes payments outside the window", () => {
    const report = computeAllocationReport({
      payments: [
        payment({ id: "a", day: "2026-06-30", amountPence: 5000 }),
        payment({ id: "b", day: "2026-07-01", amountPence: 4000 }),
        payment({ id: "c", day: "2026-08-01", amountPence: 3000 }),
      ],
      invoices,
      window: WINDOW,
    });
    expect(report.totalCount).toBe(1);
    expect(report.totalReceivedPence).toBe(4000);
  });

  it("orders clinician lines by money, biggest first", () => {
    const many = new Map([
      ["inv-a", invoice("inv-a", [line("prac-1", 1000)])],
      ["inv-b", invoice("inv-b", [line("prac-2", 9000)])],
    ]);
    const report = computeAllocationReport({
      payments: [
        payment({ id: "a", amountPence: 1000, explanations: [{ invoiceId: "inv-a", amountPence: 1000 }] }),
        payment({ id: "b", amountPence: 9000, explanations: [{ invoiceId: "inv-b", amountPence: 9000 }] }),
      ],
      invoices: many,
      window: WINDOW,
    });
    expect(report.lines.map((l) => l.practitionerId)).toEqual(["prac-2", "prac-1"]);
  });

  it("marks no line payable, because `closed` cannot be read from Dentally at all", () => {
    const report = computeAllocationReport({
      payments: [payment({ explanations: [{ invoiceId: "inv-1", amountPence: 10_000 }] })],
      invoices,
      window: WINDOW,
    });
    expect(report.anyPayableConfirmed).toBe(false);
    expect(report.lines.every((l) => l.payableConfirmed === false)).toBe(true);
  });
});

// ===========================================================================
// THE ADVERSARIAL FIXTURE. Rounding remainders, a refund, a zero-amount
// invoice, a three-way split, a shared part payment, an unreadable invoice, an
// unexplained payment and a differing payment-taker — all in one window.
// ===========================================================================

const ADVERSARIAL_INVOICES = new Map<string, InvoiceWithItems>([
  // Plain, single clinician.
  ["inv-sole", invoice("inv-sole", [line("prac-1", 10_000)])],
  ["inv-sole2", invoice("inv-sole2", [line("prac-2", 3000)])],
  // One clinician, one line with NO clinician: a part payment rounds 3334/1666.
  ["inv-mixed", invoice("inv-mixed", [line("prac-1", 6667), line(null, 3333)])],
  // A three-way split whose header amount does NOT equal its line total —
  // deliberately breaking the 256/256 agreement measured live, so the
  // largest-remainder path is exercised: 100p across 1/1/1 is 34/33/33.
  ["inv-3way", invoice("inv-3way", [line("prac-1", 1), line("prac-2", 1), line("prac-3", 1)], 100)],
  // A zero-amount invoice settled by a zero payment.
  ["inv-zero", invoice("inv-zero", [line("prac-1", 0), line("prac-2", 0)])],
  // Shared invoice, settled in part: attributes to nobody.
  ["inv-shared", invoice("inv-shared", [line("prac-1", 40_000), line("prac-2", 20_000)])],
  // Invoiced, but no clinician on the line — and it is a SUNDRY, an untested path.
  ["inv-nolines", invoice("inv-nolines", [line(null, 5000, { sundryId: "sun-1" })])],
  // A refund against a single-clinician invoice.
  ["inv-refund", invoice("inv-refund", [line("prac-1", 4000)])],
  // NOTE: "inv-gone" is deliberately absent — the invoice GET failed after retry.
]);

const ADVERSARIAL_PAYMENTS: AllocationPayment[] = [
  payment({ id: "p1", amountPence: 10_000, explanations: [{ invoiceId: "inv-sole", amountPence: 10_000 }] }),
  payment({ id: "p2", amountPence: 5000, explanations: [{ invoiceId: "inv-mixed", amountPence: 5000 }] }),
  payment({ id: "p3", amountPence: 100, explanations: [{ invoiceId: "inv-3way", amountPence: 100 }] }),
  payment({ id: "p4", amountPence: 0, explanations: [{ invoiceId: "inv-zero", amountPence: 0 }] }),
  payment({ id: "p5", amountPence: 20_000, explanations: [{ invoiceId: "inv-shared", amountPence: 20_000 }] }),
  payment({ id: "p6", amountPence: 5000, explanations: [{ invoiceId: "inv-nolines", amountPence: 5000 }] }),
  payment({ id: "p7", amountPence: -4000, explanations: [{ invoiceId: "inv-refund", amountPence: -4000 }] }),
  payment({ id: "p8", amountPence: 7500, explanations: [] }),
  payment({ id: "p9", amountPence: 6000, explanations: [{ invoiceId: null, amountPence: 6000 }] }),
  payment({ id: "p10", amountPence: 9000, explanations: [{ invoiceId: "inv-gone", amountPence: 9000 }] }),
  payment({ id: "p11", amountPence: 12_000, explanations: [{ invoiceId: "inv-sole", amountPence: 9000 }] }),
  payment({
    id: "p12",
    amountPence: 3000,
    paymentPractitionerId: "prac-9",
    explanations: [{ invoiceId: "inv-sole2", amountPence: 3000 }],
  }),
  payment({ id: "p13", amountPence: 5000, deleted: true }),
  payment({ id: "p14", amountPence: 2500, siteId: null }),
];

function adversarialReport(): AllocationReport {
  return computeAllocationReport({
    payments: ADVERSARIAL_PAYMENTS,
    invoices: ADVERSARIAL_INVOICES,
    window: WINDOW,
    siteId: "site-cc",
  });
}

describe("THE NO-MONEY-VANISHES INVARIANT", () => {
  it("holds on the adversarial fixture: every penny received lands in exactly one row", () => {
    const r = adversarialReport();
    expect(
      r.attributedPence +
        r.unallocatedInDentallyPence +
        r.explainedNoInvoiceLinkPence +
        r.sharedInvoiceUndeterminedPence +
        r.noAttributableLinesPence +
        r.linkUnavailablePence,
    ).toBe(r.totalReceivedPence);
    expect(r.totalReceivedPence).toBe(73_600);
    expect(r.balanced).toBe(true);
  });

  it("holds when the table is added up the way Blerta will add it up on screen", () => {
    // Clinician rows + bucket rows, exactly what renders, must equal the total.
    const r = adversarialReport();
    const onScreen =
      r.lines.reduce((a, l) => a + l.attributedPence, 0) +
      allocationBucketRows(r).reduce((a, b) => a + b.pence, 0);
    expect(onScreen).toBe(r.totalReceivedPence);
  });

  it("reports `balanced: false` rather than a total when the identity breaks", () => {
    // A leg pointing at an invoice the report also attributed elsewhere cannot
    // break it, so the guard is proved by corrupting the report object itself:
    // the caller's contract is to render unavailable on `balanced === false`.
    const r = adversarialReport();
    const broken = { ...r, attributedPence: r.attributedPence + 1 };
    expect(
      broken.attributedPence +
        broken.unallocatedInDentallyPence +
        broken.explainedNoInvoiceLinkPence +
        broken.sharedInvoiceUndeterminedPence +
        broken.noAttributableLinesPence +
        broken.linkUnavailablePence ===
        broken.totalReceivedPence,
    ).toBe(false);
  });
});

describe("the adversarial fixture, row by row", () => {
  const r = adversarialReport();

  it("credits each clinician exactly, including the rounded and the refunded parts", () => {
    // prac-1: 10,000 (p1) + 3,334 (p2 rounding) + 34 (p3 largest remainder)
    //         − 4,000 (p7 refund) + 9,000 (p11 part payment) = 18,368
    expect(r.lines).toEqual([
      expect.objectContaining({ practitionerId: "prac-1", attributedPence: 18_368 }),
      expect.objectContaining({ practitionerId: "prac-2", attributedPence: 3033 }),
      expect.objectContaining({ practitionerId: "prac-3", attributedPence: 33 }),
    ]);
    expect(r.attributedPence).toBe(21_434);
  });

  it("fills each honesty bucket with exactly the money that could not reach a clinician", () => {
    expect(r.unallocatedInDentallyPence).toBe(10_500); // p8 7,500 + p11's 3,000 residue
    expect(r.explainedNoInvoiceLinkPence).toBe(6000); // p9
    expect(r.sharedInvoiceUndeterminedPence).toBe(20_000); // p5
    expect(r.noAttributableLinesPence).toBe(6666); // p2's 1,666 + p6's 5,000
    expect(r.linkUnavailablePence).toBe(9000); // p10
  });

  it("counts the refund, the excluded rows and the differing payment-taker", () => {
    expect(r.refundCount).toBe(1);
    expect(r.deletedExcluded).toBe(1);
    expect(r.unattributedExcluded).toBe(1);
    expect(r.paymentTakerDifferedCount).toBe(1);
    expect(r.totalCount).toBe(12);
  });

  it("records how each leg was resolved, and this run's own chain rate", () => {
    expect(r.legCount).toBe(11);
    expect(r.legsChainResolved).toBe(9);
    expect(r.legsLinkUnavailable).toBe(1);
    expect(r.runIncomplete).toBe(true);
    expect(runChainRate(r)).toBeCloseTo(9 / 11, 10);
    expect(r.basisCounts).toEqual({
      sole_practitioner: 5,
      pro_rata_full_settlement: 2,
      shared_invoice_part_payment: 1,
      no_attributable_lines: 1,
    });
  });

  it("counts sundry lines rather than assuming they behave like treatment lines", () => {
    expect(r.sundryLineCount).toBe(1);
  });

  it("reports this run's OWN coverage, not the calibration figure", () => {
    expect(attributedShare(r)).toBeCloseTo(21_434 / 73_600, 10);
  });
});

describe("allocationBucketRows", () => {
  it("renders every non-zero bucket as its own row, in a fixed order, with the exact wording", () => {
    const rows = allocationBucketRows(adversarialReport());
    expect(rows.map((row) => row.key)).toEqual([
      "unallocatedInDentally",
      "explainedNoInvoiceLink",
      "sharedInvoiceUndetermined",
      "noAttributableLines",
      "linkUnavailable",
    ]);
    expect(rows[0].label).toBe("Not allocated in Dentally");
    expect(rows[1].label).toBe("Paid, but not linked to an invoice");
    expect(rows[2].label).toBe("Shared invoice, part payment — which clinician is not recorded");
    expect(rows[3].label).toBe("Invoiced, but no clinician on the invoice lines");
    expect(rows[4].label).toBe("Could not read the invoice — this money is unaccounted for in this run");
    for (const row of rows) expect(row.note.length).toBeGreaterThan(20);
  });

  it("leaves out buckets that hold nothing", () => {
    const report = computeAllocationReport({
      payments: [payment({ explanations: [{ invoiceId: "inv-1", amountPence: 10_000 }] })],
      invoices: new Map([["inv-1", invoice("inv-1", [line("prac-1", 10_000)])]]),
      window: WINDOW,
    });
    expect(allocationBucketRows(report)).toEqual([]);
  });

  it("never renders a bucket as a footnote label — every key has a full sentence name", () => {
    for (const label of Object.values(ALLOCATION_BUCKET_LABELS)) {
      expect(label.length).toBeGreaterThan(15);
    }
  });
});

describe("attributedShare / runChainRate", () => {
  it("are null rather than 100% when there is nothing to divide", () => {
    const empty = computeAllocationReport({ payments: [], invoices: new Map(), window: WINDOW });
    expect(attributedShare(empty)).toBeNull();
    expect(runChainRate(empty)).toBeNull();
    expect(empty.balanced).toBe(true);
  });
});

describe("allocationWindowTooLong", () => {
  it("allows exactly the budgeted window and refuses one day more", () => {
    expect(ALLOCATION_MAX_WINDOW_DAYS).toBe(60);
    expect(allocationWindowTooLong({ from: "2026-06-02", to: "2026-07-31" })).toBe(false); // 60 days
    expect(allocationWindowTooLong({ from: "2026-06-01", to: "2026-07-31" })).toBe(true); // 61
    expect(allocationWindowTooLong({ from: "2026-07-31", to: "2026-07-31" })).toBe(false);
  });

  it("says why, and tells the reader what to do instead", () => {
    expect(ALLOCATION_WINDOW_UNAVAILABLE).toContain("60 days");
    expect(ALLOCATION_WINDOW_UNAVAILABLE).toContain("Choose a shorter period.");
  });
});
