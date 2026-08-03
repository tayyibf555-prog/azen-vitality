import { describe, it, expect } from "vitest";
import {
  presetWindow,
  customWindow,
  firstOfMonth,
  lastOfMonth,
  firstOfQuarter,
} from "./report-window";

// A fixed London day (mid-August 2026) so the windows are deterministic.
const NOW = new Date("2026-08-14T09:00:00Z");

describe("month/quarter helpers", () => {
  it("finds the first and last of a month, spanning year and leap boundaries", () => {
    expect(firstOfMonth("2026-08-14")).toBe("2026-08-01");
    expect(lastOfMonth("2026-08-14")).toBe("2026-08-31");
    expect(lastOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(lastOfMonth("2024-02-10")).toBe("2024-02-29"); // leap year
    expect(lastOfMonth("2026-12-01")).toBe("2026-12-31");
  });
  it("finds the first of the calendar quarter", () => {
    expect(firstOfQuarter("2026-08-14")).toBe("2026-07-01");
    expect(firstOfQuarter("2026-01-10")).toBe("2026-01-01");
    expect(firstOfQuarter("2026-12-31")).toBe("2026-10-01");
  });
});

describe("presetWindow", () => {
  it("this month runs from the 1st to today", () => {
    expect(presetWindow("this_month", NOW)).toEqual({ from: "2026-08-01", to: "2026-08-14" });
  });
  it("last month is the whole previous month", () => {
    expect(presetWindow("last_month", NOW)).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });
  it("last 7 and last 30 include today", () => {
    expect(presetWindow("last_7", NOW)).toEqual({ from: "2026-08-08", to: "2026-08-14" });
    expect(presetWindow("last_30", NOW)).toEqual({ from: "2026-07-16", to: "2026-08-14" });
  });
  it("this quarter runs from the quarter start to today", () => {
    expect(presetWindow("this_quarter", NOW)).toEqual({ from: "2026-07-01", to: "2026-08-14" });
  });
  it("contract year to date starts on 1 April", () => {
    expect(presetWindow("contract_ytd", NOW)).toEqual({ from: "2026-04-01", to: "2026-08-14" });
  });
});

describe("customWindow", () => {
  it("accepts a well-ordered pair of real day keys", () => {
    expect(customWindow("2026-08-01", "2026-08-31")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(customWindow("2026-08-01", "2026-08-01")).toEqual({ from: "2026-08-01", to: "2026-08-01" });
  });
  it("rejects a reversed range rather than silently widening to everything", () => {
    expect(customWindow("2026-08-31", "2026-08-01")).toBeNull();
  });
  it("rejects a malformed or impossible date", () => {
    expect(customWindow("2026-13-01", "2026-08-31")).toBeNull();
    expect(customWindow("not-a-date", "2026-08-31")).toBeNull();
    expect(customWindow(null, "2026-08-31")).toBeNull();
  });
});
