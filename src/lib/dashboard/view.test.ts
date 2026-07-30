import { describe, expect, it } from "vitest";
import type {
  DashboardAccountBalance,
  DashboardAppointment,
  DashboardNhsClaim,
  DashboardPatient,
  DashboardPayment,
  DashboardTreatmentPlan,
} from "@/lib/dashboard/normalise";
import type { DashboardRollupDay } from "@/lib/dashboard/takings";
import {
  buildDashboardView,
  initialsOf,
  metric,
  stateLabelOf,
  toAppointmentRow,
  typeKeyOf,
  type AppointmentSource,
  type BuildViewInput,
  type DashboardInvoice,
} from "@/lib/dashboard/view";

// A fixed instant in British Summer Time, so every London conversion in here is
// exercised against a +01:00 offset rather than the easy winter case.
const NOW = new Date("2026-07-30T10:00:00Z");
const TODAY = "2026-07-30";
const YESTERDAY = "2026-07-29";

const SITES = [
  { id: "site-cc", name: "N15 Vitality Dental" },
  { id: "site-rv", name: "N17 Dental" },
];

const PRACTITIONERS = [
  { id: "prac-1", name: "Dana Hale" },
  { id: "prac-2", name: "Femi Osei" },
];

function payment(over: Partial<DashboardPayment>): DashboardPayment {
  return {
    id: "pay-1",
    amountPence: 10_000,
    day: TODAY,
    siteId: "site-cc",
    practitionerId: "prac-1",
    patientId: "pat-1",
    deleted: false,
    ...over,
  };
}

function appointment(over: Partial<DashboardAppointment>): DashboardAppointment {
  return {
    id: "appt-1",
    day: TODAY,
    siteId: "site-cc",
    practitionerId: "prac-1",
    patientId: "pat-1",
    state: "Completed",
    ...over,
  };
}

function claim(over: Partial<DashboardNhsClaim>): DashboardNhsClaim {
  return {
    id: "claim-1",
    siteId: "site-cc",
    practitionerId: "prac-1",
    day: TODAY,
    expectedUdaHundredths: 100,
    awardedUdaHundredths: 100,
    status: "submitted",
    band: "1",
    ...over,
  };
}

function baseInput(over: Partial<BuildViewInput> = {}): BuildViewInput {
  return {
    now: NOW,
    sites: SITES,
    practitioners: PRACTITIONERS,
    payments: [],
    paymentsCoverage: { from: "2026-05-02", to: TODAY },
    appointments: [],
    appointmentsCoverage: { from: "2026-05-02", to: TODAY },
    appointmentRows: [],
    patients: [],
    plans: [],
    invoices: [],
    balances: [],
    claims: [],
    ...over,
  };
}

function scopeOf(view: ReturnType<typeof buildDashboardView>, siteId: string | null) {
  const scope = view.scopes.find((s) => s.siteId === siteId);
  if (!scope) throw new Error(`no scope for ${siteId}`);
  return scope;
}

describe("metric", () => {
  it("keeps a real zero, which is not the same as unavailable", () => {
    expect(metric(0, "why not")).toEqual({ value: 0, reason: null });
  });

  it("carries the reason when there is no figure", () => {
    expect(metric(null, "why not")).toEqual({ value: null, reason: "why not" });
  });
});

describe("scopes", () => {
  it("builds all sites first, then one per site", () => {
    const view = buildDashboardView(baseInput());
    expect(view.scopes.map((s) => s.siteId)).toEqual([null, "site-cc", "site-rv"]);
    expect(view.scopes[0].label).toBe("All sites");
    expect(view.scopes[1].label).toBe("N15 Vitality Dental");
  });

  it("totals takings per site and for the group", () => {
    const view = buildDashboardView(
      baseInput({
        payments: [
          payment({ id: "a", amountPence: 5_000, siteId: "site-cc" }),
          payment({ id: "b", amountPence: 2_500, siteId: "site-rv" }),
        ],
      }),
    );
    const today = (siteId: string | null) =>
      scopeOf(view, siteId).strip.cells.find((c) => c.period === "today");
    expect(today(null)?.totalPence).toBe(7_500);
    expect(today("site-cc")?.totalPence).toBe(5_000);
    expect(today("site-rv")?.totalPence).toBe(2_500);
  });
});

