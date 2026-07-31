import { describe, expect, it } from "vitest";
import {
  accessibleSentence,
  blockEdges,
  blockMetaLine,
  blockStyle,
  blockTier,
  columnCounts,
  dayCaption,
  dayCounts,
  initialsOf,
  interiorGaps,
  nextFocus,
  openingWindowFor,
  orderColumns,
  parseOpeningWindow,
  parseZoom,
  pxPerMinute,
  resolveSolo,
  sortByStart,
  weekColumn,
  stateGlyph,
  weekdayOf,
  blockInnerHeight,
  BLOCK_PAD_Y,
  LINE_META_PX,
  LINE_NAME_PX,
  LINE_SHORT_NAME_PX,
  PX_PER_5MIN,
  type DiaryAppointment,
  type FocusItem,
  type Zoom,
} from "./diary-view";

const ZOOMS: Zoom[] = ["compact", "normal", "roomy"];

const appt = (over: Partial<DiaryAppointment> = {}): DiaryAppointment => ({
  id: "a1",
  patientId: "p1",
  patientName: "Jaya Sharma",
  start: "2026-08-03T08:20:00Z", // 09:20 London (BST)
  finish: null,
  durationMin: 30,
  state: "confirmed",
  reason: "Examination",
  note: null,
  practitioner: "Jin Kim",
  practitionerId: "p-jin",
  ...over,
});

describe("parseOpeningWindow", () => {
  it("reads a normal weekday window", () => {
    expect(parseOpeningWindow("09:00-17:30")).toEqual({ openMin: 540, closeMin: 1050 });
  });

  it("reads a Saturday morning window", () => {
    expect(parseOpeningWindow("09:00-13:00")).toEqual({ openMin: 540, closeMin: 780 });
  });

  it("falls back to the 08:00 to 19:00 defaults for anything unusable", () => {
    const fallback = { openMin: 480, closeMin: 1140 };
    expect(parseOpeningWindow(null)).toEqual(fallback);
    expect(parseOpeningWindow("")).toEqual(fallback);
    expect(parseOpeningWindow("rubbish")).toEqual(fallback);
    expect(parseOpeningWindow(undefined)).toEqual(fallback);
  });

  it("falls back when the window ends at or before it starts", () => {
    const fallback = { openMin: 480, closeMin: 1140 };
    expect(parseOpeningWindow("17:30-09:00")).toEqual(fallback);
    expect(parseOpeningWindow("09:00-09:00")).toEqual(fallback);
  });
});

describe("weekdayOf / openingWindowFor", () => {
  it("names the weekday of a day key", () => {
    expect(weekdayOf("2026-08-03")).toBe("monday");
    expect(weekdayOf("2026-08-08")).toBe("saturday");
    expect(weekdayOf("2026-08-09")).toBe("sunday");
  });

  it("uses that weekday's window, and the defaults for a day with none", () => {
    const hours = { monday: "09:00-17:30", saturday: "09:00-13:00", sunday: null };
    expect(openingWindowFor(hours, "2026-08-03")).toEqual({ openMin: 540, closeMin: 1050 });
    expect(openingWindowFor(hours, "2026-08-08")).toEqual({ openMin: 540, closeMin: 780 });
    // A closed day makes NO claim about being closed: it falls back to the wide default.
    expect(openingWindowFor(hours, "2026-08-09")).toEqual({ openMin: 480, closeMin: 1140 });
  });
});

describe("parseZoom", () => {
  it("defaults to normal for anything unrecognised", () => {
    expect(parseZoom("compact")).toBe("compact");
    expect(parseZoom("roomy")).toBe("roomy");
    expect(parseZoom("normal")).toBe("normal");
    expect(parseZoom(undefined)).toBe("normal");
    expect(parseZoom("huge")).toBe("normal");
  });
});

describe("PX_PER_5MIN / pxPerMinute", () => {
  it("runs 8, 12 and 16 px per five minutes", () => {
    expect(PX_PER_5MIN).toEqual({ compact: 8, normal: 12, roomy: 16 });
    expect(pxPerMinute("compact")).toBeCloseTo(1.6, 10);
    expect(pxPerMinute("normal")).toBeCloseTo(2.4, 10);
    expect(pxPerMinute("roomy")).toBeCloseTo(3.2, 10);
  });

  it("puts every five-minute multiple on a whole pixel at every zoom", () => {
    for (const zoom of ZOOMS) {
      for (let m = 0; m <= 12 * 60; m += 5) {
        const px = m * pxPerMinute(zoom);
        expect(Math.abs(px - Math.round(px))).toBeLessThan(1e-9);
      }
    }
  });
});

