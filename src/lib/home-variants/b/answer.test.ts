import { describe, expect, it } from "vitest";
import type { DashboardPeriod, DayWindow } from "@/lib/dashboard/period";
import type { TakingsCell, TakingsStrip } from "@/lib/dashboard/takings";
import { metric, type PeriodPanels, type ScopeView } from "@/lib/dashboard/view";
import { composeAnswer, PANEL_ANCHOR } from "./answer";

// ---------------------------------------------------------------------------
// Fixtures. Everything defaults to a readable, unremarkable day; each test
// overrides only the figures it is about, so a failure names its own cause.
// ---------------------------------------------------------------------------

const WINDOW: DayWindow = { from: "2026-07-31", to: "2026-07-31" };

function cell(period: DashboardPeriod, over: Partial<TakingsCell> = {}): TakingsCell {
  return {
    period,
    window: WINDOW,
    totalPence: 306_020,
    paymentCount: 18,
    appointmentCount: 34,
    unavailableReason: null,
    appointmentUnavailableReason: null,
    ...over,
  };
}

function strip(over: Partial<TakingsCell> = {}): TakingsStrip {
  return {
    cells: [
      cell("today", over),
      cell("yesterday"),
      cell("last7"),
      cell("last30"),
      cell("last90"),
    ],
    droppedPayments: 0,
    unattributedPayments: 0,
    deletedPayments: 0,
    siteId: null,
  };
}

function panels(over: {
  total?: number | null;
  completed?: number | null;
  cancelled?: number | null;
  dna?: number | null;
  other?: number | null;
  unpaidPence?: number | null;
} = {}): PeriodPanels {
  const reason = "Unavailable: appointments could not be read from Dentally.";
  return {
    period: "today",
    window: WINDOW,
    appointments: {
      completed: metric(over.completed === undefined ? 20 : over.completed, reason),
      cancelled: metric(over.cancelled === undefined ? 0 : over.cancelled, reason),
      dna: metric(over.dna === undefined ? 0 : over.dna, reason),
      other: metric(over.other === undefined ? 14 : over.other, reason),
      total: metric(over.total === undefined ? 34 : over.total, reason),
      unknownStates: [],
    },
    invoiced: {
      totalPence: metric(500_000, "x"),
      paidPence: metric(500_000, "x"),
      unpaidPence: metric(over.unpaidPence === undefined ? 0 : over.unpaidPence, "x"),
      invoiceCount: metric(12, "x"),
      undatedInvoices: 0,
    },
    patients: {
      newCount: metric(28, "x"),
      seenCount: metric(46, "x"),
      activeCount: metric(49_403, "x"),
    },
    plans: { started: metric(54, "x"), finished: metric(44, "x"), open: metric(11_599, "x") },
    uda: {
      completedUda: metric(120, "x"),
      invalidUda: metric(0, "x"),
      byPractitioner: [],
      unrecognisedClaimCount: 0,
      unknownStatuses: [],
    },
  };
}

function scope(over: {
  stripOver?: Partial<TakingsCell>;
  netBalancePence?: number | null;
  patientsInDebt?: number | null;
  varianceUda?: number | null;
  siteId?: string | null;
  unattributedPayments?: number;
} = {}): ScopeView {
  const contractYear = { start: "2026-04-01", end: "2027-03-31" };
  const variance = over.varianceUda === undefined ? 40 : over.varianceUda;
  return {
    siteId: over.siteId ?? null,
    label: "All sites",
    strip: strip(over.stripOver),
    stripSources: { today: "live" },
    accounts: {
      netBalancePence: metric(
        over.netBalancePence === undefined ? 14_884_660 : over.netBalancePence,
        "x",
      ),
      totalOwedPence: metric(14_884_660, "x"),
      patientsInDebt: metric(over.patientsInDebt === undefined ? 512 : over.patientsInDebt, "x"),
      top: [],
      dropped: 0,
    },
    udaProgress: {
      contractYear,
      completedUda: metric(1200, "x"),
      invalidUda: metric(0, "x"),
      targetUda: metric(9000, "x"),
      progress:
        variance === null
          ? null
          : {
              contractYear,
              targetUda: 9000,
              completedUda: 1200,
              percentOfTarget: 13.3,
              daysElapsed: 121,
              daysTotal: 365,
              daysRemaining: 244,
              expectedUdaByNow: 1200 - variance,
              varianceUda: variance,
              paceUdaPerDay: 9.9,
              requiredUdaPerDay: 31.9,
              projectedYearEndUda: 3620,
              projectedShortfallUda: 5380,
            },
      reason: variance === null ? "Unavailable: no annual UDA target is configured." : null,
    },
    periods: {} as ScopeView["periods"],
    unattributedPayments: over.unattributedPayments ?? 0,
  };
}

