import { describe, it, expect, beforeEach, vi } from "vitest";

// ===========================================================================
// THE COLLECTOR: where "we could not check" is turned into something the rest of
// the module can act on.
//
// Two outputs, doing two different jobs, and both matter:
//   a NULL reading  stops a detector inventing a figure;
//   an UNPROVEN key stops the pass resolving an alert it never looked for.
//
// A collector that produced only the first would still be silently wrong: one
// failed read would take a live alert off the owner's screen. So every refusal
// branch below is checked for BOTH.
//
// Also pinned here: the one Dentally-touching read runs at BACKGROUND priority.
// An alerting pass must never take quota from a receptionist with a patient on
// the phone, and the priority class is how this platform expresses that.
// ===========================================================================

vi.mock("server-only", () => ({}));

const priorities: string[] = [];
let dashboardThrows = false;
let dashboardView: unknown = null;
let noshowThrows = false;
let leadsThrows = false;
let leadRows: Array<{ id: string; siteId: string; name: string; createdAt: string }> = [];
let recheckThrows = false;
let recheckRows: Array<{
  id: string;
  siteId: string;
  name: string;
  createdAt: string;
  stage: string;
  firstResponseAt: string | null;
}> = [];
const recheckCalls: Array<{ siteIds: string[]; ids: string[] }> = [];
let approvalResults: Array<unknown> = [];
let outboxResults: Array<unknown> = [];

vi.mock("@/lib/dentally/budget", () => ({
  runWithDentallyPriority: async (priority: string, fn: () => Promise<unknown>) => {
    priorities.push(priority);
    return fn();
  },
}));

vi.mock("@/lib/dashboard/read", () => ({
  readPracticeDashboard: async () => {
    if (dashboardThrows) throw new Error("dentally is having a day");
    return dashboardView;
  },
}));

vi.mock("@/lib/mock/clients", () => ({
  getSites: () => [{ id: "site-ng" }, { id: "site-rv" }],
}));

vi.mock("@/lib/noshow/repository", () => ({
  listTargets: async () => {
    if (noshowThrows) throw new Error("noshow_target unreachable");
    return [
      {
        appointmentId: "a1",
        appointmentStartAt: "2026-08-21T14:00:00.000Z",
      },
    ];
  },
}));

vi.mock("@/lib/speed-to-lead/repository", () => ({
  listUncontacted: async () => {
    if (leadsThrows) throw new Error("speed_to_lead_lead unreachable");
    return leadRows;
  },
  listLeadsByIds: async (args: { siteIds: string[]; ids: string[] }) => {
    recheckCalls.push(args);
    if (recheckThrows) throw new Error("speed_to_lead_lead unreachable");
    const asked = new Set(args.ids);
    return recheckRows.filter((r) => asked.has(r.id));
  },
}));

vi.mock("./repository", () => ({
  APPROVAL_WATCHES: [
    { table: "closer_touch", slug: "treatment-closer", href: "treatment-coordinator" },
    { table: "collection_touch", slug: "balance-reminders", href: null },
  ],
  OUTBOX_WATCHES: [
    { source: "recall", table: "recall_outbox", slug: "recall", href: "recall", hasNotBefore: false },
    { source: "reviews", table: "review_outbox", slug: "reviews", href: "reviews", hasNotBefore: false },
  ],
  readApprovalQueue: async (_w: unknown, _s: unknown) => approvalResults.shift() ?? null,
  readOutboxHealth: async (_w: unknown, _s: unknown) => outboxResults.shift() ?? null,
}));

import { collectReadings } from "./collect";
import { periodWindow, type DashboardPeriod, type TakingsCell } from "@/lib/dashboard";

const NOW = new Date("2026-08-21T10:00:00.000Z");

function cell(period: DashboardPeriod, totalPence: number | null, reason: string | null = null): TakingsCell {
  return {
    period,
    window: periodWindow(period, NOW),
    totalPence,
    paymentCount: totalPence === null ? null : 1,
    appointmentCount: null,
    unavailableReason: reason,
    appointmentUnavailableReason: reason,
  };
}

function viewWith(cells: TakingsCell[]) {
  return {
    scopes: [
      { siteId: "site-ng", strip: { cells: [] } },
      { siteId: null, strip: { cells } },
    ],
  };
}

const SOUND_CELLS = [cell("today", 1_000), cell("last7", 300_000), cell("last30", 1_400_000)];

function queue(over: Record<string, unknown> = {}) {
  return { key: "treatment-closer", label: "x", href: null, count: 0, oldestAt: null, truncated: false, ...over };
}
function outbox(over: Record<string, unknown> = {}) {
  return {
    key: "recall",
    label: "x",
    href: null,
    stuckCount: 0,
    oldestStuckAt: null,
    stuckCutoffHours: 6,
    failedCount: 0,
    failureWindowHours: 24,
    truncated: false,
    ...over,
  };
}

