// The report snapshot reads REAL enquiry activity from the live store and computes
// only genuine figures (enquiries, bookings, conversion, response time). No
// fabricated numbers. The repository is mocked so the test is pure and fast.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LeadStage } from "@/lib/types";
import type { SpeedToLeadLead } from "@/lib/speed-to-lead/types";

const { listLeadsMock, countLeadsMock } = vi.hoisted(() => ({
  listLeadsMock: vi.fn(),
  countLeadsMock: vi.fn(),
}));
vi.mock("@/lib/speed-to-lead/repository", () => ({
  listLeads: listLeadsMock,
  countLeadsInWindow: countLeadsMock,
}));

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
  countLeadsMock.mockReset();
  // THE DEFAULT IS "NO COUNT AVAILABLE", so every test written before the store was
  // asked to count exercises the fallback it was written against: the figures come
  // off the bounded sample, and a saturated sample is a floor. The counted path is
  // opted into per test in the last block, which is where it belongs — the point of
  // that block is that the two paths behave differently.
  countLeadsMock.mockRejectedValue(new Error("no exact count in this fixture"));
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

// ---------------------------------------------------------------------------
// A COUNT IS NOT A READ.
//
// Everything above is about a BOUNDED read being honest about its bound. This block
// is about the half of the snapshot that never needed a bound at all.
//
// The enquiry store is OUR OWN Postgres, not Dentally. "How many enquiries landed in
// the last 30 days" is a count there — `count: "exact"` with `head: true` returns no
// rows — so it is exact whether the month held five leads or fifty thousand, and it
// costs the same one query either way. The snapshot used to answer that question by
// fetching the newest 500 leads in the window and taking `.length`, which is a floor
// the moment the practice is busy, and it then had to declare its own headline
// figures unusable to avoid publishing that floor as a total. On the page, that
// blanked the owner's reports at her busiest.
//
// So the counts are counted and the DETAIL stays sampled, and the difference is
// carried in the open: `countsExact` for the first, `truncated` for the second.
// ---------------------------------------------------------------------------
describe("the headline counts are counted, not sampled", () => {
  /** The store's own answer for the window: `total` enquiries, `booked` of them booked. */
  function counting(total: number, booked: number) {
    countLeadsMock.mockImplementation(
      async (_siteIds: string[], _sinceIso: string, stages?: string[]) =>
        stages && stages.includes("booked") ? booked : total,
    );
  }

  /** A saturated detail read: 500 rows back, which is the bound exactly. */
  function saturatedSample() {
    listLeadsMock.mockResolvedValue(
      Array.from({ length: 500 }, () => lead({ createdAt: daysAgo(1), stage: "new" })),
    );
  }

  it("states the exact total for a month busier than the detail read carries", async () => {
    saturatedSample();
    counting(912, 240);

    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.enquiries, "912 were counted; 500 is only what the sample stopped at").toBe(912);
    expect(m.booked).toBe(240);
    expect(m.countsExact).toBe(true);
    expect(m.truncated, "the SAMPLE is still bounded, and still says so").toBe(true);
    expect(m.enquiryToBookedRate).toBeCloseTo(0.26, 5);
    expect(m.hasEnoughData, "a counted window is not a floor, so the review unlocks").toBe(true);
  });

  it("counts the window the sample asks for, and asks for booked as its own count", async () => {
    saturatedSample();
    counting(912, 240);
    await buildSnapshot("month", ["site-cc", "site-rv"]);

    expect(countLeadsMock).toHaveBeenCalledTimes(2);
    const [enquiryCall, bookedCall] = countLeadsMock.mock.calls as [
      [string[], string, string[]?],
      [string[], string, string[]?],
    ];
    expect(enquiryCall[0]).toEqual(["site-cc", "site-rv"]);
    expect(enquiryCall[2], "the enquiry count is every stage").toBeUndefined();
    expect(bookedCall[2]).toEqual(["booked"]);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(Date.parse(enquiryCall[1]) - thirtyDaysAgo)).toBeLessThan(60_000);
    expect(enquiryCall[1], "both reads must mean the same window").toBe(bookedCall[1]);
  });

  it("leaves the sampled figures sampled: the average is over the rows it holds", async () => {
    listLeadsMock.mockResolvedValue(
      Array.from({ length: 500 }, () =>
        lead({
          createdAt: daysAgo(1),
          firstResponseAt: new Date(Date.parse(daysAgo(1)) + 60_000).toISOString(),
        }),
      ),
    );
    counting(912, 240);

    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.enquiries).toBe(912);
    expect(m.contacted, "the denominator of the average describes the same 500 rows").toBe(500);
    expect(m.avgFirstResponseSeconds).toBe(60);
  });

  it("falls back to the sample, and back to the floor, when the count itself fails", async () => {
    saturatedSample(); // countLeadsMock rejects by default here
    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.countsExact).toBe(false);
    expect(m.enquiries).toBe(500);
    expect(m.truncated).toBe(true);
    expect(m.hasEnoughData, "an uncounted floor is exactly what must not be narrated").toBe(false);
  });

  it("a failed detail read is still a failed read, whatever the count says", async () => {
    listLeadsMock.mockRejectedValue(new Error("db down"));
    counting(900, 300);

    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.readFailed).toBe(true);
    // "900 enquiries, nobody contacted, no source" is a worse lie than showing
    // nothing, so the count does not rescue a snapshot with no rows behind it.
    expect(m.enquiries).toBe(0);
    expect(m.countsExact).toBe(false);
    expect(m.avgFirstResponseSeconds).toBeNull();
    expect(m.hasEnoughData).toBe(false);
  });

  it("a quiet window is counted too, and the two agree", async () => {
    listLeadsMock.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => lead({ createdAt: daysAgo(i + 1), stage: i < 4 ? "booked" : "new" })),
    );
    counting(12, 4);

    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.enquiries).toBe(12);
    expect(m.booked).toBe(4);
    expect(m.countsExact).toBe(true);
    expect(m.truncated).toBe(false);
    expect(m.hasEnoughData).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE COUNTS AND THE DETAIL MUST DESCRIBE ONE WINDOW.
