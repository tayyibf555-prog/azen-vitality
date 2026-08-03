// Proves the mock's payment and NHS claim rows survive the real normalisers and
// aggregate into sensible figures. If the mock ever drifts from the live field
// names or types, this fails before a dashboard renders a wrong number.

import { describe, expect, it } from "vitest";

import {
  MOCK_SITE_IDS,
  allAllocationInvoices,
  allNhsClaims,
  allPayments,
} from "@/app/api/mock-dentally/_finance-fixtures";
import { computeTakingsStrip } from "@/lib/dashboard/takings";
import { computeUdaProgress, computeUdaTotals } from "@/lib/dashboard/uda";
import { normaliseNhsClaims, normalisePayments } from "@/lib/dashboard/normalise";
import { londonToday, periodWindow, shiftDayKey } from "@/lib/dashboard/period";
import { invoiceFromEnvelope } from "@/lib/dentally/invoice-shape";
import { normaliseAllocationPayments } from "@/lib/reports/payment-explanations";
import { computeAllocationReport } from "@/lib/reports/allocation-report";

const NOW = new Date();
const TODAY = londonToday(NOW);

describe("mock payments", () => {
  const rows = allPayments();

  it("generates ninety days across the three sites", () => {
    expect(rows.length).toBeGreaterThan(1500);
    expect(new Set(rows.map((r) => r.site_id))).toEqual(new Set(MOCK_SITE_IDS));
    // Sundays are closed, so a 90 day span carries roughly 77 trading days.
    const days = [...new Set(rows.map((r) => r.dated_on))].sort();
    expect(days.length).toBeGreaterThan(70);
    // Every day sits inside the ninety day window ending today, whichever day of
    // the week today happens to be.
    const window = periodWindow("last90", NOW);
    expect(days[0] >= window.from).toBe(true);
    expect(days[days.length - 1] <= window.to).toBe(true);
  });

  it("returns newest first, like the live API", () => {
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].dated_on >= rows[i].dated_on).toBe(true);
    }
  });

  it("sends amounts as strings and dates as bare YYYY-MM-DD", () => {
    for (const row of rows.slice(0, 200)) {
      expect(typeof row.amount).toBe("string");
      expect(row.dated_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof row.deleted).toBe("boolean");
    }
  });

  it("is stable across calls, so two dashboard loads agree", () => {
    expect(allPayments()).toEqual(rows);
  });

  it("carries exactly one unparseable amount, and the normaliser drops it", () => {
    expect(rows.filter((r) => r.amount === "").length).toBe(1);
    const { rows: parsed, dropped } = normalisePayments(rows);
    expect(dropped).toBe(1);
    expect(parsed.length).toBe(rows.length - 1);
  });

  it("carries some deleted rows, which never reach a total", () => {
    expect(rows.some((r) => r.deleted)).toBe(true);
    const { rows: parsed } = normalisePayments(rows);
    const strip = computeTakingsStrip({
      payments: parsed,
      paymentsCoverage: { from: shiftDayKey(TODAY, -89) ?? TODAY, to: TODAY },
      now: NOW,
    });
    const deletedPence = parsed
      .filter((p) => p.deleted && p.day === TODAY)
      .reduce((acc, p) => acc + p.amountPence, 0);
    const everythingToday = parsed
      .filter((p) => p.day === TODAY)
      .reduce((acc, p) => acc + p.amountPence, 0);
    const today = strip.cells.find((c) => c.period === "today");
    expect(today?.totalPence).toBe(everythingToday - deletedPence);
    expect(strip.deletedPayments).toBeGreaterThan(0);
  });

  it("produces a strip whose nested periods grow, and whose sites sum to the group", () => {
    const { rows: parsed, dropped } = normalisePayments(rows);
    const coverage = { from: shiftDayKey(TODAY, -89) ?? TODAY, to: TODAY };
    const strip = computeTakingsStrip({
      payments: parsed,
      paymentsCoverage: coverage,
      paymentsDropped: dropped,
      now: NOW,
    });
    const total = (period: string): number => {
      const cell = strip.cells.find((c) => c.period === period);
      expect(cell?.totalPence).not.toBeNull();
      return cell?.totalPence ?? 0;
    };
    expect(total("last7")).toBeGreaterThanOrEqual(total("today"));
    expect(total("last30")).toBeGreaterThanOrEqual(total("last7"));
    expect(total("last90")).toBeGreaterThanOrEqual(total("last30"));

    const perSite = MOCK_SITE_IDS.map((siteId) => {
      const scoped = computeTakingsStrip({
        payments: parsed,
        paymentsCoverage: coverage,
        now: NOW,
        siteId,
      });
      return scoped.cells.find((c) => c.period === "last30")?.totalPence ?? 0;
    });
    expect(perSite.reduce((a, b) => a + b, 0)).toBe(total("last30"));
  });
});

