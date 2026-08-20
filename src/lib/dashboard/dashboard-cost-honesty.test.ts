import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildDashboardView } from "@/lib/dashboard/view";
import type { DashboardPatient, DashboardTreatmentPlan } from "@/lib/dashboard/normalise";

// ---------------------------------------------------------------------------
// MAKING THE DASHBOARD CHEAPER MUST NOT MAKE IT LESS TRUE.
//
// The patient and treatment-plan scans were made cheap by narrowing them to the
// window with `updated_after`. Two of the figures they used to produce are not
// window questions and a narrowed scan cannot answer them:
//
//   ACTIVE PATIENTS  is a whole-book count. It now comes from the nightly count
//                    (/api/sync/patient-count), which really does page the whole
//                    book, off-hours. It must NEVER come from the narrowed scan.
//
//   OPEN PLANS       is "started before the end of the window and not finished".
//                    A plan opened three years ago and still open was not updated
//                    recently, so it is not in a narrowed set. It must report
//                    itself unavailable rather than count only recent plans.
//
// Both were previously computed over whatever few thousand rows the page cap
// happened to reach and printed as fact. A short count on a takings screen is
// acted on; a stated gap is questioned. These tests are the difference.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-20T10:00:00.000Z");
const SITES = [
  { id: "site-a", name: "Site A" },
  { id: "site-b", name: "Site B" },
];

function patient(over: Partial<DashboardPatient> & { id: string }): DashboardPatient {
  return {
    id: over.id,
    siteId: over.siteId ?? "site-a",
    createdDay: over.createdDay ?? "2026-08-19",
    active: over.active ?? true,
    archived: over.archived ?? false,
  } as DashboardPatient;
}

function plan(over: Partial<DashboardTreatmentPlan> & { id?: string }): DashboardTreatmentPlan {
  return {
    siteId: over.siteId ?? "site-a",
    startedDay: over.startedDay ?? null,
    finishedDay: over.finishedDay ?? null,
    hasFinishField: over.hasFinishField ?? true,
  } as DashboardTreatmentPlan;
}

function build(over: Partial<Parameters<typeof buildDashboardView>[0]>) {
  return buildDashboardView({
    now: NOW,
    sites: SITES,
    practitioners: [],
    payments: [],
    paymentsCoverage: null,
    appointments: [],
    appointmentsCoverage: { from: "2026-05-23", to: "2026-08-20" },
    appointmentRows: [],
    patients: null,
    plans: null,
    invoices: null,
    balances: null,
    claims: null,
    ...over,
  });
}

function scope(view: ReturnType<typeof buildDashboardView>, siteId: string | null) {
  const found = view.scopes.find((s) => s.siteId === siteId);
  expect(found, `no scope for ${siteId ?? "the group"}`).toBeTruthy();
  return found!;
}

describe("active patients comes from the nightly whole-book count", () => {
  it("uses the counted figure, not the narrowed scan's own tally", () => {
    // The scan reached two patients on site-a. The nightly count knows there are
    // 17,412. Printing 2 would be a lie of exactly the kind this change removes.
    const view = build({
      patients: [patient({ id: "p1" }), patient({ id: "p2" })],
      activeCounts: new Map([
        ["site-a", 17_412],
        ["site-b", 15_006],
      ]),
    });
    expect(scope(view, "site-a").periods.today.patients.activeCount.value).toBe(17_412);
    // The group is the sum of its sites, not the sum of what the scan happened to see.
    expect(scope(view, null).periods.today.patients.activeCount.value).toBe(17_412 + 15_006);
  });

  it("reports the figure unavailable when the nightly count has not reached a site", () => {
    const view = build({
      patients: [patient({ id: "p1" }), patient({ id: "p2", siteId: "site-b" })],
      activeCounts: new Map([["site-a", 17_412]]),
    });
    const siteB = scope(view, "site-b").periods.today.patients.activeCount;
    expect(siteB.value).toBeNull();
    expect(siteB.reason).toContain("nightly patient count");

    // AND THE GROUP TOO. A group total missing one practice is not a group total,
    // and a number that silently drops a site is the worst kind of wrong: plausible.
    const group = scope(view, null).periods.today.patients.activeCount;
    expect(group.value).toBeNull();
  });

  it("still counts the NEW patients the narrowed scan does answer", () => {
    // updated_after is a sound superset of "created in the window": a patient created
    // on or after `from` cannot have been updated before it. So this figure is exact.
    const view = build({
      patients: [
        patient({ id: "p1", createdDay: "2026-08-19" }),
        patient({ id: "p2", createdDay: "2020-01-01" }),
      ],
      activeCounts: new Map([["site-a", 17_412]]),
    });
    expect(scope(view, "site-a").periods.last30.patients.newCount.value).toBe(1);
  });
});

describe("open treatment plans on a narrowed scan", () => {
  const plans = [
    plan({ startedDay: "2026-08-18", finishedDay: null }),
    plan({ startedDay: "2026-08-01", finishedDay: "2026-08-19" }),
  ];

  it("reports OPEN unavailable, with the reason, when the scan was windowed", () => {
    const view = build({ plans, plansWindowed: true });
    const panel = scope(view, "site-a").periods.last30.plans;
    expect(panel.open.value).toBeNull();
    expect(panel.open.reason).toContain("cannot see plans left open before");
    // The two window questions the narrowed scan CAN answer are still answered.
    expect(panel.started.value).toBe(2);
    expect(panel.finished.value).toBe(1);
  });

  it("still answers OPEN when the scan was not windowed", () => {
    // The flag is what makes the claim, so an un-narrowed caller is unaffected —
    // and a future full scan gets its number back without editing the view.
    const view = build({ plans, plansWindowed: false });
    expect(scope(view, "site-a").periods.last30.plans.open.value).toBe(1);
  });
});