describe("blockEdges (rounds the EDGES, never the height)", () => {
  it("tiles two consecutive 10 minute blocks exactly, at every zoom", () => {
    for (const zoom of ZOOMS) {
      const first = blockEdges(9 * 60 + 10, 9 * 60 + 20, 9 * 60, zoom);
      const second = blockEdges(9 * 60 + 20, 9 * 60 + 30, 9 * 60, zoom);
      expect(first.top + first.height).toBe(second.top);
    }
  });

  it("tiles exactly against a bounds start that is not on the hour", () => {
    for (const zoom of ZOOMS) {
      const bounds = 8 * 60 + 47;
      const first = blockEdges(9 * 60 + 10, 9 * 60 + 20, bounds, zoom);
      const second = blockEdges(9 * 60 + 20, 9 * 60 + 30, bounds, zoom);
      expect(first.top + first.height).toBe(second.top);
      expect(first.height).toBeGreaterThan(0);
    }
  });

  it("places the top of the day at zero", () => {
    expect(blockEdges(540, 570, 540, "normal")).toEqual({ top: 0, height: 72 });
  });
});

describe("blockTier", () => {
  it("switches at 34, 20 and 13 pixels", () => {
    expect(blockTier(34, 1)).toBe("full");
    expect(blockTier(33, 1)).toBe("single");
    expect(blockTier(20, 1)).toBe("single");
    expect(blockTier(19, 1)).toBe("name");
    expect(blockTier(13, 1)).toBe("name");
    expect(blockTier(12, 1)).toBe("bar");
  });

  it("caps at single with two lanes and at name with three, and leaves one lane uncapped", () => {
    expect(blockTier(200, 2)).toBe("single");
    expect(blockTier(200, 3)).toBe("name");
    expect(blockTier(200, 8)).toBe("name");
    expect(blockTier(200, 1)).toBe("full");
  });

  it("never promotes a short block just because it is alone in its lane", () => {
    expect(blockTier(12, 1)).toBe("bar");
    expect(blockTier(12, 3)).toBe("bar");
  });

  it("matches the duration matrix at every zoom", () => {
    const expected: Record<number, Record<Zoom, string>> = {
      5: { compact: "bar", normal: "bar", roomy: "name" },
      10: { compact: "name", normal: "single", roomy: "single" },
      15: { compact: "single", normal: "full", roomy: "full" },
      20: { compact: "single", normal: "full", roomy: "full" },
      30: { compact: "full", normal: "full", roomy: "full" },
      60: { compact: "full", normal: "full", roomy: "full" },
    };
    for (const [minsRaw, byZoom] of Object.entries(expected)) {
      const mins = Number(minsRaw);
      for (const zoom of ZOOMS) {
        const { height } = blockEdges(540, 540 + mins, 540, zoom);
        expect(`${mins}@${zoom}=${blockTier(height, 1)}`).toBe(`${mins}@${zoom}=${byZoom[zoom]}`);
      }
    }
  });
});

// A tier that admits a line its own threshold height cannot fit renders a
// patient name with its descenders sliced off, which on a diary read from two
// metres is the difference between a legible day and a suspicious one. The
// thresholds and the block's own chrome therefore have to be checked together:
// they used to be set independently, and every boundary was 10px too generous.
describe("blockTier thresholds actually FIT the lines each tier draws", () => {
  it("a block at the 'full' threshold fits both a name line and a meta line", () => {
    expect(blockTier(34, 1)).toBe("full");
    expect(blockInnerHeight(34, "full")).toBeGreaterThanOrEqual(LINE_NAME_PX + LINE_META_PX);
  });

  it("a block at the 'single' threshold fits its name line", () => {
    expect(blockTier(20, 1)).toBe("single");
    expect(blockInnerHeight(20, "single")).toBeGreaterThanOrEqual(LINE_NAME_PX);
  });

  it("a block at the 'name' threshold fits the short name line", () => {
    expect(blockTier(13, 1)).toBe("name");
    expect(blockInnerHeight(13, "name")).toBeGreaterThanOrEqual(LINE_SHORT_NAME_PX);
  });

  it("padding only ever tightens as the block shortens", () => {
    expect(BLOCK_PAD_Y.full).toBeGreaterThanOrEqual(BLOCK_PAD_Y.single);
    expect(BLOCK_PAD_Y.single).toBeGreaterThanOrEqual(BLOCK_PAD_Y.name);
  });

  it("holds at every threshold across every zoom, for the real drawn heights", () => {
    const need: Record<string, number> = {
      full: LINE_NAME_PX + LINE_META_PX,
      single: LINE_NAME_PX,
      name: LINE_SHORT_NAME_PX,
      bar: 0,
    };
    for (const zoom of ZOOMS) {
      for (const mins of [5, 10, 15, 20, 30, 45, 60]) {
        const { height } = blockEdges(540, 540 + mins, 540, zoom);
        const tier = blockTier(height, 1);
        expect(`${mins}@${zoom}: ${blockInnerHeight(height, tier) >= need[tier]}`).toBe(
          `${mins}@${zoom}: true`,
        );
      }
    }
  });
});

