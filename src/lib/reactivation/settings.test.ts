// londonDayStartIso must be DST-correct: "today" for the daily contact cap is the
// Europe/London calendar day, so the boundary is 23:00 UTC in summer (BST) and
// 00:00 UTC in winter (GMT). Getting this wrong under- or over-counts the budget
// around midnight.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  serviceClient: () => {
    throw new Error("not used in this test");
  },
}));

import { londonDayStartIso } from "./settings";

describe("londonDayStartIso", () => {
  it("BST (summer): London midnight is 23:00 UTC the previous day", () => {
    expect(londonDayStartIso(new Date("2026-07-09T12:00:00Z"))).toBe("2026-07-08T23:00:00.000Z");
  });

  it("GMT (winter): London midnight equals UTC midnight", () => {
    expect(londonDayStartIso(new Date("2026-01-15T12:00:00Z"))).toBe("2026-01-15T00:00:00.000Z");
  });

  it("just after London midnight in summer counts as the NEW London day", () => {
    // 23:30 UTC on 8 Jul = 00:30 BST on 9 Jul -> day starts 23:00 UTC on 8 Jul.
    expect(londonDayStartIso(new Date("2026-07-08T23:30:00Z"))).toBe("2026-07-08T23:00:00.000Z");
  });

  it("just before London midnight in summer still counts as the OLD London day", () => {
    // 22:30 UTC on 8 Jul = 23:30 BST on 8 Jul -> day starts 23:00 UTC on 7 Jul.
    expect(londonDayStartIso(new Date("2026-07-08T22:30:00Z"))).toBe("2026-07-07T23:00:00.000Z");
  });
});
