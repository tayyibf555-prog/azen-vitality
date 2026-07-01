import { describe, it, expect } from "vitest";
import { draftShiftMessage, type ShiftLine } from "./draft";

const SHIFTS: ShiftLine[] = [
  { date: "2026-07-06", start: "09:00", end: "17:30", siteName: "City Centre" },
  { date: "2026-07-07", start: "09:00", end: "17:30", siteName: "Riverside" },
];

describe("draftShiftMessage", () => {
  it("greets by first name and lists each shift with day, times and site", () => {
    const msg = draftShiftMessage("Sam Jones", "Vitality Dental", SHIFTS);
    expect(msg).toContain("Hi Sam,");
    expect(msg).toContain("Vitality Dental");
    expect(msg).toContain("Mon 6 Jul 09:00 to 17:30 City Centre");
    expect(msg).toContain("Tue 7 Jul 09:00 to 17:30 Riverside");
  });

  it("uses British English and never uses a dash character", () => {
    const msg = draftShiftMessage("Sam Jones", "Vitality Dental", SHIFTS);
    expect(msg).not.toContain("-");
    expect(msg).not.toContain("—"); // em dash
    expect(msg).not.toContain("–"); // en dash
    // "to" instead of a dash between times.
    expect(msg).toContain("09:00 to 17:30");
  });

  it("never mentions NHS or private funding framing", () => {
    const msg = draftShiftMessage("Sam Jones", "Vitality Dental", SHIFTS);
    expect(msg.toLowerCase()).not.toContain("nhs");
    expect(msg.toLowerCase()).not.toContain("private");
  });

  it("falls back to a friendly greeting when the name is blank", () => {
    const msg = draftShiftMessage("   ", "Vitality Dental", SHIFTS);
    expect(msg).toContain("Hi there,");
  });

  it("returns a no-shifts note (never an empty body) when there are none", () => {
    const msg = draftShiftMessage("Sam Jones", "Vitality Dental", []);
    expect(msg).toContain("no shifts scheduled");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("-");
  });

  it("stays compact for a typical week of shifts", () => {
    const week: ShiftLine[] = [
      { date: "2026-07-06", start: "09:00", end: "17:30", siteName: "City Centre" },
      { date: "2026-07-08", start: "09:00", end: "17:30", siteName: "City Centre" },
      { date: "2026-07-10", start: "09:00", end: "17:30", siteName: "Riverside" },
    ];
    const msg = draftShiftMessage("Amelia Clarke", "Vitality Dental", week);
    // Single block, no hard newlines -> renders as a tidy SMS.
    expect(msg.split("\n")).toHaveLength(1);
  });
});
