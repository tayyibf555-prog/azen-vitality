// Server-side segment validation + read-back. Pure; no I/O.
import { describe, it, expect } from "vitest";
import { parseFilters, parseDailyCap, describeSegment } from "./validate";

describe("parseFilters", () => {
  it("accepts an empty object (the whole active base)", () => {
    const r = parseFilters({});
    expect(r).toEqual({ ok: true, filters: {} });
  });

  it("cleans and bounds the common filters", () => {
    const r = parseFilters({
      lastVisitAfter: "2023-01-01",
      lastVisitBefore: "2026-01-01",
      treatmentContains: ["Hygiene", "  ", "Scale"],
      excludeSeenSinceDays: 90,
      requiresMobile: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filters.treatmentContains).toEqual(["Hygiene", "Scale"]);
      expect(r.filters.excludeSeenSinceDays).toBe(90);
    }
  });

  it("rejects a non-array treatmentContains", () => {
    expect(parseFilters({ treatmentContains: "hygiene" })).toEqual({ ok: false, error: expect.stringContaining("treatmentContains") });
  });

  it("rejects an unparseable date", () => {
    expect(parseFilters({ lastVisitAfter: "not-a-date" }).ok).toBe(false);
  });

  it("rejects a reversed last-visit window", () => {
    expect(parseFilters({ lastVisitAfter: "2026-01-01", lastVisitBefore: "2023-01-01" }).ok).toBe(false);
  });

  it("accepts age bounds and gender", () => {
    const r = parseFilters({ ageMin: 25, ageMax: 35, gender: "Female" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filters).toMatchObject({ ageMin: 25, ageMax: 35, gender: "female" });
  });

  it("rejects a reversed age range", () => {
    expect(parseFilters({ ageMin: 40, ageMax: 30 }).ok).toBe(false);
  });

  it("rejects an out-of-range or non-integer age", () => {
    expect(parseFilters({ ageMin: -1 }).ok).toBe(false);
    expect(parseFilters({ ageMax: 200 }).ok).toBe(false);
    expect(parseFilters({ ageMin: 30.5 }).ok).toBe(false);
  });

  it("rejects an unknown gender", () => {
    expect(parseFilters({ gender: "nonbinary" }).ok).toBe(false);
  });
});

describe("parseDailyCap", () => {
  it("defaults when unset", () => {
    expect(parseDailyCap(undefined)).toEqual({ ok: true, dailyCap: 25 });
  });
  it("accepts an in-range integer", () => {
    expect(parseDailyCap(50)).toEqual({ ok: true, dailyCap: 50 });
  });
  it("rejects out of range and non-integers", () => {
    expect(parseDailyCap(0).ok).toBe(false);
    expect(parseDailyCap(101).ok).toBe(false);
    expect(parseDailyCap(2.5).ok).toBe(false);
  });
});

describe("describeSegment", () => {
  it("reads back demographics with the missing-data note", () => {
    const s = describeSegment({ gender: "female", ageMin: 25, ageMax: 35, treatmentContains: ["hygiene"] });
    expect(s).toContain("female patients");
    expect(s).toContain("aged 25 to 35");
    expect(s).toContain('"hygiene"');
    expect(s).toContain("no recorded age or gender");
  });

  it("omits the missing-data note when no demographic filter is used", () => {
    const s = describeSegment({ treatmentContains: ["hygiene"] });
    expect(s).not.toContain("no recorded age or gender");
  });
});
