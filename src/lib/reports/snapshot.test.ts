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