describe("blockStyle", () => {
  const states = [
    "pending",
    "confirmed",
    "arrived",
    "in_surgery",
    "completed",
    "cancelled",
    "did_not_attend",
  ];

  it("gives every clinically distinct state its own treatment", () => {
    const seen = states.map((s) => JSON.stringify(blockStyle(s)));
    expect(new Set(seen).size).toBe(states.length);
  });

  it("treats the legacy booked exactly as confirmed but keeps its own glyph", () => {
    // 6.4: booked is the mock's stand-in for confirmed, drawn identically so the
    // day's healthy mass reads as one family, but it keeps its own letter and its
    // own label and is never silently relabelled.
    expect(blockStyle("booked")).toEqual(blockStyle("confirmed"));
    expect(stateGlyph("booked")).not.toEqual(stateGlyph("confirmed"));
  });

  it("makes cancelled the only spineless, dashed block", () => {
    expect(blockStyle("cancelled").spine).toBe("");
    expect(blockStyle("cancelled").dashed).toBe(true);
    for (const s of states.filter((x) => x !== "cancelled")) {
      expect(blockStyle(s).spine).not.toBe("");
      expect(blockStyle(s).dashed).toBe(false);
    }
  });

  it("makes in_surgery the only solid block and did_not_attend the only hatched one", () => {
    expect(blockStyle("in_surgery").solid).toBe(true);
    expect(blockStyle("did_not_attend").hatched).toBe(true);
    for (const s of states.filter((x) => x !== "in_surgery")) expect(blockStyle(s).solid).toBe(false);
    for (const s of states.filter((x) => x !== "did_not_attend")) expect(blockStyle(s).hatched).toBe(false);
  });

  it("falls back identically for every unrecognised state", () => {
    expect(blockStyle("some_new_state")).toEqual(blockStyle("another_new_state"));
    expect(blockStyle("some_new_state")).not.toEqual(blockStyle("confirmed"));
    expect(blockStyle("some_new_state").spine).toBe("bg-line-strong");
  });

  it("never puts a status ink on the patient name", () => {
    for (const s of [...states, "booked", "mystery"]) {
      expect(blockStyle(s).nameInk).not.toContain("text-status-");
    }
  });
});

describe("stateGlyph", () => {
  it("reproduces the letters the practice was trained on", () => {
    expect(stateGlyph("pending")).toEqual({ kind: "text", text: "P" });
    expect(stateGlyph("confirmed")).toEqual({ kind: "text", text: "C" });
    expect(stateGlyph("booked")).toEqual({ kind: "text", text: "B" });
    expect(stateGlyph("arrived")).toEqual({ kind: "clock" });
    expect(stateGlyph("in_surgery")).toEqual({ kind: "text", text: "S" });
    expect(stateGlyph("completed")).toEqual({ kind: "check" });
    expect(stateGlyph("cancelled")).toEqual({ kind: "text", text: "X" });
    expect(stateGlyph("did_not_attend")).toEqual({ kind: "text", text: "DNA" });
  });

  it("returns nothing for an unknown state", () => {
    expect(stateGlyph("some_new_state")).toBeNull();
  });
});

