import { describe, it, expect } from "vitest";
import {
  londonDayKey,
  isSameLondonDay,
  isLondonToday,
  isLondonTomorrow,
  londonOverdueDays,
  londonDateTimeLabel,
  londonDateTimeLabelWithYear,
} from "./london";

describe("londonDayKey", () => {
  it("rolls into the next day for a late-evening summer instant (BST = UTC+1)", () => {
    // 23:30Z in summer is 00:30 the next morning in London.
    expect(londonDayKey(new Date("2026-06-27T23:30:00Z"))).toBe("2026-06-28");
  });

  it("stays on the same day for an early-morning winter instant (GMT = UTC+0)", () => {
    expect(londonDayKey(new Date("2026-01-15T00:30:00Z"))).toBe("2026-01-15");
  });

  it("matches UTC midday in both seasons", () => {
    expect(londonDayKey(new Date("2026-06-27T12:00:00Z"))).toBe("2026-06-27");
    expect(londonDayKey(new Date("2026-01-15T12:00:00Z"))).toBe("2026-01-15");
  });
});

describe("isSameLondonDay", () => {
  it("treats a summer instant either side of UTC midnight as the same London day", () => {
    // 23:30Z and 00:30Z (next UTC day) are both 2026-06-28 in BST.
    const a = new Date("2026-06-27T23:30:00Z");
    const b = new Date("2026-06-28T00:30:00Z");
    expect(londonDayKey(a)).toBe("2026-06-28");
    expect(londonDayKey(b)).toBe("2026-06-28");
    expect(isSameLondonDay(a, b)).toBe(true);
  });

  it("returns false across a London day boundary", () => {
    const a = new Date("2026-06-27T22:00:00Z"); // 23:00 London, 27th
    const b = new Date("2026-06-27T23:30:00Z"); // 00:30 London, 28th
    expect(isSameLondonDay(a, b)).toBe(false);
  });
});

describe("isLondonToday / isLondonTomorrow", () => {
  // now = 00:30 London on the 28th (BST).
  const now = new Date("2026-06-27T23:30:00Z");

  it("classifies an instant on the same London day as today", () => {
    expect(isLondonToday("2026-06-28T08:00:00Z", now)).toBe(true);
    expect(isLondonTomorrow("2026-06-28T08:00:00Z", now)).toBe(false);
  });

  it("classifies an instant on the next London day as tomorrow", () => {
    expect(isLondonTomorrow("2026-06-29T08:00:00Z", now)).toBe(true);
    expect(isLondonToday("2026-06-29T08:00:00Z", now)).toBe(false);
  });
});

describe("londonOverdueDays", () => {
  // now = 00:30 London on 2026-06-28 (BST). An instant just before UTC midnight
  // must still resolve against the London day, not the UTC day.
  const now = new Date("2026-06-27T23:30:00Z");

  it("is 0 when due on the same London day", () => {
    expect(londonOverdueDays("2026-06-28T09:00:00Z", now)).toBe(0);
  });

  it("is 1 when due on the previous London day (yesterday)", () => {
    expect(londonOverdueDays("2026-06-27T09:00:00Z", now)).toBe(1);
  });

  it("is -1 when due on the next London day (tomorrow)", () => {
    expect(londonOverdueDays("2026-06-29T09:00:00Z", now)).toBe(-1);
  });

  it("returns a whole-day delta regardless of the wall-clock time of day", () => {
    // Due late on the 25th vs now early on the 28th = 3 London days.
    expect(londonOverdueDays("2026-06-25T22:00:00Z", now)).toBe(3);
  });

  it("fails safe to -Infinity for an unparseable date", () => {
    expect(londonOverdueDays("not-a-date", now)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("londonDateTimeLabel", () => {
  it("renders the London wall-clock time in summer (BST)", () => {
    // 08:00Z in summer is 09:00 London.
    expect(londonDateTimeLabel("2026-06-28T08:00:00Z")).toContain("09:00");
  });

  it("guards an unparseable instant to 'soon'", () => {
    expect(londonDateTimeLabel("not-a-date")).toBe("soon");
  });

  it("omits the year, which the with-year variant carries", () => {
    expect(londonDateTimeLabel("2019-09-17T11:00:00Z")).not.toContain("2019");
  });
});

describe("londonDateTimeLabelWithYear", () => {
  it("includes the year, so a historical appointment cannot read as this year", () => {
    const label = londonDateTimeLabelWithYear("2019-09-17T11:00:00Z");
    expect(label).toContain("2019");
    // Still the London wall-clock time (BST in September, UTC+1).
    expect(label).toContain("12:00");
  });

  it("guards an unparseable instant to 'soon'", () => {
    expect(londonDateTimeLabelWithYear("not-a-date")).toBe("soon");
  });
});
