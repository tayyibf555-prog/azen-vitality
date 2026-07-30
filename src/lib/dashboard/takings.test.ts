import { describe, expect, it } from "vitest";

import type { DashboardAppointment, DashboardPayment } from "@/lib/dashboard/normalise";
import {
  computeTakingsStrip,
  computeTakingsStripFromRollup,
  normaliseRollupDay,
  normaliseRollupDays,
  type DashboardRollupDay,
  type TakingsCell,
} from "@/lib/dashboard/takings";

const NOW = new Date("2026-07-30T09:00:00Z");

function pay(day: string, pence: number, over: Partial<DashboardPayment> = {}): DashboardPayment {
  return {
    id: `${day}-${pence}-${over.siteId ?? "site-cc"}`,
    amountPence: pence,
    day,
    siteId: "site-cc",
    practitionerId: "prac-1",
    patientId: "pat-001",
    deleted: false,
    ...over,
  };
}

function appt(day: string, over: Partial<DashboardAppointment> = {}): DashboardAppointment {
  return {
    id: `appt-${day}-${over.siteId ?? "site-cc"}-${over.state ?? "Completed"}`,
    day,
    siteId: "site-cc",
    practitionerId: "prac-1",
    patientId: "pat-001",
    state: "Completed",
    ...over,
  };
}

function cell(strip: { cells: TakingsCell[] }, period: string): TakingsCell {
  const found = strip.cells.find((c) => c.period === period);
  if (!found) throw new Error(`no cell for ${period}`);
  return found;
}

