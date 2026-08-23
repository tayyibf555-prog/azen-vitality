import { describe, expect, it } from "vitest";
import {
  dayBounds,
  diaryColumns,
  effectiveMinutes,
  hourMarks,
  labelMinutes,
  layoutColumn,
  londonMinutes,
  nowFraction,
  MAX_DRAWN_LANES,
} from "./diary-grid";

const appt = (start: string, durationMin = 30, finish: string | null = null) => ({
  start,
  finish,
  durationMin,
});

/** The same, in a state. 09:00 London is 08:00Z through BST. */
const at = (hhmm: string, durationMin = 30, state = "confirmed") => ({
  start: `2026-07-30T${hhmm}:00Z`,
  finish: null,
  durationMin,
  state,
});

/** "08:00" -> the London wall-minute it lands on in July (BST). */
const londonOf = (hhmm: string) => (Number(hhmm.slice(0, 2)) + 1) * 60 + Number(hhmm.slice(3, 5));

describe("londonMinutes", () => {
  it("reads the London wall clock, not UTC, through BST", () => {
    // 08:30 UTC in July is 09:30 in London. Getting this wrong draws every
    // appointment an hour high for seven months of the year.
    expect(londonMinutes("2026-07-30T08:30:00Z")).toBe(9 * 60 + 30);
  });

  it("agrees with UTC in winter", () => {
    expect(londonMinutes("2026-01-15T08:30:00Z")).toBe(8 * 60 + 30);
  });

  it("reports midnight as 0, never 1440", () => {
    expect(londonMinutes("2026-01-15T00:00:00Z")).toBe(0);
  });

  it("is NaN for an unparseable instant", () => {
    expect(Number.isNaN(londonMinutes("not a date"))).toBe(true);
  });
});

describe("effectiveMinutes", () => {
  it("prefers a sane finish time over the duration field", () => {
    expect(
      effectiveMinutes(appt("2026-07-30T09:00:00Z", 30, "2026-07-30T10:00:00Z")),
    ).toBe(60);
  });

  it("falls back to the duration when finish is absent", () => {
    expect(effectiveMinutes(appt("2026-07-30T09:00:00Z", 45))).toBe(45);
  });

  it("rejects a finish that precedes the start", () => {
    expect(
      effectiveMinutes(appt("2026-07-30T09:00:00Z", 30, "2026-07-30T08:00:00Z")),
    ).toBe(30);
  });

  it("rejects an overnight finish rather than drawing off the grid", () => {
    expect(
      effectiveMinutes(appt("2026-07-30T15:00:00Z", 30, "2026-07-31T09:00:00Z")),
    ).toBe(30);
  });

  it("uses 30 minutes when the duration is missing or zero", () => {
    expect(effectiveMinutes(appt("2026-07-30T09:00:00Z", 0))).toBe(30);
  });
});

describe("layoutColumn", () => {
  it("gives non-overlapping appointments the full width", () => {
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 30),
      appt("2026-07-30T09:00:00Z", 30),
    ]);
    expect(out.map((p) => p.lanes)).toEqual([1, 1]);
    expect(out.map((p) => p.lane)).toEqual([0, 0]);
  });

  it("treats back-to-back appointments as no clash", () => {
    // 09:00-09:30 then 09:30-10:00 touch but do not overlap.
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 30),
      appt("2026-07-30T08:30:00Z", 30),
    ]);
    expect(out.every((p) => p.lanes === 1)).toBe(true);
  });

  it("splits two genuinely overlapping appointments into two lanes", () => {
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 60),
      appt("2026-07-30T08:30:00Z", 30),
    ]);
    expect(out.map((p) => p.lanes)).toEqual([2, 2]);
    expect(out.map((p) => p.lane).sort()).toEqual([0, 1]);
  });

  it("counts lanes per cluster, so one clash does not narrow the whole day", () => {
    // A clash at 09:00, then two quiet afternoon appointments. The afternoon
    // must stay full width; counting lanes column-wide would halve everything.
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 60),
      appt("2026-07-30T08:30:00Z", 30),
      appt("2026-07-30T13:00:00Z", 30),
      appt("2026-07-30T14:00:00Z", 30),
    ]);
    const byStart = [...out].sort((a, b) => a.startMin - b.startMin);
    expect(byStart.map((p) => p.lanes)).toEqual([2, 2, 1, 1]);
  });

  it("returns to full width immediately after a clash ends", () => {
    // 09:00-10:00 double-booked, then a normal 10:00-10:30. The 10:00 block
    // starts exactly as the clash ends, so it belongs to a NEW cluster and must
    // be full width. Carrying the clash's lane count across the boundary would
    // leave every appointment after the day's first double-booking half width.
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 60),
      appt("2026-07-30T08:30:00Z", 30),
      appt("2026-07-30T09:00:00Z", 30),
    ]);
    const last = [...out].sort((a, b) => a.startMin - b.startMin)[2];
    expect(last.startMin).toBe(10 * 60);
    expect(last.lanes).toBe(1);
  });

  it("reuses a lane once its earlier appointment has ended", () => {
    // A long 09:00-11:00 block beside two consecutive half-hours: the short
    // pair share one lane rather than forcing a third.
    const out = layoutColumn([
      appt("2026-07-30T08:00:00Z", 120),
      appt("2026-07-30T08:00:00Z", 30),
      appt("2026-07-30T08:30:00Z", 30),
    ]);
    expect(out.every((p) => p.lanes === 2)).toBe(true);
  });

  it("drops appointments with an unparseable start rather than placing them at midnight", () => {
    const out = layoutColumn([appt("nonsense", 30), appt("2026-07-30T08:00:00Z", 30)]);
    expect(out).toHaveLength(1);
    expect(out[0].startMin).toBe(9 * 60);
  });

  it("positions a block by its London start and true length", () => {
    const [p] = layoutColumn([appt("2026-07-30T08:15:00Z", 30, "2026-07-30T09:00:00Z")]);
    expect(p.startMin).toBe(9 * 60 + 15);
    expect(p.endMin).toBe(10 * 60);
  });
});

