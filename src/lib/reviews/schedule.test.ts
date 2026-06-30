import { describe, it, expect } from "vitest";
import { reviewSendAt, DEFAULT_REVIEW_SCHEDULE, type ReviewScheduleConfig } from "./schedule";

const HOUR = 3_600_000;

// July is BST (UTC+1), so a London local hour H is UTC H-1 in these fixtures.
describe("reviewSendAt", () => {
  it("sends delayHours later the same day when attended before the cutoff", () => {
    // 10:00 London (09:00Z in BST) is before the 15:00 cutoff -> +3h.
    const attended = new Date("2026-07-01T09:00:00.000Z");
    const out = new Date(reviewSendAt(attended));
    expect(out.getTime()).toBe(attended.getTime() + DEFAULT_REVIEW_SCHEDULE.delayHours * HOUR);
  });

  it("sends the next morning when attended at or after the cutoff", () => {
    // 16:00 London (15:00Z in BST) is past the 15:00 cutoff -> next morning 10:00 London.
    const attended = new Date("2026-07-01T15:00:00.000Z");
    const out = new Date(reviewSendAt(attended));
    // Next day, 10:00 London = 09:00Z in BST.
    expect(out.toISOString()).toBe("2026-07-02T09:00:00.000Z");
  });

  it("treats the cutoff hour itself as 'after' (defers to next morning)", () => {
    // Exactly 15:00 London (14:00Z BST) -> not strictly before cutoff -> next morning.
    const attended = new Date("2026-07-01T14:00:00.000Z");
    const out = new Date(reviewSendAt(attended));
    expect(out.toISOString()).toBe("2026-07-02T09:00:00.000Z");
  });

  it("computes the next-morning hour correctly across a winter (GMT) date", () => {
    // 16:00 London in January is 16:00Z (GMT). Past cutoff -> next morning 10:00 London = 10:00Z.
    const attended = new Date("2026-01-10T16:00:00.000Z");
    const out = new Date(reviewSendAt(attended));
    expect(out.toISOString()).toBe("2026-01-11T10:00:00.000Z");
  });

  it("honours a custom config", () => {
    const cfg: ReviewScheduleConfig = { delayHours: 2, cutoffHour: 12, morningHour: 9 };
    const attended = new Date("2026-07-01T08:00:00.000Z"); // 09:00 London, before 12:00 cutoff
    const out = new Date(reviewSendAt(attended, cfg));
    expect(out.getTime()).toBe(attended.getTime() + 2 * HOUR);
  });
});
