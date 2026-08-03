import { describe, it, expect } from "vitest";
import { apportionLargestRemainder, splitAllocationLeg, type LegSplit } from "./allocation-split";
import type { InvoiceItem, InvoiceWithItems } from "@/lib/dentally/invoice-shape";

function line(practitionerId: string | null, totalPricePence: number, id = `ii-${practitionerId}-${totalPricePence}`): InvoiceItem {
  return {
    id,
    practitionerId,
    totalPricePence,
    quantity: 1,
    name: "Treatment",
    treatmentPlanItemId: "tpi-1",
    sundryId: null,
  };
}

/** An invoice whose amount is Σ line prices — measured true on 256/256 live. */
function invoice(items: InvoiceItem[], over: Partial<InvoiceWithItems> = {}): InvoiceWithItems {
  return {
    id: "inv-1",
    patientId: "pat-9",
    amountPence: items.reduce((a, i) => a + i.totalPricePence, 0),
    datedOn: "2026-07-30",
    items,
    ...over,
  };
}

/** Σ attributions + residual === leg. The per-leg half of the report's identity. */
function conserves(split: LegSplit, leg: number): boolean {
  return split.attributions.reduce((a, x) => a + x.pence, 0) + split.residual === leg;
}

describe("apportionLargestRemainder", () => {
  it("splits exactly, with the leftover pence going to the largest remainders", () => {
    expect(apportionLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(apportionLargestRemainder(10, [1, 2, 7])).toEqual([1, 2, 7]);
    expect(apportionLargestRemainder(1000, [333, 333, 334])).toEqual([333, 333, 334]);
  });

  it("ALWAYS sums to the total, over a spread of awkward splits", () => {
    const totals = [1, 7, 99, 100, 4999, 123_457, -1, -7, -4999];
    const weightSets = [[1, 1, 1], [1, 2], [7, 11, 13], [1, 1, 1, 1, 1, 1, 1], [999, 1], [3, 3, 4]];
    for (const total of totals) {
      for (const weights of weightSets) {
        const parts = apportionLargestRemainder(total, weights);
        expect(parts).not.toBeNull();
        expect(parts!.reduce((a, b) => a + b, 0)).toBe(total);
        expect(parts!.length).toBe(weights.length);
      }
    }
  });

  it("is sign-safe: a refund splits exactly and every part is a reduction", () => {
    const parts = apportionLargestRemainder(-100, [1, 1, 1]);
    expect(parts).toEqual([-33, -33, -34]);
    expect(parts!.reduce((a, b) => a + b, 0)).toBe(-100);
  });

  it("breaks ties by position, so the same invoice always splits the same way", () => {
    expect(apportionLargestRemainder(100, [1, 1, 1])).toEqual(apportionLargestRemainder(100, [1, 1, 1]));
  });

  it("gives every line nothing when there is nothing to split", () => {
    expect(apportionLargestRemainder(0, [1, 2, 3])).toEqual([0, 0, 0]);
    expect(apportionLargestRemainder(0, [0, 0])).toEqual([0, 0]);
  });

  it("REFUSES rather than guessing when the weights cannot carry a split", () => {
    expect(apportionLargestRemainder(100, [])).toBeNull();
    expect(apportionLargestRemainder(100, [0, 0])).toBeNull();
    expect(apportionLargestRemainder(100, [-5, -5])).toBeNull();
    expect(apportionLargestRemainder(1.5, [1, 1])).toBeNull();
    expect(apportionLargestRemainder(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER])).toBeNull();
  });
});

