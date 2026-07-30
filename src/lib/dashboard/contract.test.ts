import { describe, expect, it } from "vitest";
import { parseUdaTargets, udaTargetForScope } from "@/lib/dashboard/contract";

describe("parseUdaTargets", () => {
  it("reads a per site list", () => {
    expect(parseUdaTargets("site-cc=24000,site-rv=15500")).toEqual({
      "site-cc": 24000,
      "site-rv": 15500,
    });
  });

  it("tolerates spacing", () => {
    expect(parseUdaTargets(" site-cc = 100 , site-rv=200 ")).toEqual({
      "site-cc": 100,
      "site-rv": 200,
    });
  });

  it("returns nothing when unset", () => {
    expect(parseUdaTargets(undefined)).toEqual({});
    expect(parseUdaTargets("")).toEqual({});
    expect(parseUdaTargets("   ")).toEqual({});
  });

  it("skips a malformed entry rather than coercing it to zero", () => {
    // A zero target would make the practice read as infinitely behind.
    expect(parseUdaTargets("site-cc=abc,site-rv=0,site-ng=-5,site-x=,=9,site-ok=10")).toEqual({
      "site-ok": 10,
    });
  });
});

describe("udaTargetForScope", () => {
  const targets = { "site-cc": 24000, "site-rv": 15500, "site-ng": 9800 };

  it("sums the sites in scope", () => {
    expect(udaTargetForScope(targets, ["site-cc", "site-rv"])).toBe(39500);
  });

  it("returns one site's target", () => {
    expect(udaTargetForScope(targets, ["site-ng"])).toBe(9800);
  });

  it("is all or nothing: one unconfigured site blanks the whole scope", () => {
    // A group target built from three of four sites understates the denominator,
    // which flatters the progress line in the one direction that matters.
    expect(udaTargetForScope(targets, ["site-cc", "site-new"])).toBeNull();
  });

  it("has no target for an empty scope", () => {
    expect(udaTargetForScope(targets, [])).toBeNull();
  });
});
