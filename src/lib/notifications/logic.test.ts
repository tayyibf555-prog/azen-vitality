import { describe, it, expect } from "vitest";
import { orderNotifications, countByType, URGENCY_RANK } from "./logic";
import type { NotificationItem } from "./types";

function item(p: Partial<NotificationItem> & { id: string }): NotificationItem {
  return {
    type: "compliance",
    urgency: "medium",
    title: "t",
    detail: "d",
    at: "2026-06-01T00:00:00.000Z",
    ...p,
  };
}

describe("orderNotifications", () => {
  it("sorts by urgency (high first), then most recent within an urgency", () => {
    const out = orderNotifications([
      item({ id: "a", urgency: "low", at: "2026-06-10T00:00:00.000Z" }),
      item({ id: "b", urgency: "high", at: "2026-06-01T00:00:00.000Z" }),
      item({ id: "c", urgency: "high", at: "2026-06-05T00:00:00.000Z" }),
      item({ id: "d", urgency: "medium", at: "2026-06-02T00:00:00.000Z" }),
    ]);
    // high (newest first): c, b; then medium: d; then low: a
    expect(out.map((i) => i.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("dedupes by stable id, keeping the first occurrence", () => {
    const out = orderNotifications([
      item({ id: "x", title: "first", urgency: "high" }),
      item({ id: "x", title: "second", urgency: "high" }),
      item({ id: "y", urgency: "low" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((i) => i.id === "x")?.title).toBe("first");
  });

  it("is deterministic and does not mutate the input", () => {
    const input = [
      item({ id: "a", urgency: "medium", at: "2026-06-03T00:00:00.000Z" }),
      item({ id: "b", urgency: "high", at: "2026-06-01T00:00:00.000Z" }),
    ];
    const snapshot = input.map((i) => i.id);
    const first = orderNotifications(input).map((i) => i.id);
    const second = orderNotifications(input).map((i) => i.id);
    expect(first).toEqual(second);
    expect(first).toEqual(["b", "a"]);
    expect(input.map((i) => i.id)).toEqual(snapshot); // input untouched
  });

  it("sorts an unparseable `at` last within its urgency band", () => {
    const out = orderNotifications([
      item({ id: "good", urgency: "high", at: "2026-06-01T00:00:00.000Z" }),
      item({ id: "bad", urgency: "high", at: "not-a-date" }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["good", "bad"]);
  });

  it("returns an empty array for no items", () => {
    expect(orderNotifications([])).toEqual([]);
  });
});

describe("URGENCY_RANK", () => {
  it("ranks high above medium above low", () => {
    expect(URGENCY_RANK.high).toBeLessThan(URGENCY_RANK.medium);
    expect(URGENCY_RANK.medium).toBeLessThan(URGENCY_RANK.low);
  });
});

describe("countByType", () => {
  it("counts items per type", () => {
    const counts = countByType([
      item({ id: "1", type: "compliance" }),
      item({ id: "2", type: "compliance" }),
      item({ id: "3", type: "no_show" }),
      item({ id: "4", type: "lead" }),
    ]);
    expect(counts).toEqual({ compliance: 2, no_show: 1, lead: 1 });
  });
});