describe("mock NHS claims", () => {
  const rows = allNhsClaims();

  it("covers the contract year to date and returns newest first", () => {
    expect(rows.length).toBeGreaterThan(100);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].submitted_date >= rows[i].submitted_date).toBe(true);
    }
  });

  it("sends UDA figures as strings", () => {
    for (const row of rows.slice(0, 100)) {
      expect(typeof row.expected_uda).toBe("string");
      expect(typeof row.awarded_uda).toBe("string");
      expect(row.submitted_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("normalises without dropping a single row", () => {
    const { rows: parsed, dropped } = normaliseNhsClaims(rows);
    expect(dropped).toBe(0);
    expect(parsed.length).toBe(rows.length);
  });

  it("includes a status outside every recognised set, counted toward neither figure", () => {
    const { rows: parsed } = normaliseNhsClaims(rows);
    const totals = computeUdaTotals({ claims: parsed });
    expect(totals.unknownStatuses).toEqual(["awaiting_pcse_response"]);
    expect(totals.unrecognisedClaimCount).toBe(2);
    expect(totals.completedUda).toBeGreaterThan(0);
    expect(totals.invalidUda).toBeGreaterThan(0);
  });

  it("gives a UDA progress line with a real target", () => {
    const { rows: parsed } = normaliseNhsClaims(rows);
    const totals = computeUdaTotals({ claims: parsed });
    const progress = computeUdaProgress({
      completedUda: totals.completedUda,
      targetUda: 24_000,
      now: NOW,
    });
    expect(progress).not.toBeNull();
    expect(progress?.daysElapsed).toBeGreaterThan(0);
    expect(progress?.percentOfTarget).toBeGreaterThan(0);
  });

  it("is stable across calls", () => {
    expect(allNhsClaims()).toEqual(rows);
  });
});

describe("the periods the mock has to satisfy", () => {
  it("reaches back far enough for the ninety day cell", () => {
    const window = periodWindow("last90", NOW);
    const oldest = allPayments().reduce((acc, r) => (r.dated_on < acc ? r.dated_on : acc), TODAY);
    // The oldest generated day is the window's first day, or the first trading
    // day after it when the window opens on a Sunday.
    expect(oldest >= window.from).toBe(true);
    expect(oldest <= (shiftDayKey(window.from, 1) ?? window.from)).toBe(true);
  });
});

// ===========================================================================
// The allocation fixtures: explanations[] and the invoices they name.
//
// A mock that only produced tidy, fully-explained, single-clinician payments
// would let a report that only works on tidy data reach a practice. These prove
// the messy cases are present AND that the real chain reconciles over them.
// ===========================================================================

describe("mock payment allocations", () => {
  const payments = allPayments();
  const invoices = allAllocationInvoices();

  it("carries the live explanation keys, with money as strings", () => {
    const legs = payments.flatMap((p) => p.explanations);
    expect(legs.length).toBeGreaterThan(500);
    for (const leg of legs.slice(0, 200)) {
      expect(typeof leg.amount).toBe("string");
      expect(leg).toHaveProperty("invoice_id");
      expect(leg).toHaveProperty("invoice_reference");
      expect(leg).toHaveProperty("payment_id");
      expect(leg).toHaveProperty("comments");
      expect(leg).toHaveProperty("user_id");
    }
  });

  it("is as messy as production: unexplained, part-explained and unlinked payments all appear", () => {
    const live = payments.filter((p) => !p.deleted && p.amount !== "");
    expect(live.some((p) => p.explanations.length === 0 && !p.fully_explained)).toBe(true);
    expect(live.some((p) => p.status === "partially_explained")).toBe(true);
    expect(live.some((p) => p.explanations.some((e) => e.invoice_id === null))).toBe(true);
    // Roughly the live proportion: 83.4% fully explained.
    const explained = live.filter((p) => p.fully_explained).length / live.length;
    expect(explained).toBeGreaterThan(0.75);
    expect(explained).toBeGreaterThan(0.75);
    expect(explained).toBeLessThan(0.92);
  });

  it("builds shared invoices and no-clinician invoices, the two cases that must not be attributed", () => {
    const all = [...invoices.values()];
    expect(all.length).toBeGreaterThan(500);
    const distinctPractitioners = (inv: (typeof all)[number]) =>
      new Set(inv.invoice_items.map((i) => i.practitioner_id).filter((p) => p !== null)).size;
    expect(all.some((inv) => distinctPractitioners(inv) > 1)).toBe(true);
    expect(all.some((inv) => distinctPractitioners(inv) === 0)).toBe(true);
    // A part-paid shared invoice: more than one clinician AND still owing.
    expect(all.some((inv) => distinctPractitioners(inv) > 1 && Number(inv.amount_outstanding) > 0)).toBe(true);
  });

  it("keeps the live invariant Σ line total_price == invoice.amount, and nhs_amount null", () => {
    for (const inv of [...invoices.values()].slice(0, 400)) {
      const lines = inv.invoice_items.reduce((a, i) => a + Math.round(Number(i.total_price) * 100), 0);
      expect(lines).toBe(Math.round(Number(inv.amount) * 100));
      expect(inv.nhs_amount).toBeNull();
      for (const item of inv.invoice_items) expect(item.nhs_charge).toBe(0);
    }
  });

  it("survives the REAL chain, and the money reconciles with nothing vanishing", () => {
    const { rows } = normaliseAllocationPayments(payments);
    const read = new Map<string, NonNullable<ReturnType<typeof invoiceFromEnvelope>>>();
    for (const [id, inv] of invoices) {
      const parsed = invoiceFromEnvelope({ invoice: inv });
      expect(parsed).not.toBeNull();
      read.set(id, parsed!);
    }
    const window = periodWindow("last30", NOW);
    const report = computeAllocationReport({ payments: rows, invoices: read, window });

    expect(report.balanced).toBe(true);
    expect(report.totalReceivedPence).toBeGreaterThan(0);
    expect(report.attributedPence).toBeGreaterThan(0);
    // Every honesty bucket is exercised by this fixture, not just the happy path.
    expect(report.unallocatedInDentallyPence).toBeGreaterThan(0);
    expect(report.explainedNoInvoiceLinkPence).toBeGreaterThan(0);
    expect(report.sharedInvoiceUndeterminedPence).toBeGreaterThan(0);
    expect(report.noAttributableLinesPence).toBeGreaterThan(0);
    expect(report.basisCounts.pro_rata_full_settlement).toBeGreaterThan(0);
    expect(report.basisCounts.sole_practitioner).toBeGreaterThan(0);
    // The front-desk reality: the person who took the money is sometimes not the
    // clinician credited. Measured live at 17/242 legs, and it must be visible
    // in the mock too or the count on screen is never exercised.
    expect(report.paymentTakerDifferedCount).toBeGreaterThan(0);
    // And nothing is ever payable: `closed` is unreadable on the real API.
    expect(report.anyPayableConfirmed).toBe(false);
  });
});
