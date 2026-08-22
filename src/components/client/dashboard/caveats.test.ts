import { describe, expect, it } from "vitest";
import type { DashboardPeriod } from "@/lib/dashboard/period";
import type { TakingsCell, TakingsStrip } from "@/lib/dashboard/takings";
import type {
  AccountsPanel,
  AppointmentsPanel,
  InvoicedPanel,
  UdaProgressPanel,
  UdaWindowPanel,
} from "@/lib/dashboard/view";
import {
  accountsCaveats,
  appointmentsCaveats,
  caveatSummary,
  invoicedCaveats,
  leadCaveat,
  takingsCaveats,
  udaCaveats,
} from "./caveats";

// The caveats used to be four grey paragraphs printed under the band. They are
// now collapsed into one row, which is only acceptable if nothing is lost: every
// caveat the panels used to print must still be built, in full, whenever its
// condition holds. These tests are that guarantee.

const window = { from: "2026-07-30", to: "2026-07-30" };

function cell(period: DashboardPeriod, total: number | null, reason: string | null = null): TakingsCell {
  return {
    period,
    window,
    totalPence: total,
    paymentCount: total === null ? null : 1,
    appointmentCount: 3,
    unavailableReason: reason,
    appointmentUnavailableReason: null,
  };
}

function strip(cells: TakingsCell[], siteId: string | null = null): TakingsStrip {
  return { cells, droppedPayments: 0, unattributedPayments: 0, siteId } as TakingsStrip;
}