beforeEach(() => {
  priorities.length = 0;
  dashboardThrows = false;
  noshowThrows = false;
  leadsThrows = false;
  dashboardView = viewWith(SOUND_CELLS);
  leadRows = [];
  recheckThrows = false;
  recheckRows = [];
  recheckCalls.length = 0;
  approvalResults = [queue(), queue({ key: "balance-reminders" })];
  outboxResults = [outbox(), outbox({ key: "reviews" })];
});

describe("collectReadings: the happy path", () => {
  it("reads the dashboard at BACKGROUND priority, never interactive", async () => {
    await collectReadings("vitality", NOW);
    expect(priorities).toEqual(["background"]);
  });

  it("takes the ALL-SITES scope's cells, not the first scope it finds", async () => {
    const { readings } = await collectReadings("vitality", NOW);
    expect(readings.takings?.last7?.totalPence).toBe(300_000);
    expect(readings.takings?.last30?.totalPence).toBe(1_400_000);
  });

  it("refuses nothing when every read worked", async () => {
    const { unproven, refusals } = await collectReadings("vitality", NOW);
    expect(unproven).toEqual([]);
    expect(refusals).toEqual([]);
  });

  it("scopes enquiries to the client's own sites", async () => {
    leadRows = [
      { id: "l1", siteId: "site-ng", name: "A", createdAt: NOW.toISOString() },
      { id: "l2", siteId: "site-of-another-practice", name: "B", createdAt: NOW.toISOString() },
    ];
    const { readings } = await collectReadings("vitality", NOW);
    expect(readings.leads?.leads?.map((l) => l.id)).toEqual(["l1"]);
  });
});

describe("collectReadings: every refusal produces BOTH a null reading and an unproven key", () => {
  it("a dashboard that throws", async () => {
    dashboardThrows = true;
    const { readings, unproven, refusals } = await collectReadings("vitality", NOW);
    expect(readings.takings).toBeNull();
    expect(unproven).toContain("takings_trend:");
    expect(refusals.join(" ")).toContain("takings");
  });

  it("a dashboard with no all-sites scope", async () => {
    dashboardView = { scopes: [{ siteId: "site-ng", strip: { cells: SOUND_CELLS } }] };
    const { readings, unproven } = await collectReadings("vitality", NOW);
    expect(readings.takings).toBeNull();
    expect(unproven).toContain("takings_trend:");
  });

  it("a period the dashboard published as UNAVAILABLE, quoting its own reason", async () => {
    dashboardView = viewWith([
      cell("today", 1_000),
      cell("last7", 300_000),
      cell("last30", null, "Takings unavailable: the live scan does not reach back this far."),
    ]);
    const { readings, unproven, refusals } = await collectReadings("vitality", NOW);
    // The reading is present but the total is null: the detector refuses on it,
    // and the pass reports the dashboard's own words rather than inventing any.
    expect(readings.takings?.last30?.totalPence).toBeNull();
    expect(unproven).toContain("takings_trend:");
    expect(refusals).toContain(
      "takings: Takings unavailable: the live scan does not reach back this far.",
    );
  });

  it("a missing period cell entirely", async () => {
    dashboardView = viewWith([cell("today", 1_000), cell("last7", 300_000)]);
    const { readings, unproven } = await collectReadings("vitality", NOW);
    expect(readings.takings?.last30).toBeNull();
    expect(unproven).toContain("takings_trend:");
  });

  it("an unreadable no-show table", async () => {
    noshowThrows = true;
    const { readings, unproven } = await collectReadings("vitality", NOW);
    expect(readings.noshow).toBeNull();
    expect(unproven).toContain("noshow_cluster:");
  });

  it("an unreadable enquiry table", async () => {
    leadsThrows = true;
    const { readings, unproven } = await collectReadings("vitality", NOW);
    expect(readings.leads).toBeNull();
    expect(unproven).toContain("lead_sla:");
  });

  it("ONE unreadable approval queue, scoped to itself", async () => {
    approvalResults = [null, queue({ key: "balance-reminders" })];
    const { readings, unproven } = await collectReadings("vitality", NOW);
    expect(readings.approvals?.map((a) => a.key)).toEqual(["balance-reminders"]);
    expect(unproven).toEqual(["approval_backlog:treatment-closer"]);
  });

  it("ONE unreadable outbox, scoped to itself, covering BOTH of its conditions", async () => {
    outboxResults = [null, outbox({ key: "reviews" })];
    const { readings, unproven } = await collectReadings("vitality", NOW);
    expect(readings.outboxes?.map((o) => o.key)).toEqual(["reviews"]);
    expect(unproven).toEqual(["outbox_stuck:recall", "send_failures:recall"]);
  });

  it("a whole category unreadable collapses to null, not to an empty all-clear", async () => {
    approvalResults = [null, null];
    outboxResults = [null, null];
    const { readings, unproven } = await collectReadings("vitality", NOW);
    expect(readings.approvals).toBeNull();
    expect(readings.outboxes).toBeNull();
    expect(unproven).toHaveLength(6);
  });

  it("a total blackout refuses everything and asserts nothing", async () => {
    dashboardThrows = true;
    noshowThrows = true;
    leadsThrows = true;
    approvalResults = [null, null];
    outboxResults = [null, null];
    const { readings, unproven, refusals } = await collectReadings("vitality", NOW);
    expect(readings.takings).toBeNull();
    expect(readings.noshow).toBeNull();
    expect(readings.leads).toBeNull();
    expect(readings.approvals).toBeNull();
    expect(readings.outboxes).toBeNull();
    expect(unproven).toHaveLength(9);
    expect(refusals.length).toBeGreaterThanOrEqual(7);
  });
});