describe("interiorGaps", () => {
  const span = (startMin: number, endMin: number) => ({ startMin, endMin });

  it("never labels the run before the first block or after the last", () => {
    const gaps = interiorGaps([span(600, 630)], 480, 1140, "normal");
    expect(gaps).toEqual([]);
  });

  it("labels a gap that is strictly between two blocks", () => {
    const gaps = interiorGaps([span(540, 570), span(600, 630)], 540, 1080, "normal");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(30);
    expect(gaps[0].top).toBe(72);
    expect(gaps[0].height).toBe(72);
  });

  it("drops a gap shorter than fifteen minutes", () => {
    expect(interiorGaps([span(540, 570), span(580, 610)], 540, 1080, "normal")).toEqual([]);
  });

  it("drops a gap that would be under twenty pixels tall at this zoom", () => {
    // 15 minutes: 24px at Compact, but only 20px is needed, so it survives there;
    // it is the 20px floor rather than the minute floor that bites on short gaps.
    expect(interiorGaps([span(540, 570), span(585, 615)], 540, 1080, "compact")).toHaveLength(1);
    // A gap under the pixel floor at the smallest zoom is dropped, not clipped.
    expect(interiorGaps([span(540, 570), span(582, 612)], 540, 1080, "compact")).toEqual([]);
  });

  it("returns nothing for an empty column or a single block", () => {
    expect(interiorGaps([], 540, 1080, "normal")).toEqual([]);
    expect(interiorGaps([span(600, 660)], 540, 1080, "normal")).toEqual([]);
  });

  it("counts a cancelled or did-not-attend block as occupying its span", () => {
    // The middle block is a cancellation; the hole around it must NOT be labelled
    // as one 90 minute gap, because the cancelled block already reads as the hole.
    const gaps = interiorGaps([span(540, 570), span(600, 630), span(660, 690)], 540, 1080, "normal");
    expect(gaps.map((g) => g.minutes)).toEqual([30, 30]);
  });

  it("merges overlapping blocks before looking for a gap", () => {
    const gaps = interiorGaps([span(540, 600), span(550, 620), span(660, 690)], 540, 1080, "normal");
    expect(gaps.map((g) => g.minutes)).toEqual([40]);
  });
});

describe("accessibleSentence", () => {
  it("spells the range with 'to' and never a dash", () => {
    const s = accessibleSentence(appt(), "Jin Kim", 1);
    expect(s).toContain("09:20 to 09:50, 30 minutes.");
    expect(s).not.toContain("-");
  });

  it("carries the patient, reason, note, clinician and state word", () => {
    const s = accessibleSentence(
      appt({ note: "nervous patient, allow extra time" }),
      "Jin Kim",
      1,
    );
    expect(s).toBe(
      "09:20 to 09:50, 30 minutes. Jaya Sharma. Examination. Note: nervous patient, allow extra time. Jin Kim. Confirmed.",
    );
  });

  it("omits a missing reason, note or clinician cleanly", () => {
    const s = accessibleSentence(appt({ reason: null, note: null }), null, 1);
    expect(s).toBe("09:20 to 09:50, 30 minutes. Jaya Sharma. Confirmed.");
  });

  it("names a clash", () => {
    expect(accessibleSentence(appt(), "Jin Kim", 2)).toContain(", double booked with 1 other");
    expect(accessibleSentence(appt(), "Jin Kim", 3)).toContain(" with 2 others");
  });

  it("carries the raw value for an unrecognised state", () => {
    expect(accessibleSentence(appt({ state: "some_new_state" }), null, 1)).toContain("some_new_state.");
  });
});

describe("blockMetaLine", () => {
  it("joins time, duration, reason and note", () => {
    expect(blockMetaLine(appt({ note: "interpreter booked" }))).toBe(
      "09:20 · 30m · Examination · interpreter booked",
    );
  });

  it("omits the parts that are not there rather than leaving an empty segment", () => {
    expect(blockMetaLine(appt({ reason: null, note: null }))).toBe("09:20 · 30m");
  });
});