// ===========================================================================
// THE SLIVERS.
//
// What the practice saw on 22 August 2026, beside Dentally's own diary: one
// clinician's day drawn as a picket fence of hair-thin vertical bars with no
// text on any of them. Measured off the screenshot, the column was 112px and
// the blocks in it were 28. Three causes, three sets below, and each of them is
// a rule that has to hold on its own.
// ===========================================================================
describe("a column of ordinary sequential bookings", () => {
  /** Sixteen back-to-back half hours, exactly what the busiest column held. */
  const SIXTEEN = Array.from({ length: 16 }, (_, i) =>
    at(`${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}`, 30),
  );

  it("gives every one of sixteen back-to-back bookings the WHOLE column", () => {
    const out = layoutColumn(SIXTEEN);
    expect(out).toHaveLength(16);
    // Every block in its own cluster, alone, full width. Not one of the three
    // failure modes: no shared denominator, no leftover span, no edge tab.
    expect(out.every((p) => p.lanes === 1)).toBe(true);
    expect(out.every((p) => p.lane === 0)).toBe(true);
    expect(out.every((p) => p.span === 1)).toBe(true);
    expect(out.every((p) => p.depth === 0)).toBe(true);
    expect(out.every((p) => p.strip === false)).toBe(true);
  });

  it("does not treat an appointment ending exactly as the next begins as a clash", () => {
    const out = layoutColumn([at("09:00", 30), at("09:30", 30), at("10:00", 30)]);
    expect(out.map((p) => p.lanes)).toEqual([1, 1, 1]);
  });

  it("splits only the two that are genuinely in the room at once", () => {
    const out = layoutColumn([at("09:00", 60), at("09:30", 30), at("11:00", 30)]);
    const byStart = [...out].sort((a, b) => a.startMin - b.startMin);
    expect(byStart.map((p) => p.lanes)).toEqual([2, 2, 1]);
    expect(byStart.map((p) => p.span)).toEqual([1, 1, 1]);
  });
});

describe("a block expands into the slots beside it that nothing occupies", () => {
  // THE RULE THAT WAS MISSING. A cluster is a chain, not a crowd: these four are
  // one connected run of three lanes, but at 11:00 there are only two
  // appointments in the room and at 11:30 there is one.
  const CHAIN = [
    at("08:00", 30), // 09:00-09:30  lane 0
    at("08:00", 30), // 09:00-09:30  lane 1   <- the genuine double booking
    at("08:15", 105), // 09:15-11:00 lane 2
    at("09:30", 30), // 10:30-11:00  lane 0 (reused)
  ];

  it("draws the block with nothing to its right at the full remaining width", () => {
    const out = layoutColumn(CHAIN);
    const late = out.find((p) => p.startMin === londonOf("09:30"));
    expect(late, "the 10:30 booking was not placed").toBeDefined();
    expect(late?.lanes).toBe(3);
    expect(late?.lane).toBe(0);
    // Lane 1 emptied at 09:30 and lane 2 is busy until 11:00, so it reaches
    // across two of the three slots. Before this rule it was drawn at a third of
    // a 112px column: 37px, of which 22 was padding.
    expect(late?.span).toBe(2);
  });

  it("still holds the genuinely simultaneous pair to one slot each", () => {
    const out = layoutColumn(CHAIN);
    const nine = out.filter((p) => p.startMin === londonOf("08:00"));
    expect(nine).toHaveLength(2);
    expect(nine.every((p) => p.span === 1)).toBe(true);
  });

  it("never lets a block reach past the cluster's own width", () => {
    for (const p of layoutColumn(CHAIN)) {
      expect(`${p.startMin}: ${p.lane + p.span <= p.lanes}`).toBe(`${p.startMin}: true`);
    }
  });
});