describe("splitAllocationLeg — sole clinician (98.0% of measured legs)", () => {
  it("gives the whole leg to the one clinician on the invoice", () => {
    const inv = invoice([line("prac-1", 6000), line("prac-1", 4000)]);
    const split = splitAllocationLeg({ legAmountPence: 10_000, invoice: inv });
    expect(split.basis).toBe("sole_practitioner");
    expect(split.attributions).toEqual([{ practitionerId: "prac-1", pence: 10_000 }]);
    expect(split.residual).toBe(0);
    expect(conserves(split, 10_000)).toBe(true);
  });

  it("gives a PART payment on a single-clinician invoice entirely to them — no ambiguity about who", () => {
    const inv = invoice([line("prac-1", 60_000)]);
    const split = splitAllocationLeg({ legAmountPence: 20_000, invoice: inv });
    expect(split.basis).toBe("sole_practitioner");
    expect(split.attributions).toEqual([{ practitionerId: "prac-1", pence: 20_000 }]);
    expect(split.residual).toBe(0);
  });

  it("reduces the clinician's line on a refund", () => {
    const inv = invoice([line("prac-1", 4000)]);
    const split = splitAllocationLeg({ legAmountPence: -4000, invoice: inv });
    expect(split.attributions).toEqual([{ practitionerId: "prac-1", pence: -4000 }]);
    expect(conserves(split, -4000)).toBe(true);
  });

  it("holds back the share sitting on lines with NO clinician, rather than crediting it to the only clinician present", () => {
    // Crediting it would be the same fabrication the part-payment refusal exists
    // to prevent. Unobserved live (practitioner_id was on 256/256 lines).
    const inv = invoice([line("prac-1", 6667), line(null, 3333)]);
    const split = splitAllocationLeg({ legAmountPence: 5000, invoice: inv });
    expect(split.basis).toBe("sole_practitioner");
    expect(split.attributions).toEqual([{ practitionerId: "prac-1", pence: 3334 }]);
    expect(split.residual).toBe(1666);
    expect(conserves(split, 5000)).toBe(true);
  });

  it("falls back to the whole leg when the lines carry no apportionable value at all", () => {
    const inv = invoice([line("prac-1", 0)], { amountPence: 5000 });
    const split = splitAllocationLeg({ legAmountPence: 5000, invoice: inv });
    expect(split.basis).toBe("sole_practitioner");
    expect(split.attributions).toEqual([{ practitionerId: "prac-1", pence: 5000 }]);
    expect(split.residual).toBe(0);
  });
});

describe("splitAllocationLeg — shared invoice, full settlement", () => {
  it("splits pro-rata by each clinician's share of the invoice's line value", () => {
    const inv = invoice([line("prac-1", 30_000), line("prac-2", 10_000)]);
    const split = splitAllocationLeg({ legAmountPence: 40_000, invoice: inv });
    expect(split.basis).toBe("pro_rata_full_settlement");
    expect(split.attributions).toEqual([
      { practitionerId: "prac-1", pence: 30_000 },
      { practitionerId: "prac-2", pence: 10_000 },
    ]);
    expect(split.residual).toBe(0);
  });

  it("sums the parts EXACTLY to the leg when the split does not divide evenly", () => {
    // Largest remainder, whole pence. Plain rounding would lose or create a penny.
    const inv = invoice([line("prac-1", 1), line("prac-2", 1), line("prac-3", 1)], { amountPence: 100 });
    const split = splitAllocationLeg({ legAmountPence: 100, invoice: inv });
    expect(split.basis).toBe("pro_rata_full_settlement");
    expect(split.attributions.reduce((a, x) => a + x.pence, 0)).toBe(100);
    expect(split.attributions.map((a) => a.pence)).toEqual([34, 33, 33]);
    expect(conserves(split, 100)).toBe(true);
  });

  it("keeps three clinicians distinct, and folds a clinician's two lines into one credit", () => {
    const inv = invoice([
      line("prac-1", 1000, "a"),
      line("prac-2", 2000, "b"),
      line("prac-1", 3000, "c"),
      line("prac-3", 4000, "d"),
    ]);
    const split = splitAllocationLeg({ legAmountPence: 10_000, invoice: inv });
    expect(split.attributions).toEqual([
      { practitionerId: "prac-1", pence: 4000 },
      { practitionerId: "prac-2", pence: 2000 },
      { practitionerId: "prac-3", pence: 4000 },
    ]);
    expect(conserves(split, 10_000)).toBe(true);
  });

  it("holds back the un-clinician'd lines' share on a mixed shared invoice", () => {
    const inv = invoice([line("prac-1", 5000), line("prac-2", 3000), line(null, 2000)]);
    const split = splitAllocationLeg({ legAmountPence: 10_000, invoice: inv });
    expect(split.basis).toBe("pro_rata_full_settlement");
    expect(split.attributions).toEqual([
      { practitionerId: "prac-1", pence: 5000 },
      { practitionerId: "prac-2", pence: 3000 },
    ]);
    expect(split.residual).toBe(2000);
    expect(conserves(split, 10_000)).toBe(true);
  });

  it("refuses a credit-note invoice whose line values cannot carry a proportional split", () => {
    // Every line negative: the leg does equal the invoice amount, but there is no
    // positive value to apportion by, so no line attributes this money.
    const inv = invoice([line("prac-1", -3000), line("prac-2", -1000)]);
    const split = splitAllocationLeg({ legAmountPence: -4000, invoice: inv });
    expect(split.basis).toBe("no_attributable_lines");
    expect(split.attributions).toEqual([]);
    expect(split.residual).toBe(-4000);
    expect(conserves(split, -4000)).toBe(true);
  });
});