describe("takingsCaveats", () => {
  it("always states where the figures came from", () => {
    const out = takingsCaveats({
      strip: strip([cell("today", 1000)]),
      unattributedPayments: 0,
      droppedPayments: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("takings-source");
    expect(out[0].material).toBe(false);
    // The sentence a practice manager reads under the takings band has to be TRUE.
    // It used to say the long periods came from the nightly rollup "because Dentally
    // does not filter payments by date" — the false premise that understated her
    // takings by 38% over thirty days and 85% over ninety.
    expect(out[0].text).toContain("read live from Dentally");
    expect(out[0].text).toContain("exact total for the dates asked for");
    expect(out[0].text).not.toContain("nightly rollup");
    expect(out[0].text).not.toContain("does not filter");
  });

  it("names every blank period and carries its reason", () => {
    const out = takingsCaveats({
      strip: strip([
        cell("today", 1000),
        cell("last30", null, "Unavailable: the nightly rollup has not run."),
        cell("last90", null, "Unavailable: the nightly rollup has not run."),
      ]),
      unattributedPayments: 0,
      droppedPayments: 0,
    });
    const blank = out.find((c) => c.id === "takings-blank");
    expect(blank).toBeDefined();
    expect(blank?.label).toBe("2 periods blank");
    expect(blank?.text).toContain("last 30 days, last 90 days are blank");
    expect(blank?.text).toContain("the nightly rollup has not run");
    expect(blank?.material).toBe(true);
  });

  it("discloses payments left out of a single site's total, and only for a site", () => {
    const perSite = takingsCaveats({
      strip: strip([cell("today", 1000)], "site-1"),
      unattributedPayments: 4,
      droppedPayments: 0,
    });
    expect(perSite.find((c) => c.id === "takings-unattributed")?.text).toContain("4 payments carry no site");

    const allSites = takingsCaveats({
      strip: strip([cell("today", 1000)], null),
      unattributedPayments: 4,
      droppedPayments: 0,
    });
    expect(allSites.find((c) => c.id === "takings-unattributed")).toBeUndefined();
  });

  it("never lets an unreadable payment go unmentioned", () => {
    const out = takingsCaveats({
      strip: strip([cell("today", 1000)]),
      unattributedPayments: 0,
      droppedPayments: 1,
    });
    const dropped = out.find((c) => c.id === "takings-dropped");
    expect(dropped?.material).toBe(true);
    expect(dropped?.text).toBe("1 payment record could not be read and is counted in no total.");
  });
});

describe("appointmentsCaveats", () => {
  const base: AppointmentsPanel = {
    completed: { value: 1, reason: null },
    cancelled: { value: 0, reason: null },
    dna: { value: 0, reason: null },
    other: { value: 2, reason: null },
    total: { value: 3, reason: null },
    unknownStates: [],
  };

  it("says nothing when every state was recognised", () => {
    expect(appointmentsCaveats(base)).toEqual([]);
  });

  it("lists the first three unrecognised states and says where they were counted", () => {
    const out = appointmentsCaveats({ ...base, unknownStates: ["a", "b", "c", "d"] });
    expect(out[0].text).toContain("(a, b, c, and others)");
    expect(out[0].text).toContain("counted as still to come");
    expect(out[0].material).toBe(true);
  });
});

describe("accountsCaveats", () => {
  const base: AccountsPanel = {
    netBalancePence: { value: 1_000_00, reason: null },
    totalOwedPence: { value: 1_000_00, reason: null },
    patientsInDebt: { value: 3, reason: null },
    top: [],
    dropped: 0,
    unattributedUnpaid: null,
    siteId: null,
  };

  it("always explains that a balance ignores the selected period", () => {
    const out = accountsCaveats(base);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("does not change with the selected period");
  });

  it("explains the gap when credits net the headline down", () => {
    const out = accountsCaveats({ ...base, totalOwedPence: { value: 1_500_00, reason: null } });
    const credit = out.find((c) => c.id === "accounts-credit");
    expect(credit?.text).toContain("£1,500.00");
    expect(credit?.text).toContain("some accounts are in credit");
  });

  it("discloses balance rows that could not be read", () => {
    const out = accountsCaveats({ ...base, dropped: 2 });
    expect(out.find((c) => c.id === "accounts-dropped")?.text).toBe(
      "2 balance rows could not be read and are in no total.",
    );
  });
});

describe("invoicedCaveats", () => {
  const base: InvoicedPanel = {
    totalPence: { value: 100, reason: null },
    paidPence: { value: 60, reason: null },
    unpaidPence: { value: 40, reason: null },
    invoiceCount: { value: 2, reason: null },
    undatedInvoices: 0,
    droppedInvoices: 0,
  };

  it("says nothing when every invoice carries a date", () => {
    expect(invoicedCaveats(base)).toEqual([]);
  });

  it("agrees its verbs with the count", () => {
    expect(invoicedCaveats({ ...base, undatedInvoices: 1 })[0].text).toBe(
      "1 invoice carries no date and cannot be placed in a period, so it is counted here in no period at all.",
    );
    expect(invoicedCaveats({ ...base, undatedInvoices: 19 })[0].text).toBe(
      "19 invoices carry no date and cannot be placed in a period, so they are counted here in no period at all.",
    );
  });
});

describe("udaCaveats", () => {
  const uda: UdaWindowPanel = {
    completedUda: { value: 51, reason: null },
    invalidUda: { value: 0, reason: null },
    byPractitioner: [],
    unrecognisedClaimCount: 0,
    unknownStatuses: [],
  };
  const progress = (p: UdaProgressPanel["progress"], reason: string | null): UdaProgressPanel => ({
    contractYear: { start: "2026-04-01", end: "2027-03-31" },
    completedUda: { value: 51, reason: null },
    invalidUda: { value: 0, reason: null },
    targetUda: { value: null, reason },
    progress: p,
    reason,
  });

  it("carries the contract reason verbatim when progress cannot be shown", () => {
    const out = udaCaveats(uda, progress(null, "The annual UDA target is not configured."));
    expect(out[0].id).toBe("uda-contract");
    expect(out[0].text).toBe("The annual UDA target is not configured.");
    expect(out[0].material).toBe(true);
  });

  it("discloses claims filed into neither figure", () => {
    const out = udaCaveats(
      { ...uda, unrecognisedClaimCount: 3, unknownStatuses: ["queued", "held"] },
      progress(null, "no target"),
    );
    expect(out.find((c) => c.id === "uda-claims")?.text).toContain("(queued, held)");
  });
});

describe("the mark beside a figure", () => {
  it("hands the reader every sentence, not a summary of them", () => {
    const caveats = accountsCaveats({
      netBalancePence: { value: 1_000_00, reason: null },
      totalOwedPence: { value: 1_500_00, reason: null },
      patientsInDebt: { value: 3, reason: null },
      top: [],
      dropped: 2,
      unattributedUnpaid: null,
      siteId: null,
    });
    const summary = caveatSummary(caveats);
    for (const c of caveats) expect(summary).toContain(c.text);
  });

  it("opens the money caveat first, not the explanatory one", () => {
    const caveats = accountsCaveats({
      netBalancePence: { value: 1_000_00, reason: null },
      totalOwedPence: { value: 1_500_00, reason: null },
      patientsInDebt: { value: 3, reason: null },
      top: [],
      dropped: 0,
      unattributedUnpaid: null,
      siteId: null,
    });
    expect(leadCaveat(caveats)?.id).toBe("accounts-credit");
  });

  it("has nothing to open when there is nothing to say", () => {
    expect(leadCaveat([])).toBeNull();
    expect(caveatSummary([])).toBe("");
  });
});
