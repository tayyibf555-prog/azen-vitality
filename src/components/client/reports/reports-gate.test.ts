import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// ONE UNREADABLE PERIOD MUST NOT BLANK THE WHOLE REPORTS PAGE.
//
// The workspace used to be gated on the MONTH snapshot alone:
//
//     const snapshotUnavailable = month.readFailed || month.truncated;
//     const hasActivity = !snapshotUnavailable && month.enquiries > 0;
//
// so a month that saturated the enquiry read took everything down with it — the
// Week tab, the week's own perfectly countable figures, and the Generate button —
// and left one empty state on the page. Read the condition again: the trigger is a
// month with TOO MANY enquiries. The page went dark precisely when the practice was
// busiest, which is the week the owner has most reason to open it, and the screen
// she got said nothing about her week at all.
//
// The gate now weighs both periods and hands the workspace the usable one to open
// on. The unusable period is not hidden and not faked: its own strip says why, in
// its own words, on its own tab.
//
// TECHNIQUE. vitest runs environment:"node" and collects src/-star-star/*.test.ts,
// so this is the pure gate (`reportsGate`, the page's actual decision) plus
// renderToStaticMarkup of the workspace for what the owner sees. The tab toggle is
// client state and cannot be clicked here, so the second tab is rendered by asking
// for it as the default — the same component path a click reaches.
// ---------------------------------------------------------------------------

// The gate lives beside buildSnapshot, whose module reaches the enquiry store. The
// gate itself is pure; the mock only keeps the store out of a unit test.
vi.mock("@/lib/speed-to-lead/repository", () => ({
  listLeads: vi.fn(),
  countLeadsInWindow: vi.fn(),
}));

import { reportsGate, snapshotUsable, type ReportSnapshot, type ReportsGate } from "@/lib/reports/snapshot";
import { ReportsWorkspace } from "./reports-workspace";

/** A snapshot with everything readable, overridden field by field per case. */
function snap(period: "week" | "month", over: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return {
    period,
    windowLabel: period === "week" ? "last 7 days" : "last 30 days",
    enquiries: 12,
    contacted: 9,
    booked: 4,
    enquiryToBookedRate: 0.33,
    avgFirstResponseSeconds: 55,
    topSource: { source: "smile-assessment", count: 7 },
    hasEnoughData: true,
    readFailed: false,
    truncated: false,
    countsExact: true,
    ...over,
  };
}

/** The month that started all this: busier than one read, and uncountable with it. */
const BUSY_UNCOUNTED_MONTH = snap("month", {
  truncated: true,
  countsExact: false,
  hasEnoughData: false,
  enquiries: 500,
});

const HEALTHY_WEEK = snap("week", { enquiries: 31, booked: 9, enquiryToBookedRate: 0.29 });

