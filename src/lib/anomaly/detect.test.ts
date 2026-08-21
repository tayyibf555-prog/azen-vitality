import { describe, it, expect } from "vitest";

// ===========================================================================
// THE DETECTORS, AT THE LINE AND EITHER SIDE OF IT.
//
// Every threshold is tested with a fixture just under and just over, and at the
// boundary itself, because "materially off trend" is a product decision encoded
// as a number and a test that only checks the obvious cases cannot tell you the
// number moved.
//
// The other half of the file is the honesty axis, which has two distinct
// behaviours and both are pinned:
//
//   REFUSAL   an unavailable / partial / undateable reading produces NO alert.
//             This is the branch that stops "takings are down 40%" being said
//             about a payment scan that simply ran out of pages.
//   DISCLOSURE a reading that is a proven FLOOR (a capped count) produces an
//             alert that says "At least N", in words, in the sentence.
//
// And the quiet day: sound readings with nothing wrong produce silence.
// ===========================================================================

import { periodWindow, type DashboardPeriod, type TakingsCell } from "@/lib/dashboard";

import {
  describeAge,
  detectAnomalies,
  detectApprovalBacklog,
  detectLeadSla,
  detectNoshowCluster,
  detectOutboxStuck,
  detectSendFailures,
  detectTakingsTrend,
  formatPoundsRounded,
  plainText,
  type AnomalyReadings,
  type ApprovalQueueReading,
  type OutboxReading,
} from "./detect";
import {
  APPROVAL_BACKLOG_MIN,
  NOSHOW_CLUSTER_MIN,
  OUTBOX_STUCK_HOURS,
  OUTBOX_STUCK_MIN,
  SEND_FAILURE_MIN,
  SEND_FAILURE_WINDOW_HOURS,
} from "./types";