//
// The snapshot asks the store three questions CONCURRENTLY — how many enquiries,
// how many of them booked, and what the newest of them look like — and each one
// reaches the database at its own instant. The window they were given had a floor
// and no ceiling, so a lead created while they were in flight fell inside whichever
// queries resolved after it and outside the ones that resolved before, and the
// answers stopped describing the same set of leads.
//
// The result is not a rounding error. `contacted` is measured off the detail rows
// and `enquiries` is counted, so the pair could read "13 contacted out of 12
// enquiries"; `booked` and `enquiries` are two separate counts divided by one
// another, so the conversion could read 201%. Both are printed on the page as fact
// and handed to the model that narrates the review.
//
// So one instant is captured at entry and given to every query, and the derived rate
// is clamped as a second line of defence.
// ---------------------------------------------------------------------------
describe("the counts and the detail describe one window", () => {
  /** What a store honouring these bounds would return. */
  function windowOf(
    rows: SpeedToLeadLead[],
    sinceIso: string,
    untilIso: string | undefined,
    stages?: string[],
  ): SpeedToLeadLead[] {
    return rows.filter((l) => {
      const t = Date.parse(l.createdAt);
      if (t < Date.parse(sinceIso)) return false;
      if (untilIso && t > Date.parse(untilIso)) return false;
      if (stages && stages.length > 0 && !stages.includes(l.stage)) return false;
      return true;
    });
  }

  /** A lead contacted 60 seconds after it came in. */
  function contactedLead(createdAt: string, stage: LeadStage = "new"): SpeedToLeadLead {
    return lead({
      createdAt,
      stage,
      firstResponseAt: new Date(Date.parse(createdAt) + 60_000).toISOString(),
    });
  }

  /**
   * An enquiry that lands WHILE the snapshot's queries are in flight, so its
   * created_at is after the instant the snapshot captured. It is the only kind of row
   * a shared ceiling can exclude, and the only kind that can otherwise be in one
   * query's answer and not another's.
   */
  function midFlight(stage: LeadStage = "new"): SpeedToLeadLead {
    return contactedLead(new Date(Date.now() + 5_000).toISOString(), stage);
  }

  it("gives every query the SAME upper instant, taken once at entry", async () => {
    listLeadsMock.mockResolvedValue([contactedLead(daysAgo(1))]);
    countLeadsMock.mockImplementation(async (_s: string[], _since: string, stages?: string[]) =>
      stages?.includes("booked") ? 3 : 12,
    );

    const before = Date.now();
    await buildSnapshot("month", ["site-cc"]);
    const after = Date.now();

    const detailArgs = listLeadsMock.mock.calls[0][0] as { untilIso?: string; sinceIso?: string };
    const [enquiryCall, bookedCall] = countLeadsMock.mock.calls as [
      [string[], string, string[]?, string?],
      [string[], string, string[]?, string?],
    ];

    expect(detailArgs.untilIso, "an open-topped window is what lets the reads drift").toBeTruthy();
    expect(enquiryCall[3], "the enquiry count shares the ceiling").toBe(detailArgs.untilIso);
    expect(bookedCall[3], "and so does the booked count it is divided into").toBe(
      detailArgs.untilIso,
    );
    expect(enquiryCall[1], "the floor was already shared").toBe(detailArgs.sinceIso);
    expect(bookedCall[1]).toBe(detailArgs.sinceIso);

    // Captured once, at entry: not one `new Date()` per query.
    const at = Date.parse(detailArgs.untilIso!);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  });

  it("a lead landing mid-flight cannot be contacted-but-never-enquired", async () => {
    // Twelve settled enquiries, every one of them answered. The counts reach the
    // store first and see it as it was; the detail read arrives a moment later, by
    // which time a thirteenth enquiry has come in and been answered.
    const settled = Array.from({ length: 12 }, (_, i) =>
      contactedLead(daysAgo(i + 1), i < 4 ? "booked" : "new"),
    );
    const landed = [...settled, midFlight()];

    countLeadsMock.mockImplementation(
      async (_s: string[], sinceIso: string, stages?: string[], untilIso?: string) =>
        windowOf(settled, sinceIso, untilIso, stages).length,
    );
    listLeadsMock.mockImplementation(
      async (args: { sinceIso: string; untilIso?: string; limit: number }) =>
        windowOf(landed, args.sinceIso, args.untilIso).slice(0, args.limit),
    );

    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.enquiries).toBe(12);
    expect(m.contacted, "the sample was bounded to the same window the counts were").toBe(12);
    expect(
      m.contacted,
      "more leads answered than ever enquired is not a thing that can be true",
    ).toBeLessThanOrEqual(m.enquiries);
  });

  it("a booking landing between the two counts cannot outnumber the enquiries", async () => {
    // Four enquiries in the window, all four booked. A fifth lands and is booked in
    // the gap between the enquiry count and the booked count.
    const settled = Array.from({ length: 4 }, (_, i) => contactedLead(daysAgo(i + 1), "booked"));
    const landed = [...settled, midFlight("booked")];

    countLeadsMock.mockImplementation(
      async (_s: string[], sinceIso: string, stages?: string[], untilIso?: string) =>
        windowOf(stages?.includes("booked") ? landed : settled, sinceIso, untilIso, stages).length,
    );
    listLeadsMock.mockImplementation(
      async (args: { sinceIso: string; untilIso?: string; limit: number }) =>
        windowOf(settled, args.sinceIso, args.untilIso).slice(0, args.limit),
    );

    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.enquiries).toBe(4);
    expect(m.booked, "the later count answers about the same window as the earlier one").toBe(4);
    expect(m.booked).toBeLessThanOrEqual(m.enquiries);
    expect(m.enquiryToBookedRate).toBe(1);
  });

  it("never prints a conversion rate above 100%, whatever the two figures say", async () => {
    // Defence in depth, and deliberately impossible input: the shared window above is
    // what should prevent this, so this pins what happens if anything else ever lets
    // the two figures disagree — a clock skew, a row committed out of order, a future
    // caller. 201 booked out of 100 enquiries would render as "201%" on the page and
    // be read aloud by the AI review as a fact about the practice.
    listLeadsMock.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => contactedLead(daysAgo((i % 20) + 1), "booked")),
    );
    countLeadsMock.mockImplementation(async (_s: string[], _since: string, stages?: string[]) =>
      stages?.includes("booked") ? 201 : 100,
    );

    const m = await buildSnapshot("month", ["site-cc"]);

    expect(m.enquiryToBookedRate, "clamped to [0,1], not 2.01").toBe(1);
    expect(Math.round(m.enquiryToBookedRate * 100)).toBeLessThanOrEqual(100);
  });

  it("leaves an ordinary rate exactly where it was", async () => {
    // The clamp must not round or shift a real figure: the control for the two above.
    listLeadsMock.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => contactedLead(daysAgo((i % 20) + 1))),
    );
    countLeadsMock.mockImplementation(async (_s: string[], _since: string, stages?: string[]) =>
      stages?.includes("booked") ? 3 : 40,
    );

    const m = await buildSnapshot("month", ["site-cc"]);
    expect(m.enquiryToBookedRate).toBeCloseTo(0.08, 5);
  });
});