// ===========================================================================
// THE QUERY BOUND MUST NOT BE ABLE TO CLOSE AN ALERT.
//
// listUncontacted is bounded to the last 48 hours. That bound is a RAISE guard —
// a lead stranded at 'new' from before the platform existed must not generate an
// alert today — and the failure it hides is at the other end: an alert raised on
// Friday stops appearing in the pass's own output on Sunday because the query no
// longer reaches it, and the sweep marks it resolved. Nobody rang the patient.
// Nothing got better. The alert simply left the screen.
//
// That is the same class of wrong the `unproven` mechanism exists to prevent — a
// pass that did not LOOK closing an alert — arriving through a WHERE clause
// instead of an error, which is why no test caught it.
//
// The rule these pin: AN ALERT MAY ONLY BE RESOLVED BY EVIDENCE THAT THE
// CONDITION ENDED, NEVER BY THE COLLECTOR FAILING TO LOOK. So each case below
// runs the WHOLE pass — collect, detect, plan — and asserts on what the sweep
// would actually write, because "the reading contains it" is an implementation
// detail and "the alert survived" is the property.
// ===========================================================================

import { detectAnomalies } from "./detect";
import { planPass, type StoredAlert } from "./dedupe";

/** An open alert row for one lead, as the store hands it back. */
function openLeadAlert(leadId: string, createdAt: string): StoredAlert {
  return {
    id: `row-${leadId}`,
    kind: "lead_sla",
    severity: "high",
    dedupeKey: `lead_sla:${leadId}`,
    sentence: "Somebody enquired and nobody has rung them.",
    href: "speed-to-lead",
    at: createdAt,
    firstRaisedAt: createdAt,
    lastSeenAt: createdAt,
    resolvedAt: null,
  };
}

function agedLead(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    siteId: "site-ng",
    name: "Friday Enquirer",
    // Three days before NOW: past listUncontacted's 48-hour lookback.
    createdAt: "2026-08-18T09:00:00.000Z",
    stage: "new",
    firstResponseAt: null,
    ...over,
  };
}

/** collect -> detect -> plan, exactly as the sweep route runs them. */
async function runPass(stored: StoredAlert[]) {
  const openKeys = stored.filter((r) => r.resolvedAt === null).map((r) => r.dedupeKey);
  const { readings, unproven, refusals } = await collectReadings("vitality", NOW, openKeys);
  const raised = detectAnomalies(readings);
  return { plan: planPass(raised, stored, unproven, NOW), unproven, refusals, raised };
}