describe("the takings strip and its freshness", () => {
  it("marks a covered cell as live", () => {
    const view = buildDashboardView(
      baseInput({ payments: [payment({})], paymentsCoverage: { from: YESTERDAY, to: TODAY } }),
    );
    expect(scopeOf(view, null).stripSources.today).toBe("live");
  });

  it("blanks a period the scan cannot reach, and gives no source for it", () => {
    const view = buildDashboardView(
      baseInput({ payments: [payment({})], paymentsCoverage: { from: YESTERDAY, to: TODAY } }),
    );
    const scope = scopeOf(view, null);
    const last30 = scope.strip.cells.find((c) => c.period === "last30");
    expect(last30?.totalPence).toBeNull();
    expect(last30?.unavailableReason).toContain("does not reach back");
    expect(scope.stripSources.last30).toBeUndefined();
  });

  it("fills an unreachable period from the rollup and says it came from there", () => {
    const days: DashboardRollupDay[] = [];
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      for (const siteId of ["site-cc", "site-rv"]) {
        days.push({
          siteId,
          day,
          takingsPence: 1_000,
          paymentCount: 1,
          appointmentsTotal: 2,
          appointmentsCompleted: 2,
          appointmentsCancelled: 0,
          appointmentsDna: 0,
          udaCompletedHundredths: 0,
          udaInvalidHundredths: 0,
          sourceComplete: true,
          paymentsDropped: 0,
          appointmentsUnrecognised: 0,
          nhsClaimCount: 0,
          nhsClaimsUnrecognised: 0,
        });
      }
    }
    const view = buildDashboardView(
      baseInput({
        payments: [payment({})],
        paymentsCoverage: { from: YESTERDAY, to: TODAY },
        rollups: days,
      }),
    );
    const scope = scopeOf(view, null);
    expect(scope.strip.cells.find((c) => c.period === "last7")?.totalPence).toBe(14_000);
    expect(scope.stripSources.last7).toBe("rollup");
    // Today is still the live figure, not the rollup's.
    expect(scope.stripSources.today).toBe("live");
  });

  it("never reports a takings figure of zero for an unsourceable period", () => {
    const view = buildDashboardView(baseInput({ paymentsCoverage: null }));
    for (const cell of scopeOf(view, null).strip.cells) {
      expect(cell.totalPence).toBeNull();
      expect(cell.unavailableReason).not.toBeNull();
    }
  });
});

describe("the donut", () => {
  it("counts the three states and leaves everything else out of them", () => {
    const view = buildDashboardView(
      baseInput({
        appointments: [
          appointment({ id: "1", state: "Completed" }),
          appointment({ id: "2", state: "Completed" }),
          appointment({ id: "3", state: "Cancelled" }),
          appointment({ id: "4", state: "Did not attend" }),
          appointment({ id: "5", state: "booked" }),
        ],
      }),
    );
    const panel = scopeOf(view, null).periods.today.appointments;
    expect(panel.completed.value).toBe(2);
    expect(panel.cancelled.value).toBe(1);
    expect(panel.dna.value).toBe(1);
    expect(panel.other.value).toBe(1);
    expect(panel.total.value).toBe(5);
  });

  it("reports an unrecognised state instead of filing it in a slice", () => {
    const view = buildDashboardView(
      baseInput({ appointments: [appointment({ state: "Left without being seen" })] }),
    );
    const panel = scopeOf(view, null).periods.today.appointments;
    expect(panel.unknownStates).toEqual(["Left without being seen"]);
    expect(panel.completed.value).toBe(0);
    expect(panel.other.value).toBe(1);
  });

  it("is unavailable, not zero, when appointments could not be read", () => {
    const view = buildDashboardView(baseInput({ appointments: null, appointmentsCoverage: null }));
    const panel = scopeOf(view, null).periods.today.appointments;
    expect(panel.total.value).toBeNull();
    expect(panel.total.reason).toContain("could not be read");
  });

  it("is unavailable for a period the appointment scan does not cover", () => {
    const view = buildDashboardView(
      baseInput({ appointmentsCoverage: { from: YESTERDAY, to: TODAY } }),
    );
    const scope = scopeOf(view, null);
    expect(scope.periods.today.appointments.total.value).toBe(0);
    expect(scope.periods.last90.appointments.total.value).toBeNull();
  });
});

describe("accounts", () => {
  const balances: DashboardAccountBalance[] = [
    { patientId: "pat-1", patientName: "Ada Bell", owedPence: 40_000 },
    { patientId: "pat-2", patientName: "Ben Cole", owedPence: 15_000 },
    { patientId: "pat-3", patientName: "Cara Dunn", owedPence: -5_000 },
  ];

  it("shows the net balance and ranks who owes most", () => {
    const view = buildDashboardView(baseInput({ balances }));
    const panel = scopeOf(view, null).accounts;
    expect(panel.netBalancePence.value).toBe(50_000);
    expect(panel.totalOwedPence.value).toBe(55_000);
    expect(panel.top.map((a) => a.patientId)).toEqual(["pat-1", "pat-2"]);
    expect(panel.patientsInDebt.value).toBe(2);
  });

  it("attributes a balance to a site through the patient, never by assumption", () => {
    const view = buildDashboardView(
      baseInput({
        balances,
        siteByPatientId: new Map([
          ["pat-1", "site-cc"],
          ["pat-2", "site-rv"],
          // pat-3 is not placed at all, so it belongs to no single site view.
        ]),
      }),
    );
    expect(scopeOf(view, "site-cc").accounts.netBalancePence.value).toBe(40_000);
    expect(scopeOf(view, "site-rv").accounts.netBalancePence.value).toBe(15_000);
  });

  it("is unavailable when balances could not be read", () => {
    const view = buildDashboardView(baseInput({ balances: null }));
    expect(scopeOf(view, null).accounts.netBalancePence.value).toBeNull();
  });
});

