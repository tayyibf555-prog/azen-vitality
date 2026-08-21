// The report snapshot reads REAL enquiry activity from the live store and computes
// only genuine figures (enquiries, bookings, conversion, response time). No
// fabricated numbers. The repository is mocked so the test is pure and fast.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LeadStage } from "@/lib/types";
import type { SpeedToLeadLead } from "@/lib/speed-to-lead/types";

const { listLeadsMock } = vi.hoisted(() => ({ listLeadsMock: vi.fn() }));
vi.mock("@/lib/speed-to-lead/repository", () => ({ listLeads: listLeadsMock }));

import { buildSnapshot } from "./snapshot";

/** ISO timestamp `days` before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A lead carrying only the fields the snapshot reads (cast for the test). */
function lead(p: {
  createdAt: string;
  stage?: LeadStage;
  source?: string;
  firstResponseAt?: string | null;
}): SpeedToLeadLead {
  return {
    stage: "new",
    source: "smile-assessment",
    firstResponseAt: null,
    ...p,
  } as unknown as SpeedToLeadLead;
}

beforeEach(() => {
  listLeadsMock.mockReset();
});

describe("buildSnapshot computes real activity only", () => {
  it("counts enquiries, bookings and conversion in the monthly window", async () => {
    listLeadsMock.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, i) => lead({ createdAt: daysAgo(i + 1), stage: "new" })),
      ...Array.from({ length: 4 }, (_, i) => lead({ createdAt: daysAgo(i + 1), stage: "booked" })),
      // Outside the 30-day window: must be excluded.
      lead({ createdAt: daysAgo(45), stage: "booked" }),
    ]);

    const m = await buildSnapshot("month", ["site-cc"]);
    expect(m.period).toBe("month");
    expect(m.enquiries).toBe(10);
    expect(m.booked).toBe(4);
    expect(m.enquiryToBookedRate).toBeCloseTo(0.4, 5);
    expect(m.hasEnoughData).toBe(true); // 10 >= monthly minimum
  });

  it("scopes the weekly window to the last 7 days", async () => {
    listLeadsMock.mockResolvedValue([
      lead({ createdAt: daysAgo(1) }),
      lead({ createdAt: daysAgo(2) }),
      lead({ createdAt: daysAgo(3) }),
      lead({ createdAt: daysAgo(20) }), // inside month, outside week
    ]);

    const w = await buildSnapshot("week", ["site-cc"]);
    expect(w.period).toBe("week");
    expect(w.enquiries).toBe(3);
    expect(w.hasEnoughData).toBe(true); // 3 >= weekly minimum
  });

  it("averages the first-response time across contacted leads only", async () => {
    listLeadsMock.mockResolvedValue([
      // created 1 day ago, first response 60s later
      lead({ createdAt: daysAgo(1), firstResponseAt: new Date(Date.parse(daysAgo(1)) + 60_000).toISOString() }),
      // created 2 days ago, first response 120s later
      lead({ createdAt: daysAgo(2), firstResponseAt: new Date(Date.parse(daysAgo(2)) + 120_000).toISOString() }),
      // never contacted
      lead({ createdAt: daysAgo(3), firstResponseAt: null }),
    ]);

    const m = await buildSnapshot("month", ["site-cc"]);
    expect(m.contacted).toBe(2);
    expect(m.avgFirstResponseSeconds).toBe(90); // (60 + 120) / 2
  });

  it("locks the report when there is too little live activity", async () => {
    listLeadsMock.mockResolvedValue([
      lead({ createdAt: daysAgo(1) }),
      lead({ createdAt: daysAgo(2) }),
    ]);
    const m = await buildSnapshot("month", ["site-cc"]);
    expect(m.enquiries).toBe(2);
    expect(m.hasEnoughData).toBe(false); // below the monthly minimum
  });

  it("degrades to a zero snapshot when the store errors, never throwing", async () => {
    listLeadsMock.mockRejectedValue(new Error("db down"));
    const m = await buildSnapshot("month", ["site-cc"]);
    expect(m.enquiries).toBe(0);
    expect(m.booked).toBe(0);
    expect(m.avgFirstResponseSeconds).toBeNull();
    expect(m.topSource).toBeNull();
    expect(m.hasEnoughData).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A BOUNDED READ MUST NOT BE PRESENTED AS A COMPLETE COUNT.
//
// This snapshot used to ask for the newest 500 leads across ALL history and then
// filter to the window in memory — the same shape as the Dentally reads this pass
// corrected: a read with a bound, whose result was stated as a total. listLeads'
// own doc-comment warns about exactly this ("which under-reports silently the
// moment a busy day is longer than the bound"), which is why `sinceIso` exists.
//
// These figures are not decoration: the AI business review narrates them as fact,
// so a floor read aloud as a total is a report that lies, and a failed read read
// aloud as "no enquiries" tells an owner mid-campaign that nobody rang.
// ---------------------------------------------------------------------------
describe("the snapshot states only counts it can stand behind", () => {
  it("asks the STORE for the window instead of filtering the newest 500 in memory", async () => {
    listLeadsMock.mockResolvedValue([lead({ createdAt: daysAgo(1) })]);
    await buildSnapshot("week", ["site-cc"]);

    const args = listLeadsMock.mock.calls[0][0] as { sinceIso?: string; limit?: number };
    expect(args.sinceIso, "without sinceIso the bound is spent on history, not the window").toBeTruthy();
    const since = Date.parse(args.sinceIso!);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(since - sevenDaysAgo)).toBeLessThan(60_000);
    expect(args.limit).toBe(500);
  });

  it("a window that saturates the bound is reported truncated, never as a total", async () => {
    // 500 in-window leads: there may be more, and "may" is not a count.
    listLeadsMock.mockResolvedValue(
      Array.from({ length: 500 }, (_, i) => lead({ createdAt: daysAgo(1), stage: i % 4 === 0 ? "booked" : "new" })),
    );
    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.truncated).toBe(true);
    expect(m.readFailed).toBe(false);
    expect(m.hasEnoughData, "a review written over a floor would state it as a total").toBe(false);
  });

  it("a read that fails is NOT a quiet month", async () => {
    listLeadsMock.mockRejectedValue(new Error("db down"));
    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.readFailed).toBe(true);
    expect(m.truncated).toBe(false);
    expect(m.hasEnoughData).toBe(false);
  });

  it("a complete, quiet window is neither truncated nor failed", async () => {
    // The control: the honest flags must stay OFF for the ordinary case, or they
    // would blank a perfectly good report.
    listLeadsMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => lead({ createdAt: daysAgo(i + 1) })),
    );
    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.readFailed).toBe(false);
    expect(m.truncated).toBe(false);
    expect(m.hasEnoughData).toBe(true);
  });
});