describe("dayCounts / columnCounts / dayCaption", () => {
  const of = (...states: string[]) => states.map((state) => ({ state }));

  it("keeps cancellations and no-shows out of the booked total", () => {
    const c = dayCounts(of("confirmed", "pending", "cancelled", "did_not_attend", "completed"));
    expect(c).toEqual({ booked: 3, pending: 1, cancelled: 1, noShow: 1 });
  });

  it("counts every live state as booked", () => {
    const c = dayCounts(of("pending", "confirmed", "booked", "arrived", "in_surgery", "completed"));
    expect(c.booked).toBe(6);
    expect(c.pending).toBe(1);
  });

  it("counts an unknown state as booked and never as cancelled", () => {
    const c = dayCounts(of("some_new_state"));
    expect(c).toEqual({ booked: 1, pending: 0, cancelled: 0, noShow: 0 });
  });

  it("summarises a column with only its non-zero segments", () => {
    expect(columnCounts([])).toBe("Nothing booked");
    expect(columnCounts(of("confirmed", "confirmed", "pending"))).toBe("3 booked, 1 pending");
    expect(columnCounts(of("cancelled"))).toBe("1 cancelled");
  });

  it("captions the day naming cancellations and no-shows separately", () => {
    expect(
      dayCaption("N15 Vitality Dental", { booked: 47, pending: 3, cancelled: 2, noShow: 1 }),
    ).toBe("N15 Vitality Dental · 47 booked · 3 awaiting confirmation · 2 cancelled · 1 no-show");
    expect(dayCaption("N17 Dental", { booked: 0, pending: 0, cancelled: 0, noShow: 0 })).toBe(
      "N17 Dental · Nothing booked",
    );
  });
});