describe("invoiced", () => {
  const invoices: DashboardInvoice[] = [
    { id: "i1", patientId: "pat-1", day: TODAY, grossPence: 20_000, outstandingPence: 5_000 },
    { id: "i2", patientId: "pat-2", day: YESTERDAY, grossPence: 10_000, outstandingPence: 0 },
  ];

  it("totals the selected window only", () => {
    const view = buildDashboardView(baseInput({ invoices }));
    const scope = scopeOf(view, null);
    expect(scope.periods.today.invoiced.totalPence.value).toBe(20_000);
    expect(scope.periods.today.invoiced.paidPence.value).toBe(15_000);
    expect(scope.periods.today.invoiced.unpaidPence.value).toBe(5_000);
    expect(scope.periods.last7.invoiced.totalPence.value).toBe(30_000);
  });

  it("reports unavailable when every invoice read carried no date", () => {
    const view = buildDashboardView(baseInput({ invoices: [], undatedInvoices: 12 }));
    const panel = scopeOf(view, null).periods.today.invoiced;
    expect(panel.totalPence.value).toBeNull();
    expect(panel.totalPence.reason).toContain("no invoice carries a date");
    expect(panel.undatedInvoices).toBe(12);
  });
});

describe("patients and treatment plans", () => {
  it("reports new patients as unavailable when no record carries a registration date", () => {
    const patients: DashboardPatient[] = [
      { id: "pat-1", siteId: "site-cc", createdDay: null, active: true, archived: false },
    ];
    const view = buildDashboardView(baseInput({ patients }));
    const panel = scopeOf(view, null).periods.today.patients;
    expect(panel.newCount.value).toBeNull();
    expect(panel.newCount.reason).toContain("registration date");
    expect(panel.activeCount.value).toBe(1);
  });

  it("counts a genuinely empty window as zero, not unavailable", () => {
    const patients: DashboardPatient[] = [
      { id: "pat-1", siteId: "site-cc", createdDay: "2020-01-01", active: true, archived: false },
    ];
    const view = buildDashboardView(baseInput({ patients }));
    expect(scopeOf(view, null).periods.today.patients.newCount.value).toBe(0);
  });

  it("reports finished and open plans as unavailable when the source has no finish field", () => {
    const plans: DashboardTreatmentPlan[] = [
      {
        id: "plan-1",
        siteId: "site-cc",
        startedDay: TODAY,
        finishedDay: null,
        hasFinishField: false,
      },
    ];
    const view = buildDashboardView(baseInput({ plans }));
    const panel = scopeOf(view, null).periods.today.plans;
    expect(panel.started.value).toBe(1);
    expect(panel.finished.value).toBeNull();
    expect(panel.open.value).toBeNull();
  });
});

