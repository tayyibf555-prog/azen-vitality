import { describe, expect, it } from "vitest";
import { COMPACT_RAIL_SEGMENTS, wantsCompactRail } from "@/lib/nav-rail";

const BASE = "/c/vitality";

describe("wantsCompactRail", () => {
  it("asks for the compact rail on an opted-in page", () => {
    expect(wantsCompactRail(`${BASE}/dashboard`, BASE)).toBe(true);
  });

  it("tolerates a trailing slash", () => {
    expect(wantsCompactRail(`${BASE}/dashboard/`, BASE)).toBe(true);
  });

  it("carries the choice into nested routes of an opted-in page", () => {
    expect(wantsCompactRail(`${BASE}/dashboard/anything`, BASE)).toBe(true);
  });

  it("leaves every other module on the full sidebar", () => {
    expect(wantsCompactRail(`${BASE}/patients`, BASE)).toBe(false);
    expect(wantsCompactRail(`${BASE}/calendar`, BASE)).toBe(false);
    expect(wantsCompactRail(BASE, BASE)).toBe(false);
    expect(wantsCompactRail(`${BASE}/`, BASE)).toBe(false);
  });

  it("does not match a segment that merely starts with the same letters", () => {
    expect(wantsCompactRail(`${BASE}/dashboards`, BASE)).toBe(false);
    expect(wantsCompactRail(`${BASE}/dashboard-archive`, BASE)).toBe(false);
  });

  it("ignores a path outside this client", () => {
    expect(wantsCompactRail("/owner/vitality/dashboard", BASE)).toBe(false);
    expect(wantsCompactRail(null, BASE)).toBe(false);
    expect(wantsCompactRail(undefined, BASE)).toBe(false);
  });

  it("keeps the opt-in list explicit", () => {
    expect([...COMPACT_RAIL_SEGMENTS]).toEqual(["dashboard"]);
  });
});