function answerFor(args: Parameters<typeof composeAnswer>[0]) {
  return composeAnswer(args);
}

const base = () => ({ period: "today" as const, scope: scope(), panels: panels(), droppedPayments: 0 });

// ---------------------------------------------------------------------------

describe("composeAnswer headline", () => {
  it("leads with the money and the appointment count", () => {
    const a = answerFor(base());
    expect(a.headline).toBe("£3,060.20 taken today, across 34 appointments.");
    expect(a.confident).toBe(true);
  });

  it("names the period in the sentence, not only in a label", () => {
    const a = answerFor({ ...base(), period: "last30", panels: panels() });
    expect(a.headline).toContain("in the last 30 days");
  });

  it("says a single appointment in the singular", () => {
    const a = answerFor({ ...base(), panels: panels({ total: 1, completed: 1, other: 0 }) });
    expect(a.headline).toBe("£3,060.20 taken today, across 1 appointment.");
  });

  it("states that takings could not be read rather than printing a zero", () => {
    const a = answerFor({
      ...base(),
      scope: scope({
        stripOver: { totalPence: null, unavailableReason: "Unavailable: the payment scan did not reach this far." },
      }),
    });
    expect(a.headline).toBe("34 appointments today. Takings could not be read.");
    expect(a.headline).not.toContain("£0.00");
    expect(a.limits).toContain("Unavailable: the payment scan did not reach this far.");
  });

  it("states that the appointment count could not be read", () => {
    const a = answerFor({ ...base(), panels: panels({ total: null }) });
    expect(a.headline).toBe("£3,060.20 taken today. The appointment count could not be read.");
    expect(a.limits.length).toBeGreaterThan(0);
  });

  it("refuses to state a position when neither figure could be read", () => {
    const a = answerFor({
      ...base(),
      scope: scope({ stripOver: { totalPence: null, unavailableReason: "Unavailable: no rollup." } }),
      panels: panels({ total: null }),
    });
    expect(a.confident).toBe(false);
    expect(a.headline).toBe("Neither takings nor appointments could be read for today.");
  });
});