describe("a cancelled or missed booking never takes width off a patient", () => {
  it("demotes a cancellation that shares its hour with a real booking to the edge tab", () => {
    // Exactly what the practice's screenshot showed: a white dashed X block
    // holding a whole slot of the column beside the patients who were coming in.
    const out = layoutColumn([at("09:00", 30, "confirmed"), at("09:00", 30, "cancelled")]);
    const live = out.find((p) => p.item.state === "confirmed");
    const dead = out.find((p) => p.item.state === "cancelled");
    expect(live?.lanes).toBe(1);
    expect(live?.span).toBe(1);
    expect(live?.strip).toBe(false);
    expect(dead?.strip).toBe(true);
  });

  it("demotes a no-show the same way, because it consumed nothing either", () => {
    const out = layoutColumn([at("09:00", 30, "confirmed"), at("09:00", 30, "did_not_attend")]);
    expect(out.find((p) => p.item.state === "confirmed")?.lanes).toBe(1);
    expect(out.find((p) => p.item.state === "did_not_attend")?.strip).toBe(true);
  });

  it("keeps the full width for a cancellation in an hour nothing else uses", () => {
    // The one case where a dashed white block genuinely says "this hour is
    // free", which is the whole reason the diary draws cancellations at all.
    const out = layoutColumn([at("09:00", 30, "confirmed"), at("11:00", 30, "cancelled")]);
    const dead = out.find((p) => p.item.state === "cancelled");
    expect(dead?.strip).toBe(false);
    expect(dead?.lanes).toBe(1);
    expect(dead?.span).toBe(1);
  });

  it("still splits two cancellations that share the same free hour with each other", () => {
    const out = layoutColumn([at("11:00", 30, "cancelled"), at("11:00", 30, "cancelled")]);
    expect(out.every((p) => p.strip === false)).toBe(true);
    expect(out.map((p) => p.lanes)).toEqual([2, 2]);
  });

  it("counts a state it does not recognise as occupying, never as free", () => {
    // A state we cannot read is not evidence that a slot is free. It competes
    // for the width exactly as a confirmed booking does.
    const out = layoutColumn([at("09:00", 30, "confirmed"), at("09:00", 30, "rescheduled?")]);
    expect(out.every((p) => p.strip === false)).toBe(true);
    expect(out.every((p) => p.lanes === 2)).toBe(true);
  });

  it("loses nothing: every row that can be placed is still placed", () => {
    const rows = [
      at("09:00", 30, "confirmed"),
      at("09:00", 30, "cancelled"),
      at("09:00", 30, "did_not_attend"),
      at("10:00", 30, "cancelled"),
    ];
    expect(layoutColumn(rows)).toHaveLength(rows.length);
  });
});