const NOW = new Date("2026-08-21T10:00:00.000Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** A sourced cell: a real window from the dashboard's own period maths. */
function cell(period: DashboardPeriod, totalPence: number): TakingsCell {
  return {
    period,
    window: periodWindow(period, NOW),
    totalPence,
    paymentCount: 1,
    appointmentCount: 1,
    unavailableReason: null,
    appointmentUnavailableReason: null,
  };
}

/** An unavailable cell, exactly as the dashboard publishes one. */
function blank(period: DashboardPeriod, reason: string): TakingsCell {
  return {
    period,
    window: periodWindow(period, NOW),
    totalPence: null,
    paymentCount: null,
    appointmentCount: null,
    unavailableReason: reason,
    appointmentUnavailableReason: reason,
  };
}

/**
 * Build the three cells from the daily rates the detector actually compares.
 * recentDays is 6 (last7 minus today) and baselineDays is 23 (last30 minus last7),
 * so the strip totals are derived rather than hand-written and cannot drift out
 * of step with the arithmetic under test.
 */
function strip(opts: { todayPence: number; recentDaily: number; baselineDaily: number }) {
  const recent = opts.recentDaily * 6;
  const baseline = opts.baselineDaily * 23;
  const last7 = recent + opts.todayPence;
  return {
    today: cell("today", opts.todayPence),
    last7: cell("last7", last7),
    last30: cell("last30", last7 + baseline),
  };
}

// ---------------------------------------------------------------------------
// 1. TAKINGS
// ---------------------------------------------------------------------------

describe("detectTakingsTrend: the threshold", () => {
  it("is silent just under a 25% fall", () => {
    // £500/day baseline, £376/day now: a 24.8% fall.
    const alert = detectTakingsTrend(
      strip({ todayPence: 10_000, recentDaily: 37_600, baselineDaily: 50_000 }),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it("fires AT exactly a 25% fall", () => {
    const alert = detectTakingsTrend(
      strip({ todayPence: 10_000, recentDaily: 37_500, baselineDaily: 50_000 }),
      NOW,
    );
    expect(alert?.kind).toBe("takings_trend");
    expect(alert?.sentence).toContain("25% below");
  });

  it("fires just over it, and names both daily rates and the money", () => {
    const alert = detectTakingsTrend(
      strip({ todayPence: 10_000, recentDaily: 37_400, baselineDaily: 50_000 }),
      NOW,
    );
    expect(alert).not.toBeNull();
    expect(alert?.severity).toBe("medium");
    expect(alert?.sentence).toBe(
      "Takings over the last 6 days are running at £374 a day, 25% below the £500 a day of the 23 days before that. " +
        "That is about £756 less than the same stretch would normally take. " +
        "Worth checking the diary and the payments page.",
    );
    expect(alert?.href).toBe("payments");
    expect(alert?.dedupeKey).toBe("takings_trend:last7");
  });

  it("escalates to high at a 40% fall, and stays medium just below it", () => {
    const justBelow = detectTakingsTrend(
      strip({ todayPence: 10_000, recentDaily: 30_500, baselineDaily: 50_000 }), // 39%
      NOW,
    );
    const at = detectTakingsTrend(
      strip({ todayPence: 10_000, recentDaily: 30_000, baselineDaily: 50_000 }), // 40%
      NOW,
    );
    expect(justBelow?.severity).toBe("medium");
    expect(at?.severity).toBe("high");
  });

  it("refuses a big PROPORTIONAL fall that is not much money", () => {
    // £20/day to £10/day is a fifty percent fall and sixty pounds. Alerting on it
    // would teach the owner to ignore the feature.
    const alert = detectTakingsTrend(
      strip({ todayPence: 0, recentDaily: 1_000, baselineDaily: 2_000 }),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it("fires once the same proportional fall is real money", () => {
    const alert = detectTakingsTrend(
      strip({ todayPence: 0, recentDaily: 3_000, baselineDaily: 10_000 }),
      NOW,
    );
    expect(alert?.severity).toBe("high");
    expect(alert?.sentence).toContain("£420 less");
  });

  it("never reports takings being UP", () => {
    const alert = detectTakingsTrend(
      strip({ todayPence: 10_000, recentDaily: 90_000, baselineDaily: 50_000 }),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it("subtracts today out, so a part-day cannot invent a fall", () => {
    // Flat trading at £500/day, and today has only taken £30 so far. Including
    // today would read as a 20%+ fall across the seven-day window; excluding it
    // reads as exactly flat, which is what is happening.
    const flat = strip({ todayPence: 3_000, recentDaily: 50_000, baselineDaily: 50_000 });
    expect(detectTakingsTrend(flat, NOW)).toBeNull();
  });
});

describe("detectTakingsTrend: the honesty rule", () => {
  it("says nothing when the dashboard declared the long period unavailable", () => {
    const sound = strip({ todayPence: 10_000, recentDaily: 10_000, baselineDaily: 50_000 });
    const reading = {
      ...sound,
      last30: blank("last30", "Takings unavailable: the live scan does not reach back this far."),
    };
    // The same figures WOULD have alerted loudly with a sourced cell.
    expect(detectTakingsTrend(sound, NOW)?.severity).toBe("high");
    expect(detectTakingsTrend(reading, NOW)).toBeNull();
  });

  it("says nothing when the short period is unavailable", () => {
    const sound = strip({ todayPence: 10_000, recentDaily: 10_000, baselineDaily: 50_000 });
    expect(
      detectTakingsTrend({ ...sound, last7: blank("last7", "Takings unavailable for this period.") }, NOW),
    ).toBeNull();
  });

  it("says nothing when TODAY is unavailable, because today is what it subtracts", () => {
    const sound = strip({ todayPence: 10_000, recentDaily: 10_000, baselineDaily: 50_000 });
    expect(
      detectTakingsTrend({ ...sound, today: blank("today", "Takings unavailable for this period.") }, NOW),
    ).toBeNull();
  });

  it("says nothing when ANY cell is missing entirely, or the whole reading is", () => {
    const sound = strip({ todayPence: 10_000, recentDaily: 10_000, baselineDaily: 50_000 });
    // Each on its own: a missing cell must be refused, not dereferenced.
    expect(detectTakingsTrend({ ...sound, today: null }, NOW)).toBeNull();
    expect(detectTakingsTrend({ ...sound, last7: null }, NOW)).toBeNull();
    expect(detectTakingsTrend({ ...sound, last30: null }, NOW)).toBeNull();
    expect(detectTakingsTrend(null, NOW)).toBeNull();
  });

  it("says nothing when there is no baseline to be off", () => {
    // A practice that took nothing at all in the baseline stretch has no trend.
    expect(
      detectTakingsTrend(strip({ todayPence: 0, recentDaily: 0, baselineDaily: 0 }), NOW),
    ).toBeNull();
  });

  it("says nothing when a zero baseline meets a refunded week", () => {
    // The nastiest shape for this arithmetic: nothing taken in the baseline
    // stretch and net refunds since. Dividing by that baseline yields an
    // INFINITE percentage, and "takings are Infinity% below" is exactly the kind
    // of sentence this module exists not to produce.
    const alert = detectTakingsTrend(
      strip({ todayPence: 0, recentDaily: -5_000, baselineDaily: 0 }),
      NOW,
    );
    expect(alert).toBeNull();
  });

  it("says nothing when the baseline stretch is itself net negative", () => {
    expect(
      detectTakingsTrend(strip({ todayPence: 0, recentDaily: -50_000, baselineDaily: -1_000 }), NOW),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. NO-SHOW CLUSTER
// ---------------------------------------------------------------------------

function risks(count: number, dayIso: string) {
  return Array.from({ length: count }, (_, i) => ({
    appointmentId: `a${i}`,
    startAt: dayIso,
  }));
}

describe("detectNoshowCluster", () => {
  it(`is silent at ${NOSHOW_CLUSTER_MIN - 1} and fires at ${NOSHOW_CLUSTER_MIN}`, () => {
    const under = detectNoshowCluster(
      { appointments: risks(NOSHOW_CLUSTER_MIN - 1, "2026-08-21T14:00:00.000Z") },
      NOW,
    );
    const at = detectNoshowCluster(
      { appointments: risks(NOSHOW_CLUSTER_MIN, "2026-08-21T14:00:00.000Z") },
      NOW,
    );
    expect(under).toBeNull();
    expect(at?.sentence).toBe(
      "4 patients booked in today or tomorrow are at high risk of not turning up. " +
        "Confirming them now is the cheapest way to protect the diary.",
    );
    expect(at?.severity).toBe("medium");
    expect(at?.href).toBe("no-show-defence");
  });

  it("counts tomorrow as well as today, and nothing beyond", () => {
    const spread = [
      ...risks(2, "2026-08-21T14:00:00.000Z"), // today
      ...risks(2, "2026-08-22T09:00:00.000Z"), // tomorrow
      ...risks(9, "2026-08-25T09:00:00.000Z"), // next week: not this alert's problem
    ];
    const alert = detectNoshowCluster({ appointments: spread }, NOW);
    expect(alert?.sentence).toContain("4 patients");
  });

  it("goes high at 8", () => {
    expect(
      detectNoshowCluster({ appointments: risks(7, "2026-08-22T09:00:00.000Z") }, NOW)?.severity,
    ).toBe("medium");
    expect(
      detectNoshowCluster({ appointments: risks(8, "2026-08-22T09:00:00.000Z") }, NOW)?.severity,
    ).toBe("high");
  });

  it("keys on the diary day, so tomorrow's cluster is its own alert", () => {
    const alert = detectNoshowCluster({ appointments: risks(4, "2026-08-21T14:00:00.000Z") }, NOW);
    expect(alert?.dedupeKey).toBe("noshow_cluster:2026-08-21");
    const tomorrow = detectNoshowCluster(
      { appointments: risks(4, "2026-08-22T14:00:00.000Z") },
      new Date("2026-08-22T10:00:00.000Z"),
    );
    expect(tomorrow?.dedupeKey).toBe("noshow_cluster:2026-08-22");
  });

  it("does not count an undateable row as evidence", () => {
    const rows = [
      ...risks(3, "2026-08-21T14:00:00.000Z"),
      { appointmentId: "bad", startAt: "not a date" },
    ];
    expect(detectNoshowCluster({ appointments: rows }, NOW)).toBeNull();
  });

  it("is silent on an unreadable table, and on a quiet day, and tells nobody the difference", () => {
    expect(detectNoshowCluster({ appointments: null }, NOW)).toBeNull();
    expect(detectNoshowCluster({ appointments: [] }, NOW)).toBeNull();
    expect(detectNoshowCluster(null, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. LEAD SLA
// ---------------------------------------------------------------------------

describe("detectLeadSla", () => {
  const lead = (id: string, agoMs: number, name = "Sam Doe") => ({
    id,
    name,
    createdAt: new Date(NOW.getTime() - agoMs).toISOString(),
  });

  it("is silent at 59 minutes and fires at 60", () => {
    expect(detectLeadSla({ leads: [lead("l1", 59 * MINUTE)] }, NOW)).toEqual([]);
    const fired = detectLeadSla({ leads: [lead("l1", 60 * MINUTE)] }, NOW);
    expect(fired).toHaveLength(1);
    expect(fired[0].sentence).toBe(
      "Sam Doe enquired 1 hour ago and still has not been contacted. " +
        "Enquiries answered in the first few minutes are the ones that book.",
    );
    expect(fired[0].severity).toBe("high");
    expect(fired[0].href).toBe("speed-to-lead");
    expect(fired[0].dedupeKey).toBe("lead_sla:l1");
  });

  it("anchors on when the enquiry arrived, not on when we noticed", () => {
    const created = new Date(NOW.getTime() - 3 * HOUR).toISOString();
    const [alert] = detectLeadSla({ leads: [{ id: "l1", name: "Sam", createdAt: created }] }, NOW);
    expect(alert.at).toBe(created);
    expect(alert.sentence).toContain("3 hours ago");
  });

  it("raises one alert per person, because each is a separate phone call", () => {
    const alerts = detectLeadSla(
      { leads: [lead("l1", 2 * HOUR), lead("l2", 5 * HOUR), lead("l3", 10 * MINUTE)] },
      NOW,
    );
    expect(alerts.map((a) => a.dedupeKey)).toEqual(["lead_sla:l1", "lead_sla:l2"]);
  });

  it("makes an untrusted name safe without dropping the alert", () => {
    const [alert] = detectLeadSla(
      { leads: [{ id: "l1", name: "Sam\u0000\nDoe", createdAt: lead("x", 2 * HOUR).createdAt }] },
      NOW,
    );
    expect(alert.sentence.startsWith("Sam Doe enquired")).toBe(true);
  });

  it("is silent on an unreadable table and on an empty one", () => {
    expect(detectLeadSla({ leads: null }, NOW)).toEqual([]);
    expect(detectLeadSla({ leads: [] }, NOW)).toEqual([]);
    expect(detectLeadSla(null, NOW)).toEqual([]);
  });

  it("ignores an undateable enquiry rather than guessing its age", () => {
    expect(detectLeadSla({ leads: [{ id: "l1", name: "Sam", createdAt: "" }] }, NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4a. APPROVAL BACKLOG
// ---------------------------------------------------------------------------

function queue(over: Partial<ApprovalQueueReading> = {}): ApprovalQueueReading {
  return {
    key: "treatment-closer",
    label: "Treatment-plan closer",
    href: "treatment-coordinator",
    count: 0,
    oldestAt: null,
    truncated: false,
    ...over,
  };
}

describe("detectApprovalBacklog", () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();

  it(`is silent at ${APPROVAL_BACKLOG_MIN - 1} fresh drafts and fires at ${APPROVAL_BACKLOG_MIN}`, () => {
    expect(
      detectApprovalBacklog([queue({ count: 9, oldestAt: hoursAgo(2) })], NOW),
    ).toEqual([]);
    const [alert] = detectApprovalBacklog([queue({ count: 10, oldestAt: hoursAgo(2) })], NOW);
    expect(alert.sentence).toBe(
      "10 messages are waiting for someone to approve them in Treatment-plan closer. " +
        "The oldest has been waiting 2 hours. Nothing goes out until a person releases them.",
    );
    expect(alert.dedupeKey).toBe("approval_backlog:treatment-closer");
    expect(alert.href).toBe("treatment-coordinator");
  });

  it("fires on ONE draft nobody will ever get to: silent at 71 hours, alert at 72", () => {
    expect(detectApprovalBacklog([queue({ count: 1, oldestAt: hoursAgo(71) })], NOW)).toEqual([]);
    const [alert] = detectApprovalBacklog([queue({ count: 1, oldestAt: hoursAgo(72) })], NOW);
    expect(alert.sentence).toBe(
      "1 message is waiting for someone to approve them in Treatment-plan closer. " +
        "The oldest has been waiting 3 days. Nothing goes out until a person releases them.",
    );
  });

  it("says AT LEAST when the count is a capped read, never a bare total", () => {
    const [alert] = detectApprovalBacklog(
      [queue({ count: 500, oldestAt: hoursAgo(5), truncated: true })],
      NOW,
    );
    expect(alert.sentence.startsWith("At least 500 messages are waiting")).toBe(true);
  });

  it("drops the age clause rather than guessing when the oldest is undateable", () => {
    const [alert] = detectApprovalBacklog([queue({ count: 12, oldestAt: null })], NOW);
    expect(alert.sentence).toBe(
      "12 messages are waiting for someone to approve them in Treatment-plan closer. " +
        "Nothing goes out until a person releases them.",
    );
    expect(alert.at).toBe(NOW.toISOString());
  });

  it("keeps the link off a system that has no worklist page yet", () => {
    const [alert] = detectApprovalBacklog(
      [queue({ key: "balance-reminders", label: "Balance reminders", href: null, count: 11 })],
      NOW,
    );
    expect(alert.href).toBeNull();
    expect(alert.sentence).toContain("Balance reminders");
  });

  it("is silent on an empty queue and on an unreadable category", () => {
    expect(detectApprovalBacklog([queue({ count: 0 })], NOW)).toEqual([]);
    expect(detectApprovalBacklog([], NOW)).toEqual([]);
    expect(detectApprovalBacklog(null, NOW)).toEqual([]);
  });

  it("refuses an INCOHERENT reading rather than announcing nought messages", () => {
    // Nothing waiting, and yet something has apparently been waiting since last
    // week. The count is the fact; the stale branch must not fire off the age
    // alone, or the owner reads "0 messages are waiting for someone".
    expect(
      detectApprovalBacklog([queue({ count: 0, oldestAt: hoursAgo(200) })], NOW),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4b / 4c. OUTBOX STUCK AND SENDS FAILING
// ---------------------------------------------------------------------------

function outbox(over: Partial<OutboxReading> = {}): OutboxReading {
  return {
    key: "recall",
    label: "Recall concierge",
    href: "recall",
    stuckCount: 0,
    oldestStuckAt: null,
    stuckCutoffHours: OUTBOX_STUCK_HOURS,
    failedCount: 0,
    failureWindowHours: SEND_FAILURE_WINDOW_HOURS,
    truncated: false,
    ...over,
  };
}

describe("detectOutboxStuck", () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();

  it(`is silent at ${OUTBOX_STUCK_MIN - 1} and fires at ${OUTBOX_STUCK_MIN}`, () => {
    expect(detectOutboxStuck([outbox({ stuckCount: 2, oldestStuckAt: hoursAgo(9) })], NOW)).toEqual([]);
    const [alert] = detectOutboxStuck([outbox({ stuckCount: 3, oldestStuckAt: hoursAgo(9) })], NOW);
    expect(alert.sentence).toBe(
      "3 approved Recall concierge messages have not gone out yet. " +
        "The oldest has been queued for 9 hours. The practice will assume those patients were contacted.",
    );
    expect(alert.severity).toBe("high");
    expect(alert.dedupeKey).toBe("outbox_stuck:recall");
  });

  it("REFUSES a reading built against a different cutoff rather than reporting it", () => {
    const wrongCutoff = outbox({ stuckCount: 50, oldestStuckAt: hoursAgo(2), stuckCutoffHours: 1 });
    expect(detectOutboxStuck([wrongCutoff], NOW)).toEqual([]);
  });

  it("says AT LEAST on a capped read", () => {
    const [alert] = detectOutboxStuck(
      [outbox({ stuckCount: 500, oldestStuckAt: hoursAgo(30), truncated: true })],
      NOW,
    );
    expect(alert.sentence.startsWith("At least 500 approved")).toBe(true);
    expect(alert.sentence).toContain("queued for 1 day");
  });

  it("is silent on a clear outbox and on an unreadable one", () => {
    expect(detectOutboxStuck([outbox()], NOW)).toEqual([]);
    expect(detectOutboxStuck(null, NOW)).toEqual([]);
  });
});

describe("detectSendFailures", () => {
  it(`is silent at ${SEND_FAILURE_MIN - 1} and fires at ${SEND_FAILURE_MIN}`, () => {
    expect(detectSendFailures([outbox({ failedCount: 4 })], NOW)).toEqual([]);
    const [alert] = detectSendFailures([outbox({ failedCount: 5 })], NOW);
    expect(alert.sentence).toBe(
      "5 Recall concierge messages failed to send in the last 24 hours. " +
        "Something is wrong with sending, not with the message.",
    );
    expect(alert.dedupeKey).toBe("send_failures:recall");
  });

  it("REFUSES a reading counted over a different window", () => {
    expect(detectSendFailures([outbox({ failedCount: 99, failureWindowHours: 1 })], NOW)).toEqual([]);
  });

  it("is silent when nothing failed and when the table could not be read", () => {
    expect(detectSendFailures([outbox()], NOW)).toEqual([]);
    expect(detectSendFailures(null, NOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The pass as a whole.
// ---------------------------------------------------------------------------

function quietReadings(): AnomalyReadings {
  return {
    now: NOW,
    takings: strip({ todayPence: 10_000, recentDaily: 50_000, baselineDaily: 50_000 }),
    noshow: { appointments: [] },
    leads: { leads: [] },
    approvals: [queue()],
    outboxes: [outbox()],
  };
}

describe("detectAnomalies", () => {
  it("A QUIET DAY IS SILENT: sound readings, nothing wrong, no alerts at all", () => {
    expect(detectAnomalies(quietReadings())).toEqual([]);
  });

  it("A BLIND DAY IS ALSO SILENT: every reading unavailable, still no alerts", () => {
    expect(
      detectAnomalies({
        now: NOW,
        takings: null,
        noshow: null,
        leads: null,
        approvals: null,
        outboxes: null,
      }),
    ).toEqual([]);
  });

  it("puts SEVERITY ahead of the key, even when the key sorts the other way", () => {
    // "approval_backlog:..." sorts before "outbox_stuck:..." alphabetically, and
    // is the less urgent of the two. Severity has to win, or the row an owner
    // reads first is the one that matters least.
    const alerts = detectAnomalies({
      ...quietReadings(),
      approvals: [queue({ count: 12, oldestAt: new Date(NOW.getTime() - HOUR).toISOString() })],
      outboxes: [
        outbox({ stuckCount: 5, oldestStuckAt: new Date(NOW.getTime() - 8 * HOUR).toISOString() }),
      ],
    });
    expect(alerts.map((a) => a.severity)).toEqual(["high", "medium"]);
    expect(alerts.map((a) => a.kind)).toEqual(["outbox_stuck", "approval_backlog"]);
  });

  it("orders high before medium, and is deterministic within a severity", () => {
    const alerts = detectAnomalies({
      ...quietReadings(),
      takings: strip({ todayPence: 10_000, recentDaily: 37_400, baselineDaily: 50_000 }),
      leads: {
        leads: [{ id: "l2", name: "B", createdAt: new Date(NOW.getTime() - 2 * HOUR).toISOString() }],
      },
      outboxes: [
        outbox({
          key: "recall",
          stuckCount: 4,
          oldestStuckAt: new Date(NOW.getTime() - 8 * HOUR).toISOString(),
        }),
      ],
    });
    expect(alerts.map((a) => a.dedupeKey)).toEqual([
      "lead_sla:l2",
      "outbox_stuck:recall",
      "takings_trend:last7",
    ]);
    expect(alerts.map((a) => a.severity)).toEqual(["high", "high", "medium"]);
    // Same input, same output, byte for byte.
    expect(detectAnomalies(quietReadings())).toEqual(detectAnomalies(quietReadings()));
  });

  it("every alert carries a kind, a severity, a dedupe key, a sentence and an anchor", () => {
    const alerts = detectAnomalies({
      ...quietReadings(),
      takings: strip({ todayPence: 0, recentDaily: 3_000, baselineDaily: 10_000 }),
      noshow: { appointments: risks(9, "2026-08-21T14:00:00.000Z") },
      leads: {
        leads: [{ id: "l1", name: "A", createdAt: new Date(NOW.getTime() - 2 * HOUR).toISOString() }],
      },
      approvals: [queue({ count: 11, oldestAt: new Date(NOW.getTime() - 5 * HOUR).toISOString() })],
      outboxes: [
        outbox({
          stuckCount: 6,
          oldestStuckAt: new Date(NOW.getTime() - 7 * HOUR).toISOString(),
          failedCount: 9,
        }),
      ],
    });
    expect(alerts).toHaveLength(6);
    for (const a of alerts) {
      expect(a.kind).toBeTruthy();
      expect(["high", "medium", "low"]).toContain(a.severity);
      expect(a.dedupeKey.startsWith(`${a.kind}:`)).toBe(true);
      expect(a.sentence.trim().length).toBeGreaterThan(20);
      expect(a.sentence.trim().endsWith(".")).toBe(true);
      expect(Number.isNaN(Date.parse(a.at))).toBe(false);
    }
    // One alert per condition: no kind is raised twice for the same subject.
    expect(new Set(alerts.map((a) => a.dedupeKey)).size).toBe(alerts.length);
  });

  it("never uses funding words or internal jargon in an owner-facing sentence", () => {
    const alerts = detectAnomalies({
      ...quietReadings(),
      takings: strip({ todayPence: 0, recentDaily: 3_000, baselineDaily: 10_000 }),
      noshow: { appointments: risks(9, "2026-08-21T14:00:00.000Z") },
      leads: {
        leads: [{ id: "l1", name: "A", createdAt: new Date(NOW.getTime() - 2 * HOUR).toISOString() }],
      },
      approvals: [queue({ count: 11, oldestAt: new Date(NOW.getTime() - 5 * HOUR).toISOString() })],
      outboxes: [outbox({ stuckCount: 6, oldestStuckAt: NOW.toISOString(), failedCount: 9 })],
    });
    const banned = ["nhs", "private", "cadence", "outbox", "touch", "sweep", "dentally", "null"];
    for (const a of alerts) {
      for (const word of banned) {
        expect(a.sentence.toLowerCase(), `"${word}" in: ${a.sentence}`).not.toContain(word);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The formatting helpers, which the sentences are made of.
// ---------------------------------------------------------------------------

describe("sentence primitives", () => {
  it("formats money in whole pounds with grouping, and keeps a sign", () => {
    expect(formatPoundsRounded(0)).toBe("£0");
    expect(formatPoundsRounded(99)).toBe("£1");
    expect(formatPoundsRounded(149)).toBe("£1");
    expect(formatPoundsRounded(150)).toBe("£2");
    expect(formatPoundsRounded(123_456)).toBe("£1,235");
    expect(formatPoundsRounded(1_234_567_800)).toBe("£12,345,678");
    expect(formatPoundsRounded(-25_000)).toBe("-£250");
  });

  it("rounds an age DOWN, so it is never overstated", () => {
    expect(describeAge(30_000)).toBe("1 minute");
    expect(describeAge(90 * MINUTE)).toBe("1 hour");
    expect(describeAge(119 * MINUTE)).toBe("1 hour");
    expect(describeAge(2 * HOUR)).toBe("2 hours");
    expect(describeAge(47 * HOUR)).toBe("1 day");
    expect(describeAge(48 * HOUR)).toBe("2 days");
  });

  it("strips control characters, collapses whitespace and caps length", () => {
    expect(plainText("  Ada   Lovelace \n", "x")).toBe("Ada Lovelace");
    expect(plainText("Ada\u0000\u001bLovelace", "x")).toBe("Ada Lovelace");
    expect(plainText("", "fallback")).toBe("fallback");
    expect(plainText("   ", "fallback")).toBe("fallback");
    expect(plainText(undefined, "fallback")).toBe("fallback");
    expect(plainText(42, "fallback")).toBe("fallback");
    const long = plainText("a".repeat(200), "x");
    expect(long.length).toBe(63);
    expect(long.endsWith("...")).toBe(true);
  });
});
