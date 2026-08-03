import { describe, it, expect } from "vitest";
import {
  computePaymentAllocation,
  wiredAllocationConditions,
  unverifiedConditions,
  isPayable,
  ALLOCATION_CONDITION_LABELS,
  type AllocationConditions,
} from "./payment-allocation";
import type { DashboardPayment } from "@/lib/dashboard/normalise";

function pay(over: Partial<DashboardPayment> = {}): DashboardPayment {
  return {
    id: "p",
    amountPence: 10_000,
    day: "2026-08-10",
    siteId: "site-cc",
    practitionerId: "prac-1",
    patientId: "pat-1",
    deleted: false,
    ...over,
  };
}

describe("wiredAllocationConditions", () => {
  it("cannot verify the four conditions Blerta pays dentists on", () => {
    const c = wiredAllocationConditions();
    // Completed / closed / invoiced have NO wired source — a payment carries no
    // treatment or invoice link. Paid is only PARTIAL: a payment exists on the
    // practitioner, but not tied to a completed, closed, invoiced treatment.
    expect(c.completed).toBe("unverified");
    expect(c.closed).toBe("unverified");
    expect(c.invoiced).toBe("unverified");
    expect(c.paid).toBe("partial");
  });
});

describe("unverifiedConditions", () => {
  it("lists exactly the conditions that are not fully verified", () => {
    const c = wiredAllocationConditions();
    expect(unverifiedConditions(c).sort()).toEqual(["closed", "completed", "invoiced", "paid"].sort());
  });
  it("is empty only when all four are verified", () => {
    const all: AllocationConditions = {
      completed: "verified",
      closed: "verified",
      invoiced: "verified",
      paid: "verified",
    };
    expect(unverifiedConditions(all)).toEqual([]);
  });
  it("has a human label for every condition", () => {
    for (const key of ["completed", "closed", "invoiced", "paid"] as const) {
      expect(ALLOCATION_CONDITION_LABELS[key]).toBeTruthy();
    }
  });
});

describe("isPayable — every single condition is load-bearing", () => {
  const allVerified: AllocationConditions = {
    completed: "verified",
    closed: "verified",
    invoiced: "verified",
    paid: "verified",
  };
  it("is true only when all four are verified", () => {
    expect(isPayable(allVerified)).toBe(true);
  });
  // If ANY one of the four is downgraded, the dentist is NOT confirmed payable.
  // This pins each gate individually so a future edit cannot quietly drop one
  // (e.g. paying on completed+closed+paid while the invoice is still unconfirmed).
  for (const key of ["completed", "closed", "invoiced", "paid"] as const) {
    it(`is false when only '${key}' is unverified`, () => {
      expect(isPayable({ ...allVerified, [key]: "unverified" })).toBe(false);
    });
    it(`is false when only '${key}' is partial`, () => {
      expect(isPayable({ ...allVerified, [key]: "partial" })).toBe(false);
    });
  }
});

describe("computePaymentAllocation", () => {
  it("NEVER confirms a payment is due: every line is flagged not payable with the wired data", () => {
    const report = computePaymentAllocation({ payments: [pay(), pay({ id: "p2" })] });
    expect(report.anyPayableConfirmed).toBe(false);
    for (const line of report.lines) {
      expect(line.payableConfirmed).toBe(false);
      // The report says WHICH of the four it cannot confirm, per line.
      expect(unverifiedConditions(line.conditions).length).toBeGreaterThan(0);
    }
  });

  it("sums payments per practitioner, and the lines reconcile to the total", () => {
    const report = computePaymentAllocation({
      payments: [
        pay({ id: "a", practitionerId: "prac-1", amountPence: 10_000 }),
        pay({ id: "b", practitionerId: "prac-1", amountPence: 5_000 }),
        pay({ id: "c", practitionerId: "prac-2", amountPence: 7_000 }),
      ],
    });
    const p1 = report.lines.find((l) => l.practitionerId === "prac-1");
    const p2 = report.lines.find((l) => l.practitionerId === "prac-2");
    expect(p1!.paymentsReceivedPence).toBe(15_000);
    expect(p1!.paymentCount).toBe(2);
    expect(p2!.paymentsReceivedPence).toBe(7_000);
    const lineSum = report.lines.reduce((n, l) => n + l.paymentsReceivedPence, 0);
    expect(lineSum).toBe(report.totalPence);
    expect(report.totalPence).toBe(22_000);
    expect(report.totalCount).toBe(3);
  });

  it("excludes deleted payments and counts them apart", () => {
    const report = computePaymentAllocation({
      payments: [pay({ id: "live" }), pay({ id: "void", deleted: true })],
    });
    expect(report.totalPence).toBe(10_000);
    expect(report.totalCount).toBe(1);
    expect(report.deletedExcluded).toBe(1);
  });

  it("when site-scoped, excludes payments carrying no site and counts them apart", () => {
    const report = computePaymentAllocation({
      payments: [
        pay({ id: "here", siteId: "site-cc" }),
        pay({ id: "elsewhere", siteId: "site-rv" }),
        pay({ id: "nowhere", siteId: null }),
      ],
      siteId: "site-cc",
    });
    expect(report.totalPence).toBe(10_000);
    expect(report.totalCount).toBe(1);
    expect(report.unattributedExcluded).toBe(1);
  });

  it("scopes by window on the payment day", () => {
    const report = computePaymentAllocation({
      payments: [pay({ id: "in", day: "2026-08-10" }), pay({ id: "out", day: "2026-07-01" })],
      window: { from: "2026-08-01", to: "2026-08-31" },
    });
    expect(report.totalCount).toBe(1);
  });

  it("keeps refunds (negative amounts), which genuinely reduce what was received", () => {
    const report = computePaymentAllocation({
      payments: [pay({ id: "a", amountPence: 10_000 }), pay({ id: "r", amountPence: -2_000 })],
    });
    expect(report.totalPence).toBe(8_000);
  });

  it("groups payments with no practitioner under a null line rather than dropping them", () => {
    const report = computePaymentAllocation({
      payments: [pay({ id: "x", practitionerId: null, amountPence: 3_000 })],
    });
    const line = report.lines.find((l) => l.practitionerId === null);
    expect(line).toBeDefined();
    expect(line!.paymentsReceivedPence).toBe(3_000);
  });

  it("orders lines by amount received descending", () => {
    const report = computePaymentAllocation({
      payments: [
        pay({ id: "a", practitionerId: "prac-1", amountPence: 1_000 }),
        pay({ id: "b", practitionerId: "prac-2", amountPence: 9_000 }),
      ],
    });
    expect(report.lines[0].practitionerId).toBe("prac-2");
  });
});
