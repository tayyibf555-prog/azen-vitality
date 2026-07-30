// Proves the mock's payment and NHS claim rows survive the real normalisers and
// aggregate into sensible figures. If the mock ever drifts from the live field
// names or types, this fails before a dashboard renders a wrong number.

import { describe, expect, it } from "vitest";

import { MOCK_SITE_IDS, allNhsClaims, allPayments } from "@/app/api/mock-dentally/_finance-fixtures";
import { computeTakingsStrip } from "@/lib/dashboard/takings";
import { computeUdaProgress, computeUdaTotals } from "@/lib/dashboard/uda";
import { normaliseNhsClaims, normalisePayments } from "@/lib/dashboard/normalise";
import { londonToday, periodWindow, shiftDayKey } from "@/lib/dashboard/period";

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
