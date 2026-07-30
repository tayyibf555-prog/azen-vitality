import { describe, expect, it } from "vitest";

import {
  DASHBOARD_PERIODS,
  PERIOD_LABELS,
  coversWindow,
  dayKeyDiff,
  daysInWindow,
  isDayInWindow,
  isDayKey,
  londonDayOfIso,
  londonToday,
  periodWindow,
  shiftDayKey,
  windowLength,
} from "@/lib/dashboard/period";

describe("isDayKey", () => {
  it("accepts a real YYYY-MM-DD", () => {
    expect(isDayKey("2026-07-30")).toBe(true);
    expect(isDayKey("2024-02-29")).toBe(true);
  });

  it("rejects malformed or impossible dates", () => {
    for (const bad of ["2026-02-31", "2026-13-01", "26-07-30", "2026-7-30", "2026-07-30T00:00:00Z", "", null, 20260730]) {
      expect(isDayKey(bad), `expected ${String(bad)} to be rejected`).toBe(false);
    }
  });
});

describe("shiftDayKey", () => {
  it("shifts across month and year ends", () => {
    expect(shiftDayKey("2026-07-30", 1)).toBe("2026-07-31");
    expect(shiftDayKey("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftDayKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("shifts across the BST boundary without losing a day", () => {
    // Clocks go forward on 2026-03-29 and back on 2026-10-25.
    expect(shiftDayKey("2026-03-28", 1)).toBe("2026-03-29");
    expect(shiftDayKey("2026-03-29", 1)).toBe("2026-03-30");
    expect(shiftDayKey("2026-10-24", 1)).toBe("2026-10-25");
    expect(shiftDayKey("2026-10-25", 1)).toBe("2026-10-26");
  });

  it("returns null for a malformed key", () => {
    expect(shiftDayKey("not-a-day", 1)).toBeNull();
  });
});

describe("dayKeyDiff", () => {
  it("counts whole days in both directions", () => {
    expect(dayKeyDiff("2026-07-01", "2026-07-30")).toBe(29);
    expect(dayKeyDiff("2026-07-30", "2026-07-01")).toBe(-29);
    expect(dayKeyDiff("2026-07-30", "2026-07-30")).toBe(0);
  });

  it("counts a whole BST-to-GMT span correctly", () => {
    expect(dayKeyDiff("2026-10-24", "2026-10-26")).toBe(2);
  });

  it("returns null for a malformed key", () => {
    expect(dayKeyDiff("2026-07-30", "rubbish")).toBeNull();
  });
});

describe("londonToday and londonDayOfIso", () => {
  it("uses the London day, not the UTC day, late in a BST evening", () => {
    // 2026-07-30 23:30 London is 22:30 UTC: same day either way.
    expect(londonToday(new Date("2026-07-30T22:30:00Z"))).toBe("2026-07-30");
    // 2026-07-31 00:30 London is 2026-07-30 23:30 UTC: a UTC slice would say the 30th.
    const justAfterLondonMidnight = new Date("2026-07-30T23:30:00Z");
    expect(londonToday(justAfterLondonMidnight)).toBe("2026-07-31");
    expect(justAfterLondonMidnight.toISOString().slice(0, 10)).toBe("2026-07-30");
  });

  it("buckets an appointment instant on its London day", () => {
    expect(londonDayOfIso("2026-07-30T23:30:00Z")).toBe("2026-07-31");
    expect(londonDayOfIso("2026-01-15T23:30:00Z")).toBe("2026-01-15");
  });

  it("returns null for an unparseable instant", () => {
    expect(londonDayOfIso("not a date")).toBeNull();
    expect(londonDayOfIso(null)).toBeNull();
    expect(londonDayOfIso(undefined)).toBeNull();
    expect(londonDayOfIso(12345)).toBeNull();
  });
});

describe("periodWindow", () => {
  const now = new Date("2026-07-30T09:00:00Z");

  it("gives the five windows the strip shows", () => {
    expect(periodWindow("today", now)).toEqual({ from: "2026-07-30", to: "2026-07-30" });
    expect(periodWindow("yesterday", now)).toEqual({ from: "2026-07-29", to: "2026-07-29" });
    expect(periodWindow("last7", now)).toEqual({ from: "2026-07-24", to: "2026-07-30" });
    expect(periodWindow("last30", now)).toEqual({ from: "2026-07-01", to: "2026-07-30" });
    expect(periodWindow("last90", now)).toEqual({ from: "2026-05-02", to: "2026-07-30" });
  });

  it("makes each window the length its label promises", () => {
    expect(windowLength(periodWindow("today", now))).toBe(1);
    expect(windowLength(periodWindow("yesterday", now))).toBe(1);
    expect(windowLength(periodWindow("last7", now))).toBe(7);
    expect(windowLength(periodWindow("last30", now))).toBe(30);
    expect(windowLength(periodWindow("last90", now))).toBe(90);
  });

  it("rolls over at London midnight, not UTC midnight", () => {
    const lateBst = new Date("2026-07-30T23:30:00Z"); // 00:30 on the 31st in London
    expect(periodWindow("today", lateBst)).toEqual({ from: "2026-07-31", to: "2026-07-31" });
    expect(periodWindow("yesterday", lateBst)).toEqual({ from: "2026-07-30", to: "2026-07-30" });
  });

  it("labels every period", () => {
    for (const p of DASHBOARD_PERIODS) expect(PERIOD_LABELS[p].length).toBeGreaterThan(0);
    expect(DASHBOARD_PERIODS).toEqual(["today", "yesterday", "last7", "last30", "last90"]);
  });
});

describe("isDayInWindow and daysInWindow", () => {
  const w = { from: "2026-07-24", to: "2026-07-30" };

  it("is inclusive at both ends", () => {
    expect(isDayInWindow("2026-07-24", w)).toBe(true);
    expect(isDayInWindow("2026-07-30", w)).toBe(true);
    expect(isDayInWindow("2026-07-23", w)).toBe(false);
    expect(isDayInWindow("2026-07-31", w)).toBe(false);
  });

  it("enumerates every day, oldest first", () => {
    expect(daysInWindow(w)).toEqual([
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
    ]);
  });

  it("enumerates nothing for a reversed window", () => {
    expect(daysInWindow({ from: "2026-07-30", to: "2026-07-24" })).toEqual([]);
  });
});

describe("coversWindow", () => {
  const w = { from: "2026-07-24", to: "2026-07-30" };

  it("is true only when the coverage contains the whole window", () => {
    expect(coversWindow({ from: "2026-07-24", to: "2026-07-30" }, w)).toBe(true);
    expect(coversWindow({ from: "2026-01-01", to: "2026-12-31" }, w)).toBe(true);
    expect(coversWindow({ from: "2026-07-25", to: "2026-07-30" }, w)).toBe(false);
    expect(coversWindow({ from: "2026-07-24", to: "2026-07-29" }, w)).toBe(false);
  });

  it("treats absent or malformed coverage as covering nothing", () => {
    expect(coversWindow(null, w)).toBe(false);
    expect(coversWindow(undefined, w)).toBe(false);
    expect(coversWindow({ from: "rubbish", to: "2026-07-30" }, w)).toBe(false);
  });
});