/** The source with comments stripped: what the file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("the reports page is gated on both periods, not the month alone", () => {
  it("renders the workspace when the month is unusable but the week is fine", () => {
    const gate = reportsGate({ week: HEALTHY_WEEK, month: BUSY_UNCOUNTED_MONTH });

    expect(gate.kind, "a busy month is not a reason to blank the week").toBe("workspace");
    expect(snapshotUsable(HEALTHY_WEEK)).toBe(true);
    expect(snapshotUsable(BUSY_UNCOUNTED_MONTH)).toBe(false);
  });

  it("opens on the usable period rather than on the tab that can only explain itself", () => {
    const gate = reportsGate({ week: HEALTHY_WEEK, month: BUSY_UNCOUNTED_MONTH });
    expect(gate.kind === "workspace" && gate.defaultPeriod).toBe("week");

    // ...and the month stays the default whenever the month can be shown.
    const both = reportsGate({ week: HEALTHY_WEEK, month: snap("month", { enquiries: 96 }) });
    expect(both.kind === "workspace" && both.defaultPeriod).toBe("month");
  });

  it("the same busy month with an exact count is usable on its own tab", () => {
    // The other half of this fix: the count is made in our own Postgres, so a
    // saturated DETAIL read no longer makes the period unshowable.
    const counted = snap("month", { truncated: true, countsExact: true, enquiries: 912 });
    expect(snapshotUsable(counted)).toBe(true);
    const gate = reportsGate({ week: HEALTHY_WEEK, month: counted });
    expect(gate.kind === "workspace" && gate.defaultPeriod).toBe("month");
  });

  it("refuses the page when neither period can be read, and gives the month's reason", () => {
    const failedBoth = reportsGate({
      week: snap("week", { readFailed: true, hasEnoughData: false, enquiries: 0 }),
      month: snap("month", { readFailed: true, hasEnoughData: false, enquiries: 0 }),
    });
    expect(failedBoth).toEqual({ kind: "unavailable", readFailed: true, period: "month" });

    const busyBoth = reportsGate({
      week: snap("week", { truncated: true, countsExact: false, hasEnoughData: false }),
      month: BUSY_UNCOUNTED_MONTH,
    });
    expect(busyBoth).toEqual({ kind: "unavailable", readFailed: false, period: "month" });
  });

  it("a genuinely quiet practice still gets the awaiting state, not a workspace", () => {
    const gate = reportsGate({
      week: snap("week", { enquiries: 0, booked: 0, contacted: 0, hasEnoughData: false }),
      month: snap("month", { enquiries: 0, booked: 0, contacted: 0, hasEnoughData: false }),
    });
    expect(gate.kind, "two readable, empty periods is a fact about the practice").toBe("awaiting");
  });
});

// ---------------------------------------------------------------------------
// AN OUTAGE MUST NEVER WEAR THE QUIET-PRACTICE MESSAGE.
//
// The gate above drew its `awaiting` decision from the USABLE periods alone:
//
//     const withActivity = usable.filter((p) => snapshots[p].enquiries > 0);
//     if (withActivity.length === 0) return { kind: "awaiting" };
//
// Read that with a month whose read FAILED beside a quiet week. The month is not
// usable, so it is not in `usable` and cannot be in `withActivity`; the week is
// usable and empty, so `withActivity` is empty — and the page tells the owner
// "Your first report unlocks with live activity". The store was down. The page
// this replaced said, for exactly this input, "This is a read failing, not a quiet
// month". Losing that is how an outage comes to be read as a quiet practice and
// acted on as one — nobody chases the store, because nothing looked wrong.
//
// The rule, walked row by row below: the workspace still renders on activity in
// EITHER period, but `awaiting` may only be claimed when EVERY period was read.
// One unusable period and nothing to show means the page states that period's own
// reason, and a read that failed is named ahead of a period merely too busy to
// count.
// ---------------------------------------------------------------------------
describe("the gate's full truth table", () => {
  /** Readable, with real enquiries: the ordinary period. */
  const ACTIVE = (p: "week" | "month") => snap(p, { enquiries: 24, booked: 7 });
  /** Readable and empty: a genuinely quiet period. */
  const QUIET = (p: "week" | "month") =>
    snap(p, { enquiries: 0, booked: 0, contacted: 0, hasEnoughData: false });
  /** The store did not answer. NOT zero activity — no activity was learned at all. */
  const FAILED = (p: "week" | "month") =>
    snap(p, { readFailed: true, hasEnoughData: false, enquiries: 0, booked: 0, contacted: 0 });
  /** Busier than one read and uncountable with it: its figures would be a floor. */
  const FLOOR = (p: "week" | "month") =>
    snap(p, { truncated: true, countsExact: false, hasEnoughData: false, enquiries: 500 });

  const STATES = { ACTIVE, QUIET, FAILED, FLOOR };
  type StateName = keyof typeof STATES;

  const rows: [StateName, StateName, ReportsGate][] = [
    // month           week            expected
    ["ACTIVE", "ACTIVE", { kind: "workspace", defaultPeriod: "month" }],
    ["ACTIVE", "QUIET", { kind: "workspace", defaultPeriod: "month" }],
    ["ACTIVE", "FAILED", { kind: "workspace", defaultPeriod: "month" }],
    ["ACTIVE", "FLOOR", { kind: "workspace", defaultPeriod: "month" }],
    ["QUIET", "ACTIVE", { kind: "workspace", defaultPeriod: "week" }],
    ["QUIET", "QUIET", { kind: "awaiting" }],
    ["QUIET", "FAILED", { kind: "unavailable", readFailed: true, period: "week" }],
    ["QUIET", "FLOOR", { kind: "unavailable", readFailed: false, period: "week" }],
    ["FAILED", "ACTIVE", { kind: "workspace", defaultPeriod: "week" }],
    ["FAILED", "QUIET", { kind: "unavailable", readFailed: true, period: "month" }],
    ["FAILED", "FAILED", { kind: "unavailable", readFailed: true, period: "month" }],
    ["FAILED", "FLOOR", { kind: "unavailable", readFailed: true, period: "month" }],
    ["FLOOR", "ACTIVE", { kind: "workspace", defaultPeriod: "week" }],
    ["FLOOR", "QUIET", { kind: "unavailable", readFailed: false, period: "month" }],
    ["FLOOR", "FAILED", { kind: "unavailable", readFailed: true, period: "week" }],
    ["FLOOR", "FLOOR", { kind: "unavailable", readFailed: false, period: "month" }],
  ];

  for (const [monthState, weekState, expected] of rows) {
    const outcome =
      expected.kind === "workspace"
        ? `the workspace on the ${expected.defaultPeriod}`
        : expected.kind === "awaiting"
          ? "the quiet-practice awaiting state"
          : `${expected.readFailed ? "a read failure" : "a period bigger than one read"}, the ${expected.period}'s`;
    it(`month ${monthState} + week ${weekState} -> ${outcome}`, () => {
      const gate = reportsGate({
        month: STATES[monthState]("month"),
        week: STATES[weekState]("week"),
      });
      expect(gate).toEqual(expected);
    });
  }

  it("never shows the awaiting state while any period went unread", () => {
    // The single rule the table above is an enumeration of. Stated once on its own
    // so a future row cannot quietly re-open the hole by being written wrong.
    for (const [monthState, weekState] of rows) {
      if (monthState === "FAILED" || weekState === "FAILED" || monthState === "FLOOR" || weekState === "FLOOR") {
        const gate = reportsGate({
          month: STATES[monthState]("month"),
          week: STATES[weekState]("week"),
        });
        expect(gate.kind, `month ${monthState} + week ${weekState} is not a quiet practice`).not.toBe(
          "awaiting",
        );
      }
    }
  });

  it("the regression itself: a failed month beside a quiet week is a read failure", () => {
    // usable = [week], withActivity = [] — the input that returned `awaiting`.
    const month = FAILED("month");
    const week = QUIET("week");
    expect(snapshotUsable(month), "the failed month is not usable").toBe(false);
    expect(snapshotUsable(week), "the quiet week is perfectly usable").toBe(true);
    expect(week.enquiries, "and it holds no activity to render a workspace from").toBe(0);

    const gate = reportsGate({ week, month });
    expect(gate.kind, "the store was down; nobody may be told their practice is quiet").not.toBe(
      "awaiting",
    );
    expect(gate).toEqual({ kind: "unavailable", readFailed: true, period: "month" });
  });
});