describe("splitAllocationLeg — shared invoice, PART payment: attributes to nobody", () => {
  it("refuses to pro-rate a part payment across a shared invoice", () => {
    // Dentally records WHICH INVOICE the money settled, never WHICH LINE. This is
    // the load-bearing refusal: a fabricated split becomes someone's wages.
    const inv = invoice([line("prac-1", 40_000), line("prac-2", 20_000)]);
    const split = splitAllocationLeg({ legAmountPence: 20_000, invoice: inv });
    expect(split.basis).toBe("shared_invoice_part_payment");
    expect(split.attributions).toEqual([]);
    expect(split.residual).toBe(20_000);
    expect(conserves(split, 20_000)).toBe(true);
  });

  it("refuses an OVER payment on a shared invoice too — it is not a full settlement", () => {
    const inv = invoice([line("prac-1", 40_000), line("prac-2", 20_000)]);
    const split = splitAllocationLeg({ legAmountPence: 65_000, invoice: inv });
    expect(split.basis).toBe("shared_invoice_part_payment");
    expect(split.residual).toBe(65_000);
  });

  it("refuses a refund against a shared invoice — it settles no invoice in full", () => {
    const inv = invoice([line("prac-1", 40_000), line("prac-2", 20_000)]);
    const split = splitAllocationLeg({ legAmountPence: -10_000, invoice: inv });
    expect(split.basis).toBe("shared_invoice_part_payment");
    expect(split.attributions).toEqual([]);
    expect(split.residual).toBe(-10_000);
    expect(conserves(split, -10_000)).toBe(true);
  });
});

describe("splitAllocationLeg — nothing on the invoice can attribute", () => {
  it("buckets a leg whose invoice has lines but no clinician on any of them", () => {
    const inv = invoice([line(null, 6000), line(null, 4000)]);
    const split = splitAllocationLeg({ legAmountPence: 10_000, invoice: inv });
    expect(split.basis).toBe("no_attributable_lines");
    expect(split.attributions).toEqual([]);
    expect(split.residual).toBe(10_000);
    expect(conserves(split, 10_000)).toBe(true);
  });

  it("buckets a leg whose invoice has NO lines at all", () => {
    const split = splitAllocationLeg({ legAmountPence: 7500, invoice: invoice([], { amountPence: 7500 }) });
    expect(split.basis).toBe("no_attributable_lines");
    expect(split.residual).toBe(7500);
  });

  it("buckets a shared invoice whose lines carry no apportionable value", () => {
    const inv = invoice([line("prac-1", 0), line("prac-2", 0)], { amountPence: 9000 });
    const split = splitAllocationLeg({ legAmountPence: 9000, invoice: inv });
    expect(split.basis).toBe("no_attributable_lines");
    expect(split.attributions).toEqual([]);
    expect(split.residual).toBe(9000);
  });

  it("handles a zero-amount invoice settled by a zero leg without inventing a credit", () => {
    const inv = invoice([line("prac-1", 0), line("prac-2", 0)]);
    const split = splitAllocationLeg({ legAmountPence: 0, invoice: inv });
    expect(split.attributions).toEqual([]);
    expect(split.residual).toBe(0);
    expect(conserves(split, 0)).toBe(true);
  });
});

describe("the per-leg conservation identity", () => {
  it("holds for every basis, including the awkward ones", () => {
    const cases: { leg: number; inv: InvoiceWithItems }[] = [
      { leg: 10_000, inv: invoice([line("prac-1", 10_000)]) },
      { leg: 3333, inv: invoice([line("prac-1", 6667), line(null, 3333)]) },
      { leg: 10_000, inv: invoice([line("prac-1", 5000), line("prac-2", 5000)]) },
      { leg: 4999, inv: invoice([line("prac-1", 5000), line("prac-2", 5000)]) },
      { leg: -2500, inv: invoice([line("prac-1", 5000), line("prac-2", 5000)]) },
      { leg: 100, inv: invoice([line(null, 100)]) },
      { leg: 0, inv: invoice([]) },
      { leg: 7, inv: invoice([line("prac-1", 1), line("prac-2", 1), line("prac-3", 1)], { amountPence: 7 }) },
    ];
    for (const { leg, inv } of cases) {
      expect(conserves(splitAllocationLeg({ legAmountPence: leg, invoice: inv }), leg)).toBe(true);
    }
  });
});
