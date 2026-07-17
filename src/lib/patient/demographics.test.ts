// Pure demographic maths: age against the Europe/London calendar day (boundary days
// and leap years) and defensive gender normalisation. No I/O; `now` is passed in.
import { describe, it, expect } from "vitest";
import { ageFromDob, normaliseGender } from "./demographics";

// A fixed reference instant. 2026-07-17 in London (BST, +01:00).
const NOW = new Date("2026-07-17T09:00:00Z");

describe("ageFromDob", () => {
  it("returns null for a missing or unparseable DOB", () => {
    expect(ageFromDob(null, NOW)).toBeNull();
    expect(ageFromDob(undefined, NOW)).toBeNull();
    expect(ageFromDob("not-a-date", NOW)).toBeNull();
  });

  it("computes whole-years age for a plain date", () => {
    expect(ageFromDob("1990-01-01", NOW)).toBe(36);
    expect(ageFromDob("2000-07-17", NOW)).toBe(26); // birthday is today
  });

  it("does not count a birthday that has not arrived yet this year", () => {
    // Born 18 Jul: the day BEFORE the birthday, still one year younger.
    expect(ageFromDob("2000-07-18", NOW)).toBe(25);
  });

  it("counts the birthday itself and the day after", () => {
    expect(ageFromDob("2000-07-16", NOW)).toBe(26); // yesterday's birthday
    expect(ageFromDob("2000-07-17", NOW)).toBe(26); // today's birthday
  });

  it("handles a leap-year birthday on a non-leap reference day", () => {
    // Born 29 Feb 2000. On 28 Feb 2026 they have NOT yet turned 26; on 1 Mar they have.
    expect(ageFromDob("2000-02-29", new Date("2026-02-28T12:00:00Z"))).toBe(25);
    expect(ageFromDob("2000-02-29", new Date("2026-03-01T12:00:00Z"))).toBe(26);
  });

  it("uses the London calendar day at the UTC-midnight boundary", () => {
    // 22:30 UTC on 17 Jul is already 23:30 on 17 Jul in London (BST), so the London
    // day is still the 17th: a birthday of 18 Jul has NOT arrived.
    const lateUtc = new Date("2026-07-17T22:30:00Z");
    expect(ageFromDob("2000-07-18", lateUtc)).toBe(25);
  });

  it("returns null for a future date of birth", () => {
    expect(ageFromDob("2030-01-01", NOW)).toBeNull();
  });

  it("reads the date prefix of a full ISO datetime", () => {
    expect(ageFromDob("1980-07-17T00:00:00Z", NOW)).toBe(46);
  });
});

describe("normaliseGender", () => {
  it("maps common string forms", () => {
    expect(normaliseGender("Female")).toBe("female");
    expect(normaliseGender("male")).toBe("male");
    expect(normaliseGender("F")).toBe("female");
    expect(normaliseGender("m")).toBe("male");
  });

  it("maps ISO/IEC 5218 integer and numeric-string codes", () => {
    expect(normaliseGender(1)).toBe("male");
    expect(normaliseGender(2)).toBe("female");
    expect(normaliseGender("2")).toBe("female");
  });

  it("returns null for unknown, empty or missing values", () => {
    expect(normaliseGender("")).toBeNull();
    expect(normaliseGender("other")).toBeNull();
    expect(normaliseGender(null)).toBeNull();
    expect(normaliseGender(undefined)).toBeNull();
    expect(normaliseGender(0)).toBeNull();
  });
});