describe("computeTakingsStrip", () => {
  const payments = [
    pay("2026-07-30", 5000),
    pay("2026-07-30", 2500),
    pay("2026-07-29", 306020),
    pay("2026-07-24", 1000),
    pay("2026-07-23", 9999), // outside last7
  ];
  const coverage = { from: "2026-05-02", to: "2026-07-30" };

  it("totals each period on its own inclusive London window", () => {
    const strip = computeTakingsStrip({ payments, paymentsCoverage: coverage, now: NOW });
    expect(cell(strip, "today").totalPence).toBe(7500);
    expect(cell(strip, "today").paymentCount).toBe(2);
    expect(cell(strip, "yesterday").totalPence).toBe(306020);
    expect(cell(strip, "last7").totalPence).toBe(7500 + 306020 + 1000);
    expect(cell(strip, "last30").totalPence).toBe(7500 + 306020 + 1000 + 9999);
    expect(cell(strip, "last90").totalPence).toBe(7500 + 306020 + 1000 + 9999);
  });

  it("reports a period the scan does not reach as unavailable, never as a total", () => {
    // A caller that only paged back to the 28th: today and yesterday are sound,
    // everything longer is not.
    const strip = computeTakingsStrip({
      payments,
      paymentsCoverage: { from: "2026-07-28", to: "2026-07-30" },
      now: NOW,
    });
    expect(cell(strip, "today").totalPence).toBe(7500);
    expect(cell(strip, "yesterday").totalPence).toBe(306020);
    for (const period of ["last7", "last30", "last90"]) {
      const c = cell(strip, period);
      expect(c.totalPence).toBeNull();
      expect(c.paymentCount).toBeNull();
      expect(c.unavailableReason).toContain("does not reach back this far");
    }
  });

  it("reports every period as unavailable when there is no coverage at all", () => {
    const strip = computeTakingsStrip({ payments, paymentsCoverage: null, now: NOW });
    for (const c of strip.cells) {
      expect(c.totalPence).toBeNull();
      expect(c.unavailableReason).toBe("Takings unavailable for this period.");
    }
  });

  it("returns zero, not null, for a covered period that genuinely had no payments", () => {
    const strip = computeTakingsStrip({
      payments: [pay("2026-07-29", 1000)],
      paymentsCoverage: coverage,
      appointments: [],
      appointmentsCoverage: coverage,
      now: NOW,
    });
    expect(cell(strip, "today").totalPence).toBe(0);
    expect(cell(strip, "today").paymentCount).toBe(0);
    expect(cell(strip, "today").appointmentCount).toBe(0);
    expect(cell(strip, "today").unavailableReason).toBeNull();
    expect(cell(strip, "today").appointmentUnavailableReason).toBeNull();
  });

  it("excludes deleted payments and counts them", () => {
    const strip = computeTakingsStrip({
      payments: [pay("2026-07-30", 5000), pay("2026-07-30", 9999, { deleted: true, id: "d1" })],
      paymentsCoverage: coverage,
      now: NOW,
    });
    expect(cell(strip, "today").totalPence).toBe(5000);
    expect(strip.deletedPayments).toBe(1);
  });

  it("lets a refund reduce the day's takings", () => {
    const strip = computeTakingsStrip({
      payments: [pay("2026-07-30", 5000), pay("2026-07-30", -2000, { id: "refund" })],
      paymentsCoverage: coverage,
      now: NOW,
    });
    expect(cell(strip, "today").totalPence).toBe(3000);
  });

  it("scopes to one site for the per-site toggle, and totals the group otherwise", () => {
    const mixed = [
      pay("2026-07-30", 1000, { siteId: "site-cc", id: "a" }),
      pay("2026-07-30", 2000, { siteId: "site-rv", id: "b" }),
      pay("2026-07-30", 4000, { siteId: "site-ng", id: "c" }),
    ];
    const all = computeTakingsStrip({ payments: mixed, paymentsCoverage: coverage, now: NOW });
    expect(cell(all, "today").totalPence).toBe(7000);
    expect(all.siteId).toBeNull();

    const one = computeTakingsStrip({
      payments: mixed,
      paymentsCoverage: coverage,
      now: NOW,
      siteId: "site-rv",
    });
    expect(cell(one, "today").totalPence).toBe(2000);
    expect(one.siteId).toBe("site-rv");
  });

  it("never folds an unattributed payment into a selected site's total", () => {
    const strip = computeTakingsStrip({
      payments: [pay("2026-07-30", 1000, { siteId: null, id: "orphan" }), pay("2026-07-30", 2000)],
      paymentsCoverage: coverage,
      now: NOW,
      siteId: "site-cc",
    });
    expect(cell(strip, "today").totalPence).toBe(2000);
    expect(strip.unattributedPayments).toBe(1);
  });

  it("counts appointments beneath the money when they are covered", () => {
    const strip = computeTakingsStrip({
      payments,
      paymentsCoverage: coverage,
      appointments: [appt("2026-07-29"), appt("2026-07-29", { state: "Did not attend" }), appt("2026-07-30")],
      appointmentsCoverage: coverage,
      now: NOW,
    });
    expect(cell(strip, "yesterday").appointmentCount).toBe(2);
    expect(cell(strip, "today").appointmentCount).toBe(1);
  });

  it("leaves the appointment count blank, with its own reason, while the money still reads", () => {
    const strip = computeTakingsStrip({ payments, paymentsCoverage: coverage, now: NOW });
    expect(cell(strip, "today").totalPence).toBe(7500);
    expect(cell(strip, "today").unavailableReason).toBeNull();
    expect(cell(strip, "today").appointmentCount).toBeNull();
    expect(cell(strip, "today").appointmentUnavailableReason).toBe(
      "Appointment count unavailable for this period.",
    );
  });

  it("blanks the appointment count for periods the appointment scan does not reach", () => {
    const strip = computeTakingsStrip({
      payments,
      paymentsCoverage: coverage,
      appointments: [appt("2026-07-30"), appt("2026-07-29")],
      appointmentsCoverage: { from: "2026-07-29", to: "2026-07-30" },
      now: NOW,
    });
    expect(cell(strip, "today").appointmentCount).toBe(1);
    expect(cell(strip, "yesterday").appointmentCount).toBe(1);
    expect(cell(strip, "last7").appointmentCount).toBeNull();
    expect(cell(strip, "last7").totalPence).not.toBeNull();
  });

  it("carries the normaliser's drop count through for the panel to disclose", () => {
    const strip = computeTakingsStrip({
      payments,
      paymentsCoverage: coverage,
      paymentsDropped: 3,
      now: NOW,
    });
    expect(strip.droppedPayments).toBe(3);
  });

  it("rolls the windows at London midnight, not UTC midnight", () => {
    const lateBst = new Date("2026-07-30T23:30:00Z"); // 00:30 on the 31st, London
    const strip = computeTakingsStrip({
      payments: [pay("2026-07-31", 4242), pay("2026-07-30", 1111)],
      paymentsCoverage: { from: "2026-05-01", to: "2026-07-31" },
      now: lateBst,
    });
    expect(cell(strip, "today").totalPence).toBe(4242);
    expect(cell(strip, "yesterday").totalPence).toBe(1111);
  });
});

