import { describe, it, expect } from "vitest";
import {
  MAX_PINNED_PER_PATIENT,
  moreLabel,
  orderPinned,
  planPinnedBand,
  splitPinnedBand,
} from "./pin-layout";

const note = (id: string, pinnedAt: string | null) => ({ id, pinnedAt });

describe("planPinnedBand", () => {
  it("renders no band at all at zero, which is the commonest case", () => {
    const plan = planPinnedBand(0, { expanded: false });
    expect(plan.visible).toBe(0);
    expect(plan.hidden).toBe(0);
  });

  it("gives one note a single full-width card at three lines", () => {
    expect(planPinnedBand(1, { expanded: false })).toEqual({
      visible: 1,
      hidden: 0,
      clampLines: 3,
      columns: 1,
    });
  });

  it("keeps three notes on one row at three lines", () => {
    expect(planPinnedBand(3, { expanded: false })).toEqual({
      visible: 3,
      hidden: 0,
      clampLines: 3,
      columns: 3,
    });
  });

  it("drops to two lines once the band needs a second row", () => {
    const plan = planPinnedBand(6, { expanded: false });
    expect(plan.visible).toBe(6);
    expect(plan.hidden).toBe(0);
    expect(plan.clampLines).toBe(2);
  });

  it("caps a collapsed band at two rows and puts the rest behind a control", () => {
    // Ten is the case the reference falls apart on.
    const plan = planPinnedBand(10, { expanded: false });
    expect(plan.visible).toBe(6);
    expect(plan.hidden).toBe(4);
    expect(plan.clampLines).toBe(2);
  });

  it("shows everything once expanded, with nothing left hidden", () => {
    const plan = planPinnedBand(10, { expanded: true });
    expect(plan.visible).toBe(10);
    expect(plan.hidden).toBe(0);
  });

  it("still degrades at the server cap of twelve", () => {
    expect(MAX_PINNED_PER_PATIENT).toBe(12);
    const collapsed = planPinnedBand(MAX_PINNED_PER_PATIENT, { expanded: false });
    expect(collapsed.visible).toBe(6);
    expect(collapsed.hidden).toBe(6);
    expect(planPinnedBand(MAX_PINNED_PER_PATIENT, { expanded: true }).visible).toBe(12);
  });

  it("treats a nonsense count as no band rather than rendering one", () => {
    expect(planPinnedBand(-3, { expanded: false }).visible).toBe(0);
    expect(planPinnedBand(Number.NaN, { expanded: false }).visible).toBe(0);
  });
});

describe("orderPinned", () => {
  it("puts the most recently pinned first", () => {
    const ordered = orderPinned([
      note("old", "2026-01-01T09:00:00Z"),
      note("new", "2026-07-01T09:00:00Z"),
      note("mid", "2026-04-01T09:00:00Z"),
    ]);
    expect(ordered.map((n) => n.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts unpinned and unparseable rows last instead of throwing", () => {
    const ordered = orderPinned([
      note("junk", "not a date"),
      note("unpinned", null),
      note("real", "2026-07-01T09:00:00Z"),
    ]);
    expect(ordered[0].id).toBe("real");
  });

  it("does not mutate its input", () => {
    const input = [note("a", "2026-01-01T09:00:00Z"), note("b", "2026-07-01T09:00:00Z")];
    orderPinned(input);
    expect(input.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("splitPinnedBand", () => {
  it("never hides the note that was pinned most recently", () => {
    // Ten notes, deliberately shuffled, with the newest pin in the middle of the array.
    const notes = [
      note("p1", "2026-01-01T09:00:00Z"),
      note("p2", "2026-01-02T09:00:00Z"),
      note("p3", "2026-01-03T09:00:00Z"),
      note("p4", "2026-01-04T09:00:00Z"),
      note("newest", "2026-07-30T09:00:00Z"),
      note("p5", "2026-01-05T09:00:00Z"),
      note("p6", "2026-01-06T09:00:00Z"),
      note("p7", "2026-01-07T09:00:00Z"),
      note("p8", "2026-01-08T09:00:00Z"),
      note("p9", "2026-01-09T09:00:00Z"),
    ];
    const { shown, rest, plan } = splitPinnedBand(notes, { expanded: false });
    expect(shown).toHaveLength(6);
    expect(rest).toHaveLength(4);
    expect(plan.hidden).toBe(4);
    expect(shown[0].id).toBe("newest");
    expect(rest.map((n) => n.id)).not.toContain("newest");
  });

  it("shows every note and hides none when expanded", () => {
    const notes = Array.from({ length: 9 }, (_, i) =>
      note(`n${i}`, `2026-0${(i % 9) + 1}-01T09:00:00Z`),
    );
    const { shown, rest } = splitPinnedBand(notes, { expanded: true });
    expect(shown).toHaveLength(9);
    expect(rest).toHaveLength(0);
  });

  it("returns nothing to render for an empty list", () => {
    const { shown, rest, plan } = splitPinnedBand([], { expanded: false });
    expect(shown).toHaveLength(0);
    expect(rest).toHaveLength(0);
    expect(plan.visible).toBe(0);
  });
});

describe("moreLabel", () => {
  it("reads as prose in both numbers", () => {
    expect(moreLabel(1)).toBe("1 more pinned note");
    expect(moreLabel(4)).toBe("4 more pinned notes");
  });
});