describe("an open lead alert the 48-hour lookback can no longer see", () => {
  it("IS NOT RESOLVED BY A PASS THAT CANNOT SEE IT — it is re-checked against the lead", async () => {
    // The exact scenario: the bounded query returns nothing, because the lead it
    // is about aged out of the window overnight.
    leadRows = [];
    recheckRows = [agedLead()];
    const stored = [openLeadAlert("l1", "2026-08-18T09:00:00.000Z")];

    const { plan } = await runPass(stored);

    // Before the fix this was ['lead_sla:l1'].
    expect(plan.resolve).toEqual([]);
    // And the alert is kept honest rather than merely kept: refreshed, not re-raised.
    expect(plan.refresh.map((a) => a.dedupeKey)).toEqual(["lead_sla:l1"]);
    expect(plan.insert).toEqual([]);
    expect(plan.refresh[0].sentence).toContain("3 days ago");
  });

  it("re-reads by id and by site, and asks only about ids that already have an alert", async () => {
    leadRows = [];
    recheckRows = [agedLead()];
    await runPass([openLeadAlert("l1", "2026-08-18T09:00:00.000Z")]);
    expect(recheckCalls).toEqual([{ siteIds: ["site-ng", "site-rv"], ids: ["l1"] }]);
  });

  it("IS resolved once the lead has actually been contacted", async () => {
    // The other half of the property: real evidence the condition ended still
    // closes the alert. A fix that simply never resolved anything would pass the
    // test above and be useless.
    leadRows = [];
    recheckRows = [agedLead({ firstResponseAt: "2026-08-18T09:04:00.000Z", stage: "contacted" })];

    const { plan, unproven } = await runPass([openLeadAlert("l1", "2026-08-18T09:00:00.000Z")]);
    expect(plan.resolve).toEqual(["lead_sla:l1"]);
    expect(unproven).toEqual([]);
  });

  it("is resolved when the lead moved on without a recorded response", async () => {
    // 'lost', 'booked', 'nurture_done': somebody dealt with the enquiry. The
    // predicate mirrors listUncontacted's own, so the condition is cleared by the
    // same definition that raised it.
    leadRows = [];
    recheckRows = [agedLead({ stage: "lost" })];
    const { plan } = await runPass([openLeadAlert("l1", "2026-08-18T09:00:00.000Z")]);
    expect(plan.resolve).toEqual(["lead_sla:l1"]);
  });

  it("leaves the alert alone when the lead cannot be read back at all", async () => {
    // No row came back for that id — deleted, or belonging to another practice's
    // site. That is not evidence the patient was rung.
    leadRows = [];
    recheckRows = [];
    const { plan, unproven, refusals } = await runPass([
      openLeadAlert("l1", "2026-08-18T09:00:00.000Z"),
    ]);
    expect(plan.resolve).toEqual([]);
    expect(unproven).toEqual(["lead_sla:l1"]);
    expect(refusals.join(" ")).toContain("could not read");
  });

  it("leaves the alert alone when the re-check itself falls over", async () => {
    leadRows = [];
    recheckThrows = true;
    const { plan, unproven, refusals } = await runPass([
      openLeadAlert("l1", "2026-08-18T09:00:00.000Z"),
    ]);
    expect(plan.resolve).toEqual([]);
    expect(unproven).toEqual(["lead_sla:l1"]);
    expect(refusals.join(" ")).toContain("could not be re-checked");
  });

  it("still reports the leads the bounded read DID cover when the re-check fails", async () => {
    leadRows = [{ id: "l2", siteId: "site-ng", name: "Fresh", createdAt: "2026-08-21T08:00:00.000Z" }];
    recheckThrows = true;
    const { plan } = await runPass([openLeadAlert("l1", "2026-08-18T09:00:00.000Z")]);
    expect(plan.insert.map((a) => a.dedupeKey)).toEqual(["lead_sla:l2"]);
    expect(plan.resolve).toEqual([]);
  });

  it("NEVER INVENTS an alert for an old lead: only open keys are ever re-read", async () => {
    // The raise direction of the 48-hour bound is untouched. Nothing is open, so
    // nothing is asked about, and the ancient lead stays invisible.
    leadRows = [];
    recheckRows = [agedLead({ id: "ancient", createdAt: "2025-01-01T09:00:00.000Z" })];
    const { plan } = await runPass([]);
    expect(recheckCalls).toEqual([]);
    expect(plan.insert).toEqual([]);
    expect(plan.resolve).toEqual([]);
  });

  it("does not re-read a lead the bounded query already covered", async () => {
    leadRows = [{ id: "l1", siteId: "site-ng", name: "Seen", createdAt: "2026-08-20T09:00:00.000Z" }];
    const { plan } = await runPass([openLeadAlert("l1", "2026-08-20T09:00:00.000Z")]);
    expect(recheckCalls).toEqual([]);
    expect(plan.refresh.map((a) => a.dedupeKey)).toEqual(["lead_sla:l1"]);
  });

  it("ignores open keys belonging to other detectors", async () => {
    leadRows = [];
    const { plan } = await runPass([
      { ...openLeadAlert("x", "2026-08-18T09:00:00.000Z"), kind: "takings_trend", dedupeKey: "takings_trend:last7" },
    ]);
    expect(recheckCalls).toEqual([]);
    // Takings really were checked this pass and really are fine, so that one resolves.
    expect(plan.resolve).toEqual(["takings_trend:last7"]);
  });

  it("caps one re-check, and treats everything past the cap as unproven", async () => {
    // A read that stopped asking is not a read that found nothing.
    leadRows = [];
    const stored = Array.from({ length: 205 }, (_, i) =>
      openLeadAlert(`l${i}`, "2026-08-18T09:00:00.000Z"),
    );
    const { plan, unproven } = await runPass(stored);
    expect(recheckCalls[0].ids).toHaveLength(200);
    expect(plan.resolve).toEqual([]);
    expect(unproven).toHaveLength(205);
  });
});
