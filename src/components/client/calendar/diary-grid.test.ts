import { describe, expect, it } from "vitest";
import {
  dayBounds,
  diaryColumns,
  effectiveMinutes,
  hourMarks,
  labelMinutes,
  layoutColumn,
  londonMinutes,
  nowFraction,
} from "./diary-grid";

const appt = (start: string, durationMin = 30, finish: string | null = null) => ({
  start,
  finish,
  durationMin,
});

describe("londonMinutes", () => {
  it("reads the London wall clock, not UTC, through BST", () => {
    // 08:30 UTC in July is 09:30 in London. Getting this wrong draws every
    // appointment an hour high for seven months of the year.
    expect(londonMinutes("2026-07-30T08:30:00Z")).toBe(9 * 60 + 30);
  });

  it("agrees with UTC in winter", () => {
    expect(londonMinutes("2026-01-15T08:30:00Z")).toBe(8 * 60 + 30);
  });

  it("reports midnight as 0, never 1440", () => {
    expect(londonMinutes("2026-01-15T00:00:00Z")).toBe(0);
  });

  it("is NaN for an unparseable instant", () => {
    expect(Number.isNaN(londonMinutes("not a date"))).toBe(true);
  });
});

describe("effectiveMinutes", () => {
  it("prefers a sane finish time over the duration field", () => {
    expect(
      effectiveMinutes(appt("2026-07-30T09:00:00Z", 30, "2026-07-30T10:00:00Z")),
    ).toBe(60);
  });

  it("falls back to the duration when finish is absent", () => {
    expect(effectiveMinutes(appt("2026-07-30T09:00:00Z", 45))).toBe(45);
  });

  it("rejects a finish that precedes the start", () => {
    expect(
      effectiveMinutes(appt("2026-07-30T09:00:00Z", 30, "2026-07-30T08:00:00Z")),
    ).toBe(30);
  });

  it("rejects an overnight finish rather than drawing off the grid", () => {
    expect(
      effectiveMinutes(appt("2026-07-30T15:00:00Z", 30, "2026-07-31T09:00:00Z")),
    ).toBe(30);
  });

  it("uses 30 minutes when the duration is missing or zero", () => {
    expect(effectiveMinutes(appt("2026-07-30T09:00:00Z", 0))).toBe(30);
  });
});

describe("layoutColumn", () => {
  it("gives non-overlapping appointments the full width", () => {
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 30),
      appt("2026-07-30T09:00:00Z", 30),
    ]);
    expect(out.map((p) => p.lanes)).toEqual([1, 1]);
    expect(out.map((p) => p.lane)).toEqual([0, 0]);
  });

  it("treats back-to-back appointments as no clash", () => {
    // 09:00-09:30 then 09:30-10:00 touch but do not overlap.
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 30),
      appt("2026-07-30T08:30:00Z", 30),
    ]);
    expect(out.every((p) => p.lanes === 1)).toBe(true);
  });

  it("splits two genuinely overlapping appointments into two lanes", () => {
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 60),
      appt("2026-07-30T08:30:00Z", 30),
    ]);
    expect(out.map((p) => p.lanes)).toEqual([2, 2]);
    expect(out.map((p) => p.lane).sort()).toEqual([0, 1]);
  });

  it("counts lanes per cluster, so one clash does not narrow the whole day", () => {
    // A clash at 09:00, then two quiet afternoon appointments. The afternoon
    // must stay full width; counting lanes column-wide would halve everything.
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 60),
      appt("2026-07-30T08:30:00Z", 30),
      appt("2026-07-30T13:00:00Z", 30),
      appt("2026-07-30T14:00:00Z", 30),
    ]);
    const byStart = [...out].sort((a, b) => a.startMin - b.startMin);
    expect(byStart.map((p) => p.lanes)).toEqual([2, 2, 1, 1]);
  });

  it("returns to full width immediately after a clash ends", () => {
    // 09:00-10:00 double-booked, then a normal 10:00-10:30. The 10:00 block
    // starts exactly as the clash ends, so it belongs to a NEW cluster and must
    // be full width. Carrying the clash's lane count across the boundary would
    // leave every appointment after the day's first double-booking half width.
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 60),
      appt("2026-07-30T08:30:00Z", 30),
      appt("2026-07-30T09:00:00Z", 30),
    ]);
    const last = [...out].sort((a, b) => a.startMin - b.startMin)[2];
    expect(last.startMin).toBe(10 * 60);
    expect(last.lanes).toBe(1);
  });

  it("reuses a lane once its earlier appointment has ended", () => {
    // A long 09:00-11:00 block beside two consecutive half-hours: the short
    // pair share one lane rather than forcing a third.
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 120),
      appt("2026-07-30T08:00:00Z", 30),
      appt("2026-07-30T08:30:00Z", 30),
    ]);
    expect(out.every((p) => p.lanes === 2)).toBe(true);
  });

  it("drops appointments with an unparseable start rather than placing them at midnight", () => {
    const out = layoutColumn([appt("nonsense", 30), appt("2026-07-30T08:00:00Z", 30)]);
    expect(out).toHaveLength(1);
    expect(out[0].startMin).toBe(9 * 60);
  });

  it("positions a block by its London start and true length", () => {
    const [p] = layoutColumn([appt("2026-07-30T08:15:00Z", 30, "2026-07-30T09:00:00Z")]);
    expect(p.startMin).toBe(9 * 60 + 15);
    expect(p.endMin).toBe(10 * 60);
  });
});