// ===========================================================================
// ROUND 2, ITEM 1: THE PICKET FENCE.
//
// Round 1 gave every shadowed recoverable row its OWN 14px tab. On the owner's
// Saturday four of them touched inside one hour and what he saw at 12:00 was a
// fence of thin bars carrying X, X, DNA, X. Contiguous recoverables now share
// ONE tab carrying the count.
// ===========================================================================
describe("contiguous recoverables coalesce into one counted edge tab", () => {
  /** The owner's 12:00 hour: one live booking, four recoverable rows on top. */
  const PILE = [
    at("11:00", 60, "confirmed"),
    at("11:00", 15, "cancelled"),
    at("11:10", 20, "cancelled"),
    at("11:25", 20, "did_not_attend"),
    at("11:40", 20, "cancelled"),
  ];

  it("gives four touching cancellations ONE run, and one tab that paints it", () => {
    const tabs = layoutColumn(PILE).filter((p) => p.strip);
    expect(tabs).toHaveLength(4);
    expect(tabs.every((t) => t.stripRun?.count === 4)).toBe(true);
    // Exactly one of them paints: the rest are transparent hit targets.
    expect(tabs.filter((t) => t.stripRun?.index === 0)).toHaveLength(1);
  });

  it("draws that one tab over the whole run, 12:00 to 13:00", () => {
    const lead = layoutColumn(PILE).find((p) => p.stripRun?.index === 0);
    expect(lead?.stripRun?.startMin).toBe(londonOf("11:00"));
    expect(lead?.stripRun?.endMin).toBe(londonOf("12:00"));
  });

  it("sorts the painting tab BEFORE the rows it stands for", () => {
    // DOM order is paint order: the tab has to go down first or the transparent
    // hit targets end up underneath it and stop taking clicks.
    const tabs = layoutColumn(PILE).filter((p) => p.strip);
    expect(tabs.map((t) => t.stripRun?.index)).toEqual([0, 1, 2, 3]);
  });

  it("keeps every row: four ids in, four blocks out", () => {
    expect(layoutColumn(PILE)).toHaveLength(PILE.length);
    expect(layoutColumn(PILE).filter((p) => !p.strip)).toHaveLength(1);
  });

  it("joins two recoverables that merely TOUCH, because they already drew as one bar", () => {
    const out = layoutColumn([
      at("11:00", 60, "confirmed"),
      at("11:00", 15, "cancelled"),
      at("11:15", 15, "cancelled"),
    ]);
    expect(out.filter((p) => p.strip).every((p) => p.stripRun?.count === 2)).toBe(true);
  });

  it("starts a fresh run after a gap, so two hours are two tabs", () => {
    const out = layoutColumn([
      at("09:00", 480, "confirmed"),
      at("09:00", 15, "cancelled"),
      at("11:00", 15, "cancelled"),
      at("11:10", 15, "cancelled"),
    ]);
    const tabs = out.filter((p) => p.strip);
    expect(tabs.map((t) => t.stripRun?.count)).toEqual([1, 2, 2]);
    expect(tabs.filter((t) => t.stripRun?.index === 0)).toHaveLength(2);
  });

  it("leaves a lone shadowed cancellation exactly as round 1 drew it", () => {
    // A run of one: the state mark, not a count of 1. Nothing changed for it.
    const out = layoutColumn([at("09:00", 30, "confirmed"), at("09:00", 30, "cancelled")]);
    const tab = out.find((p) => p.strip);
    expect(tab?.stripRun?.count).toBe(1);
    expect(tab?.stripRun?.startMin).toBe(londonOf("09:00"));
  });

  it("puts the LONGER row first when two start together, so neither loses its click", () => {
    // Later members are painted over earlier ones. Longest-first on a tie is what
    // leaves a row nested inside another with pixels of its own below it.
    const out = layoutColumn([
      at("11:00", 60, "confirmed"),
      at("11:00", 15, "cancelled"),
      at("11:00", 45, "cancelled"),
    ]);
    const tabs = out.filter((p) => p.strip).sort((a, b) => (a.stripRun?.index ?? 0) - (b.stripRun?.index ?? 0));
    expect(tabs.map((t) => t.endMin - t.startMin)).toEqual([45, 15]);
  });

  it("never gives an ORDINARY block a run", () => {
    const out = layoutColumn([at("09:00", 30, "confirmed"), at("11:00", 30, "cancelled")]);
    expect(out.every((p) => p.stripRun === null)).toBe(true);
  });
});

describe("the lane cap: a fourth simultaneous booking is stacked, not shredded", () => {
  const FIVE = Array.from({ length: 5 }, () => at("09:00", 30));

  it("never divides a column into more than a few slots", () => {
    const out = layoutColumn(FIVE);
    expect(out.every((p) => p.lanes === MAX_DRAWN_LANES)).toBe(true);
    expect(out.every((p) => p.lane <= MAX_DRAWN_LANES - 1)).toBe(true);
  });

  it("steps the overflow in front of the last slot rather than hiding it", () => {
    const out = layoutColumn(FIVE);
    // Five bookings, five blocks. Three take a slot each; the fourth and fifth
    // are stepped 1 and 2 places into the last one and stack in front of it.
    expect(out).toHaveLength(5);
    expect([...out].map((p) => p.depth).sort()).toEqual([0, 0, 0, 1, 2]);
  });

  it("leaves an ordinary clash entirely alone", () => {
    expect(layoutColumn([at("09:00", 60), at("09:30", 30)]).every((p) => p.depth === 0)).toBe(true);
  });
});

