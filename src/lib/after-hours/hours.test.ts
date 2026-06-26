import { describe, it, expect } from "vitest";
import { isOutsideHours } from "./hours";
import type { OpeningHours, Site } from "@/lib/types";

const HOURS: OpeningHours = {
  monday: "09:00-17:30",
  tuesday: "09:00-17:30",
  wednesday: "09:00-17:30",
  thursday: "09:00-17:30",
  friday: "09:00-17:30",
  saturday: "09:00-13:00",
  sunday: null,
};

function site(over?: Partial<Site>): Site {
  return {
    id: "site-cc",
    clientId: "vitality",
    name: "City Centre",
    timezone: "Europe/London",
    openingHours: HOURS,
    ...over,
  };
}

// June 2026 is British Summer Time (UTC+1), so local = UTC + 1h.
// 2026-06-25 is a Thursday; 2026-06-27 is a Saturday; 2026-06-28 is a Sunday.

describe("isOutsideHours", () => {
  it("is inside hours during a weekday window", () => {
    // Thu 11:00 BST = 10:00 UTC.
    expect(isOutsideHours(site(), new Date("2026-06-25T10:00:00Z"))).toBe(false);
  });

  it("is outside hours before open", () => {
    // Thu 08:30 BST = 07:30 UTC, before 09:00 open.
    expect(isOutsideHours(site(), new Date("2026-06-25T07:30:00Z"))).toBe(true);
  });

  it("is outside hours after close", () => {
    // Thu 18:00 BST = 17:00 UTC, after 17:30 close.
    expect(isOutsideHours(site(), new Date("2026-06-25T17:00:00Z"))).toBe(true);
  });

  it("treats the closing minute as already closed", () => {
    // Thu 17:30 BST = 16:30 UTC, exactly at close.
    expect(isOutsideHours(site(), new Date("2026-06-25T16:30:00Z"))).toBe(true);
  });

  it("is outside hours all day on a closed Sunday", () => {
    // Sun 12:00 BST = 11:00 UTC, but Sunday is null (closed).
    expect(isOutsideHours(site(), new Date("2026-06-28T11:00:00Z"))).toBe(true);
  });

  it("respects the Saturday half-day window", () => {
    // Sat 10:00 BST = 09:00 UTC, inside the 09:00-13:00 Saturday window.
    expect(isOutsideHours(site(), new Date("2026-06-27T09:00:00Z"))).toBe(false);
    // Sat 14:00 BST = 13:00 UTC, after the 13:00 Saturday close.
    expect(isOutsideHours(site(), new Date("2026-06-27T13:00:00Z"))).toBe(true);
  });

  it("treats a site with no opening-hours config as always outside hours", () => {
    expect(isOutsideHours(site({ openingHours: undefined }), new Date("2026-06-25T10:00:00Z"))).toBe(true);
  });

  it("treats a missing site as outside hours", () => {
    expect(isOutsideHours(undefined, new Date("2026-06-25T10:00:00Z"))).toBe(true);
  });
});