describe("orderColumns", () => {
  const prac = [
    { id: "p2", name: "Zoe Adams" },
    { id: "p1", name: "Ali Khan" },
  ];

  it("sorts the practitioners by name with en-GB collation", () => {
    const cols = orderColumns(prac, []);
    expect(cols.map((c) => c.name)).toEqual(["Ali Khan", "Zoe Adams"]);
  });

  it("keeps a clinician with nothing booked", () => {
    const cols = orderColumns(prac, [{ practitionerId: "p1", practitioner: "Ali Khan" }]);
    expect(cols.map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("retains a locum who appears only in the day's appointments, and puts Unassigned last", () => {
    const cols = orderColumns(prac, [
      { practitionerId: "p9", practitioner: "Dr Locum" },
      { practitionerId: null, practitioner: null },
    ]);
    expect(cols.map((c) => c.id)).toEqual(["p1", "p2", "p9", null]);
    expect(cols[cols.length - 1].name).toBe("Unassigned");
  });
});

// A stale clinician pick used to filter every column away, leaving a bare time
// gutter on a fully booked day with the caption above it still reading
// "24 booked". Three reviewers reached it independently, so the resolution is
// pure, named and tested rather than an inline expression in the board.
describe("resolveSolo (a stale clinician pick must never empty the grid)", () => {
  const columns = [{ key: "p1" }, { key: "p2" }, { key: "unassigned" }];

  it("shows every column when nothing is picked", () => {
    expect(resolveSolo(columns, null)).toEqual({ effective: null, dropped: false });
  });

  it("honours a pick that is on this day's diary", () => {
    expect(resolveSolo(columns, "p2")).toEqual({ effective: "p2", dropped: false });
  });

  it("drops a pick for a clinician who is not on this day, and says it dropped it", () => {
    // Soloing a locum, then stepping to a day they do not work.
    expect(resolveSolo(columns, "p9")).toEqual({ effective: null, dropped: true });
    // Soloing Unassigned, then stepping to a day where every row has a clinician.
    expect(resolveSolo([{ key: "p1" }], "unassigned")).toEqual({ effective: null, dropped: true });
    // Switching site under All sites: nothing resets the pick.
    expect(resolveSolo([{ key: "n17-a" }], "p1")).toEqual({ effective: null, dropped: true });
    // Any pasted ?clinician= for a clinician since deactivated.
    expect(resolveSolo(columns, "anything-at-all")).toEqual({ effective: null, dropped: true });
  });

  it("drops rather than throwing when there are no columns at all", () => {
    expect(resolveSolo([], "p1")).toEqual({ effective: null, dropped: true });
    expect(resolveSolo([], null)).toEqual({ effective: null, dropped: false });
  });
});

describe("weekColumn (week view draws ONE clinician, and must name them)", () => {
  const columns = [
    { key: "p1", name: "Ali Khan" },
    { key: "p2", name: "Zoe Adams" },
  ];

  it("draws the soloed clinician and returns their name to be printed", () => {
    expect(weekColumn(columns, "p2")).toEqual({ key: "p2", name: "Zoe Adams" });
  });

  it("falls back to the first column, and still names it", () => {
    // The name is what stops a week grid drawn for one person sitting under a
    // caption and a rail that claim the whole practice.
    expect(weekColumn(columns, null)).toEqual({ key: "p1", name: "Ali Khan" });
  });

  it("never resolves to a key that is not a column", () => {
    expect(weekColumn(columns, "gone")).toEqual({ key: "p1", name: "Ali Khan" });
  });

  it("returns nulls when there is no clinician to draw", () => {
    expect(weekColumn([], null)).toEqual({ key: null, name: null });
  });
});

describe("initialsOf", () => {
  it("takes the first and last word of a name", () => {
    expect(initialsOf("Jin Kim")).toBe("JK");
    expect(initialsOf("Murtaza Siddiqui (Principal Dentist)")).toBe("MS");
  });

  it("copes with the practitioner records that are not people", () => {
    expect(initialsOf("DAY NOTES")).toBe("DN");
    expect(initialsOf("UDC Diary")).toBe("UD");
  });

  it("never returns punctuation or an empty string", () => {
    expect(initialsOf("Ada")).toBe("AD");
    expect(initialsOf("   ")).toBe("?");
    expect(initialsOf("-")).toBe("?");
  });
});

describe("nextFocus", () => {
  const item = (id: string, startMin: number): FocusItem => ({ id, startMin });
  const columns: FocusItem[][] = [
    [item("a", 540), item("b", 600), item("c", 660)],
    [],
    [item("d", 570), item("e", 630)],
  ];

  it("moves down and up by start time and stops at the ends", () => {
    expect(nextFocus(columns, 0, 540, "ArrowDown")?.id).toBe("b");
    expect(nextFocus(columns, 0, 660, "ArrowDown")?.id).toBe("c");
    expect(nextFocus(columns, 0, 600, "ArrowUp")?.id).toBe("a");
    expect(nextFocus(columns, 0, 540, "ArrowUp")?.id).toBe("a");
  });

  it("reaches the first and last of a column", () => {
    expect(nextFocus(columns, 0, 600, "Home")?.id).toBe("a");
    expect(nextFocus(columns, 0, 600, "End")?.id).toBe("c");
  });

  it("lands on the nearest appointment at or after the current start in the next column", () => {
    const moved = nextFocus(columns, 0, 600, "ArrowRight");
    expect(moved).toEqual({ colIndex: 2, id: "e", startMin: 630 });
  });

  it("falls back to the last one before the current start when nothing is after it", () => {
    const moved = nextFocus(columns, 0, 660, "ArrowRight");
    expect(moved).toEqual({ colIndex: 2, id: "e", startMin: 630 });
  });

  it("steps over an empty column rather than swallowing the focus", () => {
    expect(nextFocus(columns, 2, 570, "ArrowLeft")?.colIndex).toBe(0);
  });

  it("returns the current position unchanged at either edge, never wrapping", () => {
    expect(nextFocus(columns, 2, 570, "ArrowRight")).toEqual({ colIndex: 2, id: "d", startMin: 570 });
    expect(nextFocus(columns, 0, 540, "ArrowLeft")).toEqual({ colIndex: 0, id: "a", startMin: 540 });
  });

  it("returns nothing when the whole day is empty", () => {
    expect(nextFocus([[], []], 0, 540, "ArrowDown")).toBeNull();
  });
});

describe("sortByStart", () => {
  it("orders correctly when the feed mixes offset forms, where a lexical compare would not", () => {
    // 09:30+01:00 IS 08:30Z, so it is half an hour BEFORE 09:00Z. A lexical
    // compare of the strings reads "09:00" as earlier than "09:30" and puts the
    // two the wrong way round, which would give a reading order that contradicts
    // the drawn grid (placement goes through londonMinutes and stays right).
    const rows = [
      { id: "zed", start: "2026-08-03T09:00:00Z" },
      { id: "offset", start: "2026-08-03T09:30:00+01:00" },
    ];
    expect(sortByStart(rows).map((r) => r.id)).toEqual(["offset", "zed"]);
    expect([...rows].sort((a, b) => (a.start < b.start ? -1 : 1)).map((r) => r.id)).toEqual([
      "zed",
      "offset",
    ]);
  });

  it("sorts an unparseable start last rather than to the top of the day", () => {
    const rows = [{ id: "bad", start: "not a date" }, { id: "good", start: "2026-08-03T08:30:00Z" }];
    expect(sortByStart(rows).map((r) => r.id)).toEqual(["good", "bad"]);
  });
});