describe("normaliseRollupDay", () => {
  const raw = {
    site_id: "site-cc",
    day: "2026-07-29",
    takings_pence: 306020,
    payment_count: 42,
    appointments_total: 76,
    appointments_completed: 70,
    appointments_cancelled: 4,
    appointments_dna: 2,
    uda_completed_hundredths: 15600,
    uda_invalid_hundredths: 300,
    source_complete: true,
  };

  it("reads a complete row", () => {
    expect(normaliseRollupDay(raw)?.takingsPence).toBe(306020);
    expect(normaliseRollupDay(raw)?.sourceComplete).toBe(true);
  });

  /** The row without one key, for proving a missing column is not read as zero. */
  function without(key: keyof typeof raw): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...raw };
    delete copy[key];
    return copy;
  }

  it("drops a row missing any counted column rather than zeroing it", () => {
    expect(normaliseRollupDay(without("takings_pence"))).toBeNull();
    expect(normaliseRollupDay(without("appointments_total"))).toBeNull();
    expect(normaliseRollupDay(without("day"))).toBeNull();
  });

  it("treats a missing source_complete as incomplete", () => {
    expect(normaliseRollupDay(without("source_complete"))?.sourceComplete).toBe(false);
  });

  it("defaults the diagnostic counters to zero without dropping the row", () => {
    const row = normaliseRollupDay(raw);
    expect(row?.paymentsDropped).toBe(0);
    expect(row?.nhsClaimCount).toBe(0);
    expect(normaliseRollupDay({ ...raw, payments_dropped: 3 })?.paymentsDropped).toBe(3);
  });

  it("counts the drops across a batch", () => {
    const { rows, dropped } = normaliseRollupDays([raw, { site_id: "site-cc" }]);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

describe("computeTakingsStripFromRollup", () => {
  const SITES = ["site-cc", "site-rv", "site-ng"];

  function rollup(day: string, siteId: string, pence: number, complete = true): DashboardRollupDay {
    return {
      siteId,
      day,
      takingsPence: pence,
      paymentCount: 1,
      appointmentsTotal: 2,
      appointmentsCompleted: 2,
      appointmentsCancelled: 0,
      appointmentsDna: 0,
      udaCompletedHundredths: 100,
      udaInvalidHundredths: 0,
      sourceComplete: complete,
      paymentsDropped: 0,
      appointmentsUnrecognised: 0,
      nhsClaimCount: 1,
      nhsClaimsUnrecognised: 0,
    };
  }

  /** Ninety complete days for all three sites, ending today. */
  function fullRollup(): DashboardRollupDay[] {
    const rows: DashboardRollupDay[] = [];
    for (let i = 0; i < 90; i += 1) {
      const day = new Date(Date.parse("2026-07-30T00:00:00Z") - i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (const site of SITES) rows.push(rollup(day, site, 1000));
    }
    return rows;
  }

  it("serves every period once the rollup is complete", () => {
    const strip = computeTakingsStripFromRollup({ rollups: fullRollup(), siteIds: SITES, now: NOW });
    expect(cell(strip, "today").totalPence).toBe(3000);
    expect(cell(strip, "yesterday").totalPence).toBe(3000);
    expect(cell(strip, "last7").totalPence).toBe(21_000);
    expect(cell(strip, "last30").totalPence).toBe(90_000);
    expect(cell(strip, "last90").totalPence).toBe(270_000);
    expect(cell(strip, "last90").appointmentCount).toBe(90 * 3 * 2);
  });

  it("scopes to one site for the per-site toggle", () => {
    const strip = computeTakingsStripFromRollup({
      rollups: fullRollup(),
      siteIds: SITES,
      now: NOW,
      siteId: "site-rv",
    });
    expect(cell(strip, "today").totalPence).toBe(1000);
    expect(cell(strip, "last7").totalPence).toBe(7000);
  });

  it("blanks a period with a missing day rather than understating it", () => {
    const rows = fullRollup().filter((r) => !(r.day === "2026-07-26" && r.siteId === "site-ng"));
    const strip = computeTakingsStripFromRollup({ rollups: rows, siteIds: SITES, now: NOW });
    expect(cell(strip, "today").totalPence).toBe(3000);
    expect(cell(strip, "last7").totalPence).toBeNull();
    expect(cell(strip, "last7").unavailableReason).toContain("has not been built");
    expect(cell(strip, "last30").totalPence).toBeNull();
  });

  it("blanks a period whose rollup day was built from an incomplete scan", () => {
    const rows = fullRollup().map((r) =>
      r.day === "2026-07-28" && r.siteId === "site-cc" ? { ...r, sourceComplete: false } : r,
    );
    const strip = computeTakingsStripFromRollup({ rollups: rows, siteIds: SITES, now: NOW });
    expect(cell(strip, "yesterday").totalPence).toBe(3000);
    expect(cell(strip, "last7").totalPence).toBeNull();
  });

  it("does not report a group total when a whole site never reported", () => {
    const rows = fullRollup().filter((r) => r.siteId !== "site-ng");
    const strip = computeTakingsStripFromRollup({ rollups: rows, siteIds: SITES, now: NOW });
    expect(cell(strip, "today").totalPence).toBeNull();
    // The site that did report is still readable on its own.
    const scoped = computeTakingsStripFromRollup({
      rollups: rows,
      siteIds: SITES,
      now: NOW,
      siteId: "site-cc",
    });
    expect(cell(scoped, "today").totalPence).toBe(1000);
  });
});