describe("UDAs", () => {
  it("splits completed and invalid inside the window", () => {
    const view = buildDashboardView(
      baseInput({
        claims: [
          claim({ id: "c1", awardedUdaHundredths: 300, expectedUdaHundredths: 300 }),
          claim({ id: "c2", status: "rejected", expectedUdaHundredths: 100, awardedUdaHundredths: 0 }),
        ],
      }),
    );
    const panel = scopeOf(view, null).periods.today.uda;
    expect(panel.completedUda.value).toBe(3);
    expect(panel.invalidUda.value).toBe(1);
  });

  it("names the practitioner on the breakdown", () => {
    const view = buildDashboardView(
      baseInput({ claims: [claim({ practitionerId: "prac-2" })] }),
    );
    const rows = scopeOf(view, null).periods.today.uda.byPractitioner;
    expect(rows[0].name).toBe("Femi Osei");
  });

  it("counts an unrecognised claim status toward neither figure", () => {
    const view = buildDashboardView(
      baseInput({ claims: [claim({ status: "awaiting_pcse_response", expectedUdaHundredths: 1_200 })] }),
    );
    const panel = scopeOf(view, null).periods.today.uda;
    expect(panel.completedUda.value).toBe(0);
    expect(panel.invalidUda.value).toBe(0);
    expect(panel.unrecognisedClaimCount).toBe(1);
    expect(panel.unknownStatuses).toEqual(["awaiting_pcse_response"]);
  });

  it("has no contract progress at all without a configured target", () => {
    const view = buildDashboardView(baseInput({ claims: [claim({})] }));
    const panel = scopeOf(view, null).udaProgress;
    expect(panel.progress).toBeNull();
    expect(panel.targetUda.value).toBeNull();
    expect(panel.reason).toContain("not configured");
  });

  it("computes progress and pace once a target is configured for every site in scope", () => {
    const view = buildDashboardView(
      baseInput({
        claims: [claim({ awardedUdaHundredths: 100_000, expectedUdaHundredths: 100_000 })],
        udaTargets: { "site-cc": 4_000, "site-rv": 6_000 },
      }),
    );
    const group = scopeOf(view, null).udaProgress;
    expect(group.targetUda.value).toBe(10_000);
    expect(group.progress?.completedUda).toBe(1_000);
    expect(group.progress?.contractYear).toEqual({ start: "2026-04-01", end: "2027-03-31" });
  });

  it("blanks the group target when one site in scope is unconfigured", () => {
    const view = buildDashboardView(
      baseInput({ claims: [claim({})], udaTargets: { "site-cc": 4_000 } }),
    );
    expect(scopeOf(view, null).udaProgress.targetUda.value).toBeNull();
    expect(scopeOf(view, "site-cc").udaProgress.targetUda.value).toBe(4_000);
  });
});

describe("appointment rows", () => {
  const siteNames = new Map(SITES.map((s) => [s.id, s.name]));

  function source(over: Partial<AppointmentSource>): AppointmentSource {
    return {
      id: "a1",
      startIso: "2026-07-30T08:30:00Z",
      durationMin: 30,
      patientId: "pat-1",
      patientName: "Eleanor Whitfield",
      siteId: "site-cc",
      practitionerId: "prac-1",
      practitionerName: "Dana Hale",
      reason: "Continuing Treatment",
      note: "aligners received, given to maria",
      state: "Confirmed",
      ...over,
    };
  }

  it("renders the London wall clock, not the UTC instant", () => {
    const row = toAppointmentRow(source({}), siteNames);
    // 08:30 UTC in July is 09:30 in London.
    expect(row?.time).toBe("09:30");
    expect(row?.day).toBe("2026-07-30");
  });

  it("buckets a late evening instant onto the right London day", () => {
    const row = toAppointmentRow(source({ startIso: "2026-07-30T23:30:00Z" }), siteNames);
    expect(row?.day).toBe("2026-07-31");
  });

  it("resolves the site name and marks a confirmed booking as still to be completed", () => {
    const row = toAppointmentRow(source({}), siteNames);
    expect(row?.siteName).toBe("N15 Vitality Dental");
    expect(row?.remaining).toBe(true);
  });

  it("does not treat a completed appointment as remaining", () => {
    const row = toAppointmentRow(source({ state: "Completed" }), siteNames);
    expect(row?.remaining).toBe(false);
    expect(row?.bucket).toBe("completed");
  });

  it("drops a row with an unparseable start rather than dating it now", () => {
    expect(toAppointmentRow(source({ startIso: "not a date" }), siteNames)).toBeNull();
  });

  it("orders newest first and discloses a cap", () => {
    const rows: AppointmentSource[] = [
      source({ id: "old", startIso: "2026-06-01T09:00:00Z" }),
      source({ id: "new", startIso: "2026-07-30T09:00:00Z" }),
      source({ id: "mid", startIso: "2026-07-01T09:00:00Z" }),
    ];
    const view = buildDashboardView(baseInput({ appointmentRows: rows, appointmentRowCap: 2 }));
    expect(view.appointments.map((r) => r.id)).toEqual(["new", "mid"]);
    expect(view.appointmentsCapped).toBe(true);
    expect(view.appointmentsInWindow).toBe(3);
  });
});

describe("display helpers", () => {
  it("takes two initials and never invents a letter", () => {
    expect(initialsOf("Eleanor Whitfield")).toBe("EW");
    expect(initialsOf("Cher")).toBe("C");
    expect(initialsOf("   ")).toBe("?");
  });

  it("tidies a state without re-wording it", () => {
    expect(stateLabelOf("did_not_attend")).toBe("Did not attend");
    expect(stateLabelOf("booked")).toBe("Booked");
    expect(stateLabelOf("")).toBe("Unknown");
  });

  it("gives a stable type key, including for a missing reason", () => {
    expect(typeKeyOf("New patient exam")).toBe("new-patient-exam");
    expect(typeKeyOf(null)).toBe("unspecified");
    expect(typeKeyOf("  ")).toBe("unspecified");
  });
});
