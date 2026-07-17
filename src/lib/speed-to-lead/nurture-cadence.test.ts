import { describe, it, expect } from "vitest";
import {
  nurtureNextAt,
  isNurtureComplete,
  daysBefore,
  NURTURE_MAX_TOUCHES,
} from "./nurture-cadence";

// Pure nurture cadence maths: the three touches must land on days 3, 10 and 21 from
// the first contact (intervals 3, 7, 11), and the cadence must terminate after three.

const FROM = "2026-01-01T00:00:00.000Z";

describe("nurture cadence maths", () => {
  it("schedules the entry touch 3 days after first contact", () => {
    expect(nurtureNextAt(0, FROM)).toBe("2026-01-04T00:00:00.000Z");
  });

  it("lands touches on days 3, 10 and 21 when each is sent on schedule", () => {
    // Touch 1 due at day 3.
    const t1 = nurtureNextAt(0, FROM);
    expect(t1).toBe("2026-01-04T00:00:00.000Z");
    // Sent on day 3 -> touch 2 due 7 days later (day 10).
    const t2 = nurtureNextAt(1, t1!);
    expect(t2).toBe("2026-01-11T00:00:00.000Z");
    // Sent on day 10 -> touch 3 due 11 days later (day 21).
    const t3 = nurtureNextAt(2, t2!);
    expect(t3).toBe("2026-01-22T00:00:00.000Z");
  });

  it("terminates after the final touch", () => {
    expect(nurtureNextAt(NURTURE_MAX_TOUCHES, FROM)).toBeNull();
    expect(nurtureNextAt(3, FROM)).toBeNull();
    expect(isNurtureComplete(2)).toBe(false);
    expect(isNurtureComplete(3)).toBe(true);
  });

  it("rejects a negative or unparseable input", () => {
    expect(nurtureNextAt(-1, FROM)).toBeNull();
    expect(nurtureNextAt(0, "not-a-date")).toBeNull();
  });

  it("daysBefore computes the cutoff instants", () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    expect(daysBefore(now, 3)).toBe("2026-02-26T12:00:00.000Z");
    expect(daysBefore(now, 60)).toBe("2025-12-31T12:00:00.000Z");
  });
});