describe("what the owner sees when one period is unusable", () => {
  it("shows the week's real figures and keeps the Generate button reachable", () => {
    const html = renderToStaticMarkup(
      createElement(ReportsWorkspace, {
        clientSlug: "vitality",
        snapshots: { week: HEALTHY_WEEK, month: BUSY_UNCOUNTED_MONTH },
        defaultPeriod: "week" as const,
      }),
    );

    expect(html).toContain("Live snapshot, last 7 days");
    expect(html, "the week's enquiries, on screen").toMatch(/>31<\/p>/); // not a stray "31" in a class
    expect(html, "the whole point of the page was previously unreachable").toContain(
      "Generate report",
    );
    expect(html).toContain("Month"); // the other tab is still there to switch to
  });

  it("the month tab explains itself instead of showing a floor as a total", () => {
    const html = renderToStaticMarkup(
      createElement(ReportsWorkspace, {
        clientSlug: "vitality",
        snapshots: { week: HEALTHY_WEEK, month: BUSY_UNCOUNTED_MONTH },
        defaultPeriod: "month" as const,
      }),
    );

    expect(html).toContain("more enquiries than a single read carries");
    expect(html, "500 is what the read stopped at, not what the month held").not.toContain(">500<");
  });

  it("a counted busy month shows its totals and names the two sampled figures", () => {
    const counted = snap("month", {
      truncated: true,
      countsExact: true,
      enquiries: 912,
      booked: 240,
      enquiryToBookedRate: 0.26,
    });
    const html = renderToStaticMarkup(
      createElement(ReportsWorkspace, {
        clientSlug: "vitality",
        snapshots: { week: HEALTHY_WEEK, month: counted },
        defaultPeriod: "month" as const,
      }),
    );

    expect(html).toMatch(/>912<\/p>/);
    expect(html).toMatch(/>240<\/p>/);
    expect(html).toContain("counted in full for this period");
    expect(html).toContain("measured over the most recent enquiries");
  });
});

describe("the page's own gate", () => {
  const viewSource = codeOnly(
    readFileSync(resolve(process.cwd(), "src/components/client/reports/reports-view.tsx"), "utf8"),
  );

  it("asks reportsGate rather than reading the month snapshot's flags itself", () => {
    expect(viewSource).toContain("reportsGate({ week, month })");
    expect(
      viewSource,
      "gating the workspace on month.truncated is the defect this file exists for",
    ).not.toMatch(/month\.truncated/);
  });

  it("hands the workspace the period to open on", () => {
    expect(viewSource).toMatch(/defaultPeriod=\{gate\.defaultPeriod\}/);
  });

  it("names the period the refusal is about instead of assuming the month", () => {
    // The gate can now refuse the page because of the WEEK, so copy that says "this
    // month holds more enquiries than a single read carries" would be describing the
    // wrong window.
    expect(viewSource).toMatch(/gate\.period/);
  });
});