describe("composeAnswer attention", () => {
  it("puts missed appointments first and anchors them to the panel they came from", () => {
    const a = answerFor({ ...base(), panels: panels({ dna: 3, cancelled: 2 }) });
    expect(a.clauses[0]).toMatchObject({
      id: "dna",
      text: "3 did not attend",
      tone: "attention",
      anchor: PANEL_ANCHOR.appointments,
    });
    expect(a.clauses[1].text).toBe("2 cancelled");
  });

  it("reports unpaid invoicing as money, against the invoiced panel", () => {
    const a = answerFor({ ...base(), panels: panels({ unpaidPence: 124_000 }) });
    const unpaid = a.clauses.find((c) => c.id === "unpaid");
    expect(unpaid).toMatchObject({ text: "£1,240.00 invoiced and unpaid", anchor: PANEL_ANCHOR.invoiced });
  });

  it("counts the accounts in debt when it knows how many", () => {
    const a = answerFor(base());
    const owed = a.clauses.find((c) => c.id === "owed");
    expect(owed?.text).toBe("£148,846.60 owed across 512 accounts");
  });

  it("still reports the money owed when the account count is unavailable", () => {
    const a = answerFor({ ...base(), scope: scope({ patientsInDebt: null }) });
    expect(a.clauses.find((c) => c.id === "owed")?.text).toBe("£148,846.60 owed on patient accounts");
  });

  it("reports a contract shortfall but never a surplus as attention", () => {
    const behind = answerFor({ ...base(), scope: scope({ varianceUda: -212.4 }) });
    expect(behind.clauses.find((c) => c.id === "uda")?.text).toBe("212 UDA behind an even year");
    const ahead = answerFor(base());
    expect(ahead.clauses.find((c) => c.id === "uda")).toBeUndefined();
  });

  it("says nothing is booked when the day is empty", () => {
    const a = answerFor({
      ...base(),
      panels: panels({ total: 0, completed: 0, cancelled: 0, dna: 0, other: 0 }),
    });
    expect(a.clauses[0]).toMatchObject({ id: "nothing-booked", tone: "attention" });
    // An empty day must not also claim that nobody missed an appointment.
    expect(a.clauses.some((c) => c.id === "clear")).toBe(false);
  });

  it("puts context after the work, never before it", () => {
    const a = answerFor({ ...base(), panels: panels({ dna: 1 }) });
    const tones = a.clauses.map((c) => c.tone);
    expect(tones.indexOf("attention")).toBeLessThan(tones.indexOf("plain"));
    expect(a.clauses.map((c) => c.id)).toContain("still-to-come");
  });
});

describe("composeAnswer when nothing needs attention", () => {
  it("names the checks that ran instead of reassuring", () => {
    const a = answerFor({ ...base(), scope: scope({ netBalancePence: 0, varianceUda: 40 }) });
    const clear = a.clauses.find((c) => c.id === "clear");
    expect(clear?.text).toBe(
      "Nobody missed an appointment, nothing was cancelled, every invoice raised was paid and no account is in debt",
    );
    expect(a.clauses.every((c) => c.tone === "plain")).toBe(true);
  });

  it("omits a check whose figure could not be read, rather than claiming it passed", () => {
    const a = answerFor({
      ...base(),
      scope: scope({ netBalancePence: null }),
      panels: panels({ dna: null, unpaidPence: 0 }),
    });
    const clear = a.clauses.find((c) => c.id === "clear");
    expect(clear?.text).toBe("Nothing was cancelled and every invoice raised was paid");
    expect(clear?.text).not.toContain("missed");
  });

  it("adds no clear clause at all when no check could run", () => {
    const a = answerFor({
      ...base(),
      scope: scope({ netBalancePence: null }),
      panels: panels({ dna: null, cancelled: null, unpaidPence: null, other: 0, completed: 0 }),
    });
    expect(a.clauses.find((c) => c.id === "clear")).toBeUndefined();
  });
});

describe("composeAnswer limits", () => {
  it("carries unread payment records, in the plural it deserves", () => {
    expect(answerFor({ ...base(), droppedPayments: 1 }).limits).toContain(
      "1 payment record could not be read and is counted in no total.",
    );
    expect(answerFor({ ...base(), droppedPayments: 4 }).limits).toContain(
      "4 payment records could not be read and are counted in no total.",
    );
  });

  it("discloses unsited payments only when one site is selected", () => {
    const group = answerFor({ ...base(), scope: scope({ unattributedPayments: 6 }) });
    expect(group.limits.some((l) => l.includes("carry no site"))).toBe(false);

    const one = answerFor({ ...base(), scope: scope({ siteId: "site-1", unattributedPayments: 6 }) });
    expect(one.limits.some((l) => l.includes("6 payments carry no site"))).toBe(true);
  });

  it("stays empty on a clean read, so the line carries no standing footnote", () => {
    expect(answerFor(base()).limits).toEqual([]);
  });
});