describe("dayBounds", () => {
  it("shows the full opening hours even when only one appointment is booked", () => {
    expect(dayBounds([{ startMin: 600, endMin: 630 }])).toEqual({
      startMin: 8 * 60,
      endMin: 19 * 60,
    });
  });

  it("extends to cover an early appointment rather than clipping it", () => {
    expect(dayBounds([{ startMin: 7 * 60 + 15, endMin: 7 * 60 + 45 }]).startMin).toBe(7 * 60);
  });

  it("extends to cover a late finish", () => {
    expect(dayBounds([{ startMin: 19 * 60, endMin: 20 * 60 + 10 }]).endMin).toBe(21 * 60);
  });

  it("ignores unparseable spans", () => {
    expect(dayBounds([{ startMin: Number.NaN, endMin: Number.NaN }])).toEqual({
      startMin: 8 * 60,
      endMin: 19 * 60,
    });
  });

  it("never returns a zero-height window", () => {
    const b = dayBounds([{ startMin: 540, endMin: 540 }], 540, 540);
    expect(b.endMin).toBeGreaterThan(b.startMin);
  });
});

describe("nowFraction", () => {
  const bounds = { startMin: 8 * 60, endMin: 20 * 60 };

  it("places the marker proportionally within the drawn day", () => {
    // 14:00 London on 30 July 2026 (BST) is 13:00 UTC; halfway through 08:00-20:00.
    const f = nowFraction(new Date("2026-07-30T13:00:00Z"), "2026-07-30", bounds);
    expect(f).toBeCloseTo(0.5, 5);
  });

  it("is null when the viewed day is not today", () => {
    expect(nowFraction(new Date("2026-07-30T13:00:00Z"), "2026-07-31", bounds)).toBeNull();
  });

  it("is null before the grid starts, rather than pinning to the top", () => {
    expect(nowFraction(new Date("2026-07-30T05:00:00Z"), "2026-07-30", bounds)).toBeNull();
  });

  it("is null after the grid ends", () => {
    expect(nowFraction(new Date("2026-07-30T21:30:00Z"), "2026-07-30", bounds)).toBeNull();
  });
});

describe("hourMarks and labelMinutes", () => {
  it("rules every hour inclusive of both ends", () => {
    expect(hourMarks({ startMin: 8 * 60, endMin: 11 * 60 })).toEqual([480, 540, 600, 660]);
  });

  it("starts at the first whole hour inside a part-hour window", () => {
    expect(hourMarks({ startMin: 8 * 60 + 20, endMin: 10 * 60 })[0]).toBe(9 * 60);
  });

  it("labels minutes as a 24-hour clock", () => {
    expect(labelMinutes(9 * 60)).toBe("09:00");
    expect(labelMinutes(13 * 60 + 45)).toBe("13:45");
    expect(labelMinutes(0)).toBe("00:00");
  });
});

describe("diaryColumns", () => {
  const prac = [
    { id: "p1", name: "Dana Hale" },
    { id: "p2", name: "Femi Osei" },
  ];

  it("keeps a column for a clinician with nothing booked", () => {
    const cols = diaryColumns(prac, [{ practitionerId: "p1", practitioner: "Dana Hale" }]);
    expect(cols.map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("adds no unassigned column when every appointment has a clinician", () => {
    const cols = diaryColumns(prac, [{ practitionerId: "p1", practitioner: "Dana Hale" }]);
    expect(cols.some((c) => c.id === null)).toBe(false);
  });

  it("adds an unassigned column, last, when something has no clinician", () => {
    const cols = diaryColumns(prac, [{ practitionerId: null, practitioner: null }]);
    expect(cols[cols.length - 1]).toEqual({ id: null, name: "Unassigned" });
  });

  it("gives a locum not in the active list their own column rather than losing them", () => {
    const cols = diaryColumns(prac, [{ practitionerId: "p9", practitioner: "Dr Locum" }]);
    expect(cols.map((c) => c.name)).toContain("Dr Locum");
  });

  it("does not duplicate a locum booked several times", () => {
    const cols = diaryColumns(prac, [
      { practitionerId: "p9", practitioner: "Dr Locum" },
      { practitionerId: "p9", practitioner: "Dr Locum" },
    ]);
    expect(cols.filter((c) => c.id === "p9")).toHaveLength(1);
  });

  it("names an unknown clinician sensibly when the name is missing too", () => {
    const cols = diaryColumns(prac, [{ practitionerId: "p9", practitioner: null }]);
    expect(cols.find((c) => c.id === "p9")?.name).toBe("Other clinician");
  });
});
