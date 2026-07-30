import { describe, expect, it } from "vitest";

import { computeInvoicedTotals, computeOutstandingAccounts } from "@/lib/dashboard/accounts";
import type { DashboardAccountBalance } from "@/lib/dashboard/normalise";

function bal(patientId: string, owedPence: number, patientName: string | null = null): DashboardAccountBalance {
  return { patientId, patientName, owedPence };
}

describe("computeOutstandingAccounts", () => {
  it("sums a patient's several invoices before ranking them", () => {
    const result = computeOutstandingAccounts({
      balances: [bal("p1", 50_000, "Aisha Begum"), bal("p1", 25_000), bal("p2", 60_000, "Rajesh Patel")],
    });
    expect(result.top[0]).toEqual({ patientId: "p1", patientName: "Aisha Begum", owedPence: 75_000 });
    expect(result.top[1]).toEqual({ patientId: "p2", patientName: "Rajesh Patel", owedPence: 60_000 });
    expect(result.totalOwedPence).toBe(135_000);
  });

  it("ranks the ten largest debts by default and reports how many owe in total", () => {
    const balances = Array.from({ length: 25 }, (_, i) => bal(`p${i}`, (i + 1) * 1000, `Patient ${i}`));
    const result = computeOutstandingAccounts({ balances });
    expect(result.top).toHaveLength(10);
    expect(result.top[0].owedPence).toBe(25_000);
    expect(result.top[9].owedPence).toBe(16_000);
    expect(result.patientsInDebt).toBe(25);
  });

  it("keeps the net balance and the owed total apart when a patient is in credit", () => {
    const result = computeOutstandingAccounts({
      balances: [bal("p1", 100_000, "Owes"), bal("p2", -40_000, "In credit")],
    });
    expect(result.netBalancePence).toBe(60_000);
    expect(result.totalOwedPence).toBe(100_000);
    expect(result.top.map((t) => t.patientId)).toEqual(["p1"]);
  });

  it("does not list a patient whose invoices net off to nothing", () => {
    const result = computeOutstandingAccounts({
      balances: [bal("p1", 50_000, "Settled"), bal("p1", -50_000)],
    });
    expect(result.top).toEqual([]);
    expect(result.netBalancePence).toBe(0);
    expect(result.totalOwedPence).toBe(0);
  });

  it("breaks ties on name then id, so the list does not reshuffle between loads", () => {
    const result = computeOutstandingAccounts({
      balances: [bal("p2", 1000, "Bell"), bal("p1", 1000, "Adams"), bal("p3", 1000, "Adams")],
    });
    expect(result.top.map((t) => t.patientId)).toEqual(["p1", "p3", "p2"]);
  });

  it("scopes to a site through the patient, never assuming an unmapped patient belongs to it", () => {
    const siteByPatientId = new Map([
      ["p1", "site-cc"],
      ["p2", "site-rv"],
    ]);
    const balances = [bal("p1", 1000, "A"), bal("p2", 2000, "B"), bal("p3", 9000, "Unmapped")];
    const scoped = computeOutstandingAccounts({ balances, siteByPatientId, siteId: "site-cc" });
    expect(scoped.top.map((t) => t.patientId)).toEqual(["p1"]);
    expect(scoped.totalOwedPence).toBe(1000);

    const all = computeOutstandingAccounts({ balances, siteByPatientId });
    expect(all.totalOwedPence).toBe(12_000);
  });

  it("keeps a name once one row supplies it, and reports null when none does", () => {
    const named = computeOutstandingAccounts({ balances: [bal("p1", 1000), bal("p1", 1000, "Late Name")] });
    expect(named.top[0].patientName).toBe("Late Name");
    const unnamed = computeOutstandingAccounts({ balances: [bal("p1", 1000)] });
    expect(unnamed.top[0].patientName).toBeNull();
  });

  it("carries the normaliser's drop count through", () => {
    expect(computeOutstandingAccounts({ balances: [], dropped: 7 }).dropped).toBe(7);
  });
});

describe("computeInvoicedTotals", () => {
  it("splits gross into paid and unpaid, counting a part-paid invoice on both bars", () => {
    const result = computeInvoicedTotals({
      invoices: [
        { grossPence: 200_000, outstandingPence: 150_000 },
        { grossPence: 85_000, outstandingPence: 85_000 },
        { grossPence: 134_000, outstandingPence: 0 },
      ],
    });
    expect(result.totalPence).toBe(419_000);
    expect(result.unpaidPence).toBe(235_000);
    expect(result.paidPence).toBe(184_000);
    expect(result.invoiceCount).toBe(3);
  });

  it("returns genuine zeroes for an empty window", () => {
    const result = computeInvoicedTotals({ invoices: [] });
    expect(result).toEqual({
      totalPence: 0,
      paidPence: 0,
      unpaidPence: 0,
      invoiceCount: 0,
      dropped: 0,
    });
  });
});