describe("dayBounds", () => {
  it("shows the full opening hours even when only one appointment is booked", () => {
    expect(dayBounds([{ startMin: 600, endMin: 630 }])).toEqual({
      startMin: 8 * 60,
      endMin: 19 * 60,
    });
  });

  it("extends to cover an early appointment rather than clipping it", () => {
    expect(dayBounds([{ startMin: 7 * 60 + 15, endMin: 7 * 60 + 45 }]).startMin).toBe(7 * 60);
  });

  it("extends to cover a late finish", () => {
    expect(dayBounds([{ startMin: 19 * 60, endMin: 20 * 60 + 10 }]).endMin).toBe(21 * 60);
  });

  it("ignores unparseable spans", () => {
    expect(dayBounds([{ startMin: Number.NaN, endMin: Number.NaN }])).toEqual({
      startMin: 8 * 60,
      endMin: 19 * 60,
    });
  });

  it("never returns a zero-height window", () => {
    const b = dayBounds([{ startMin: 540, endMin: 540 }], 540, 540);
    expect(b.endMin).toBeGreaterThan(b.startMin);
  });
});

describe("nowFraction", () => {
  const bounds = { startMin: 8 * 60, endMin: 20 * 60 };

  it("places the marker proportionally within the drawn day", () => {
    // 14:00 London on 30 July 2026 (BST) is 13:00 UTC; halfway through 08:00-20:00.
    const f = nowFraction(new Date("2026-07-30T13:00:00Z"), "2026-07-30", bounds);
    expect(f).toBeCloseTo(0.5, 5);
  });

  it("is null when the viewed day is not today", () => {
    expect(nowFraction(new Date("2026-07-30T13:00:00Z"), "2026-07-31", bounds)).toBeNull();
  });

  it("is null before the grid starts, rather than pinning to the top", () => {
    expect(nowFraction(new Date("2026-07-30T05:00:00Z"), "2026-07-30", bounds)).toBeNull();
  });

  it("is null after the grid ends", () => {
    expect(nowFraction(new Date("2026-07-30T21:30:00Z"), "2026-07-30", bounds)).toBeNull();
  });
});

describe("hourMarks and labelMinutes", () => {
  it("rules every hour inclusive of both ends", () => {
    expect(hourMarks({ startMin: 8 * 60, endMin: 11 * 60 })).toEqual([480, 540, 600, 660]);
  });

  it("starts at the first whole hour inside a part-hour window", () => {
    expect(hourMarks({ startMin: 8 * 60 + 20, endMin: 10 * 60 })[0]).toBe(9 * 60);
  });

  it("labels minutes as a 24-hour clock", () => {
    expect(labelMinutes(9 * 60)).toBe("09:00");
    expect(labelMinutes(13 * 60 + 45)).toBe("13:45");
    expect(labelMinutes(0)).toBe("00:00");
  });
});

describe("diaryColumns", () => {
  const prac = [
    { id: "p1", name: "Dana Hale" },
    { id: "p2", name: "Femi Osei" },
  ];

  it("keeps a column for a clinician with nothing booked", () => {
    const cols = diaryColumns(prac, [{ practitionerId: "p1", practitioner: "Dana Hale" }]);
    expect(cols.map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("adds no unassigned column when every appointment has a clinician", () => {
    const cols = diaryColumns(prac, [{ practitionerId: "p1", practitioner: "Dana Hale" }]);
    expect(cols.some((c) => c.id === null)).toBe(false);
  });

  it("adds an unassigned column, last, when something has no clinician", () => {
    const cols = diaryColumns(prac, [{ practitionerId: null, practitioner: null }]);
    expect(cols[cols.length - 1]).toEqual({ id: null, name: "Unassigned" });
  });

  it("gives a locum not in the active list their own column rather than losing them", () => {
    const cols = diaryColumns(prac, [{ practitionerId: "p9", practitioner: "Dr Locum" }]);
    expect(cols.map((c) => c.name)).toContain("Dr Locum");
  });

  it("does not duplicate a locum booked several times", () => {
    const cols = diaryColumns(prac, [
      { practitionerId: "p9", practitioner: "Dr Locum" },
      { practitionerId: "p9", practitioner: "Dr Locum" },
    ]);
    expect(cols.filter((c) => c.id === "p9")).toHaveLength(1);
  });

  it("names an unknown clinician sensibly when the name is missing too", () => {
    const cols = diaryColumns(prac, [{ practitionerId: "p9", practitioner: null }]);
    expect(cols.find((c) => c.id === "p9")?.name).toBe("Other clinician");
  });
});
