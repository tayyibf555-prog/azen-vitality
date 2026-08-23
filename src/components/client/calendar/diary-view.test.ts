import { describe, expect, it } from "vitest";
import {
  accessibleSentence,
  blockChrome,
  blockEdges,
  blockMetaLine,
  blockStyle,
  blockTier,
  blockWidthPx,
  columnCounts,
  COL_MIN_PX,
  dayCaption,
  dayCounts,
  columnIsHideable,
  freeLabel,
  freeStretches,
  initialsOf,
  parseColumnScope,
  visibleColumns,
  FREE_LABEL_MIN_MINUTES,
  FREE_LABEL_MIN_PX,
  HEADER_PX,
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
  blockBodyText,
  blockLeadLine,
  bodyLineCount,
  multidaySpanKeys,
  parseSpan,
  ruleMarks,
  shortPatientName,
  BLOCK_PAD_Y,
  LINE_BODY_PX,
  LINE_LEAD_PX,
  MULTIDAY_SPANS,
  PX_PER_5MIN,
  type DiaryAppointment,
  type FocusItem,
  type Zoom,
} from "./diary-view";
import type { ColumnWorkState } from "@/lib/calendar/working-spans";

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
  /** A block with the whole column to itself. */
  const WIDE = blockWidthPx(1, 1);

  it("switches at 32, 20 and 13 pixels", () => {
    expect(blockTier(32, WIDE)).toBe("full");
    expect(blockTier(31, WIDE)).toBe("lead");
    expect(blockTier(20, WIDE)).toBe("lead");
    expect(blockTier(19, WIDE)).toBe("name");
    expect(blockTier(13, WIDE)).toBe("name");
    expect(blockTier(12, WIDE)).toBe("bar");
  });

  it("caps on the block's DRAWN WIDTH, not on how many lanes its cluster needed", () => {
    // THE CORRECTION. The cap used to read the cluster's lane count, so a block
    // that had expanded to fill the whole column inside a three-lane cluster --
    // which is now the common case on a busy column, see layoutColumn -- was
    // demoted to a state mark and four characters of a name for no reason a
    // reader could see.
    expect(blockTier(200, blockWidthPx(3, 3))).toBe("full"); // full width of a 3-lane cluster
    expect(blockTier(200, blockWidthPx(2, 3))).toBe("full"); // two thirds
    expect(blockTier(200, blockWidthPx(1, 2))).toBe("full"); // half: 56px, still carries text
    expect(blockTier(200, blockWidthPx(1, 3))).toBe("name"); // a third: 37px, the mark only
  });

  it("never promotes a short block just because it has the width", () => {
    expect(blockTier(12, WIDE)).toBe("bar");
    expect(blockTier(12, blockWidthPx(1, 3))).toBe("bar");
  });

  it("matches the duration matrix at every zoom", () => {
    const expected: Record<number, Record<Zoom, string>> = {
      5: { compact: "bar", normal: "bar", roomy: "name" },
      10: { compact: "name", normal: "lead", roomy: "full" },
      15: { compact: "lead", normal: "full", roomy: "full" },
      20: { compact: "full", normal: "full", roomy: "full" },
      30: { compact: "full", normal: "full", roomy: "full" },
      60: { compact: "full", normal: "full", roomy: "full" },
    };
    for (const [minsRaw, byZoom] of Object.entries(expected)) {
      const mins = Number(minsRaw);
      for (const zoom of ZOOMS) {
        const { height } = blockEdges(540, 540 + mins, 540, zoom);
        expect(`${mins}@${zoom}=${blockTier(height, WIDE)}`).toBe(`${mins}@${zoom}=${byZoom[zoom]}`);
      }
    }
  });
});

describe("blockWidthPx and blockChrome: the horizontal half of the degrade ladder", () => {
  it("measures a block's share of the NARROWEST column it will ever be drawn in", () => {
    // COL_MIN_PX, because 112 is what a column is when nothing has been measured
    // yet -- the server render and the first client frame. Under-promising is the
    // safe direction: it wastes room, where over-promising truncates a name.
    expect(blockWidthPx(1, 1)).toBe(COL_MIN_PX);
    expect(blockWidthPx(1, 2)).toBe(56);
    expect(blockWidthPx(2, 3)).toBe(75);
    expect(blockWidthPx(1, 3)).toBe(37);
  });

  // ROUND 2, ITEM 4. Hiding the empty columns made the ordinary day view three
  // wide columns instead of thirteen narrow ones, and the ladder above had the
  // narrow one hard-coded.
  it("takes the column's MEASURED width when the grid has one", () => {
    expect(blockWidthPx(1, 1, 322)).toBe(322);
    expect(blockWidthPx(1, 2, 322)).toBe(161);
  });

  it("never measures BELOW the minimum, whatever it is handed", () => {
    // A transient 0 during layout, or a nonsense value, must not shrink every
    // card on the screen. The floor is the width the ladder was designed at.
    expect(blockWidthPx(1, 1, 0)).toBe(COL_MIN_PX);
    expect(blockWidthPx(1, 1, Number.NaN)).toBe(COL_MIN_PX);
    expect(blockWidthPx(1, 1, 40)).toBe(COL_MIN_PX);
  });

  it("stops demoting a card that has a wide column's half to itself", () => {
    // MEASURED LIVE on the owner's Saturday after the filter landed: a 630px card
    // printing "C E.Whitfield" and no time, because half of a 322px column was
    // being reported as 56px.
    expect(blockTier(144, blockWidthPx(1, 2))).toBe("full");
    expect(blockChrome(blockWidthPx(1, 2)).narrow).toBe(true);
    expect(blockChrome(blockWidthPx(1, 2, 322)).narrow).toBe(false);
  });

  it("gives a card with a whole column to itself real air, and not 112px worth", () => {
    const min = blockChrome(blockWidthPx(1, 1));
    const measured = blockChrome(blockWidthPx(1, 1, 322));
    expect(min.wide).toBe(true);
    expect(measured.wide).toBe(true);
    expect(measured.padLeft).toBe(14);
    expect(measured.padRight).toBe(26);
    // A half of a MINIMUM column is still tight and still gets the tight chrome.
    expect(blockChrome(blockWidthPx(1, 2)).wide).toBe(false);
  });

  it("keeps the full-width block's clear right strip for its corner mark", () => {
    const wide = blockChrome(blockWidthPx(1, 1));
    expect(wide.narrow).toBe(false);
    expect(wide.inlineGlyph).toBe(false);
    expect(wide.padRight).toBeGreaterThanOrEqual(16);
  });

  it("spends a half-width block's pixels on TEXT rather than on padding", () => {
    // The defect, in numbers. A half-width block is 56px. The old chrome took
    // 11 on the left and 28 on the right and left 17px for "09:30 N.Lamprell";
    // this leaves better than twice that, which is what "09:30" needs.
    const half = blockChrome(blockWidthPx(1, 2));
    expect(half.narrow).toBe(true);
    expect(half.inlineGlyph).toBe(true);
    expect(blockWidthPx(1, 2) - half.padLeft - half.padRight).toBeGreaterThanOrEqual(36);
  });

  it("leaves the wide block's right strip big enough for BOTH corner marks", () => {
    // 3px off the edge, a 13px state square, a 3px gap and a 4px note dot. The
    // strip was measured at 18 on a block with no note and clipped the last two
    // characters of every patient who had one.
    expect(blockChrome(blockWidthPx(1, 1)).padRight).toBeGreaterThanOrEqual(3 + 13 + 3 + 4);
  });

  it("still clears the state spine and the funding rail at every width", () => {
    for (const [span, lanes] of [
      [1, 1],
      [2, 3],
      [1, 2],
      [1, 3],
    ]) {
      const c = blockChrome(blockWidthPx(span, lanes));
      // The rail sits inboard of the 3px spine; the text must start clear of both.
      expect(`${span}/${lanes}: ${c.padLeft >= c.railLeft + c.railWidth}`).toBe(
        `${span}/${lanes}: true`,
      );
    }
  });
});

describe("bodyLineCount", () => {
  it("derives the clamp count from the drawn height", () => {
    expect(bodyLineCount(32)).toBe(1); // the "full" threshold
    expect(bodyLineCount(60)).toBe(3); // 25 minutes at Normal
    expect(bodyLineCount(96)).toBe(4); // 40 minutes at Normal, the cap
    expect(bodyLineCount(200)).toBe(4);
  });

  it("never returns fewer than one line, even for a block below the full tier", () => {
    expect(bodyLineCount(0)).toBe(1);
    expect(bodyLineCount(12)).toBe(1);
  });
});

// A tier that admits a line its own threshold height cannot fit renders text
// with its descenders sliced off, which on a diary read from two metres is the
// difference between a legible day and a suspicious one. The thresholds and the
// block's own chrome therefore have to be checked together: they used to be set
// independently, and every boundary was 10px too generous.
describe("blockTier thresholds actually FIT the lines each tier draws", () => {
  // The "name" tier draws one 9.5px line at leading-none: the state glyph beside
  // the short patient name, with no time. It has no shared constant because it is
  // the only place that size is used.
  const NAME_TIER_LINE_PX = 9.5;
  /** The height ladder is checked at the width where every tier is reachable. */
  const FULL_WIDTH = blockWidthPx(1, 1);

  it("a block at the 'full' threshold fits the lead line and one body line", () => {
    expect(blockTier(32, FULL_WIDTH)).toBe("full");
    expect(blockInnerHeight(32, "full")).toBeGreaterThanOrEqual(LINE_LEAD_PX + LINE_BODY_PX);
  });

  it("a block at the 'lead' threshold fits its lead line", () => {
    expect(blockTier(20, FULL_WIDTH)).toBe("lead");
    expect(blockInnerHeight(20, "lead")).toBeGreaterThanOrEqual(LINE_LEAD_PX);
  });

  it("a block at the 'name' threshold fits the short name line", () => {
    expect(blockTier(13, FULL_WIDTH)).toBe("name");
    expect(blockInnerHeight(13, "name")).toBeGreaterThanOrEqual(NAME_TIER_LINE_PX);
  });

  it("padding only ever tightens as the block shortens", () => {
    expect(BLOCK_PAD_Y.full).toBeGreaterThanOrEqual(BLOCK_PAD_Y.lead);
    expect(BLOCK_PAD_Y.lead).toBeGreaterThanOrEqual(BLOCK_PAD_Y.name);
  });

  it("holds at every threshold across every zoom, for the real drawn heights", () => {
    for (const zoom of ZOOMS) {
      for (const mins of [5, 10, 15, 20, 30, 45, 60]) {
        const { height } = blockEdges(540, 540 + mins, 540, zoom);
        const tier = blockTier(height, FULL_WIDTH);
        const need =
          tier === "full"
            ? LINE_LEAD_PX + LINE_BODY_PX
            : tier === "lead"
              ? LINE_LEAD_PX
              : tier === "name"
                ? NAME_TIER_LINE_PX
                : 0;
        expect(`${mins}@${zoom}: ${blockInnerHeight(height, tier) >= need}`).toBe(
          `${mins}@${zoom}: true`,
        );
      }
    }
  });

  // The clamp count and the tier threshold are derived from the SAME two line
  // heights, so a block can never be asked to draw more lines than it has room
  // for. This is the invariant that stops the two drifting apart again.
  it("the clamped body always fits inside the block that asked for it", () => {
    for (const zoom of ZOOMS) {
      for (let mins = 5; mins <= 120; mins += 5) {
        const { height } = blockEdges(540, 540 + mins, 540, zoom);
        if (blockTier(height, FULL_WIDTH) !== "full") continue;
        const needed = LINE_LEAD_PX + bodyLineCount(height) * LINE_BODY_PX;
        expect(`${mins}@${zoom}: ${blockInnerHeight(height, "full") >= needed}`).toBe(
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

// ===========================================================================
// ROUND 2, ITEM 5: the chrome above the grid, which on the owner's 1512px
// laptop ate 212px before 09:00 rendered. The pixels came out of the paddings
// and the row count; this is the one number in that pass that is a constant
// rather than a class, so it is the one that can be pinned here.
// ===========================================================================
describe("HEADER_PX", () => {
  it("is derived from the three lines the day header draws, with no dead air", () => {
    // The clinician (11px at leading-[1.2]), the counts (10px at leading-[1.25])
    // and the free-time figure (9.5px at leading-[1.2]), a 1px gap between each
    // pair, and the button's py-1.
    const lines = 11 * 1.2 + 10 * 1.25 + 9.5 * 1.2;
    const needed = lines + 2 + 8;
    // TWO-SIDED on purpose. A floor alone would let it drift back to the 56 it
    // was, which is nine pixels of nothing at the top of every column.
    expect(HEADER_PX).toBeGreaterThanOrEqual(needed);
    expect(HEADER_PX - needed).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// ROUND 2, ITEM 2: HIDING THE EMPTY COLUMNS.
//
// On the Saturday the owner reviewed, ten of thirteen columns said "Not working"
// and rendered at COL_MIN_PX anyway, so the three columns with patients in them
// were crushed to 112px and the diary scrolled sideways to show ten empty ones.
// Hiding is PRESENTATION: every refusal below is about what may NOT be hidden.
// ===========================================================================
describe("parseColumnScope", () => {
  it("defaults to the working clinicians for anything unrecognised or unset", () => {
    expect(parseColumnScope(undefined)).toBe("working");
    expect(parseColumnScope(null)).toBe("working");
    expect(parseColumnScope("")).toBe("working");
    expect(parseColumnScope("everyone")).toBe("working");
  });

  it("honours a stored 'all'", () => {
    expect(parseColumnScope("all")).toBe("all");
  });
});

describe("columnIsHideable", () => {
  const off = {
    appointments: [] as unknown[],
    workState: "off" as const,
    workingSpans: [] as { startMin: number; endMin: number }[],
  };

  it("hides a clinician we ASKED about who is not in and has nothing booked", () => {
    expect(columnIsHideable(off)).toBe(true);
  });

  it("keeps a column that has ANY appointment, including a cancellation", () => {
    // A cancellation is information about an hour somebody could be offered.
    expect(columnIsHideable({ ...off, appointments: [{ state: "cancelled" }] })).toBe(false);
  });

  it("keeps a clinician who is IN with an empty book", () => {
    // Hiding them would hide the practice's free capacity, which is the opposite
    // of what the owner asked for.
    expect(
      columnIsHideable({ ...off, workState: "working", workingSpans: [{ startMin: 540, endMin: 780 }] }),
    ).toBe(false);
  });

  it("NEVER hides a column that needs a human", () => {
    // The two states working-spans.ts spends thirty lines keeping apart from "Not
    // working". A failed read hidden is a clinician quietly deleted from the day;
    // an unplaced clinician hidden is the question nobody then asks.
    expect(columnIsHideable({ ...off, workState: "unknown" })).toBe(false);
    expect(columnIsHideable({ ...off, workState: "unconfirmed" })).toBe(false);
  });

  it("hides a past or unreportable day's empty column, which is quiet", () => {
    expect(columnIsHideable({ ...off, workState: "past" })).toBe(true);
    expect(columnIsHideable({ ...off, workState: "unreportable" })).toBe(true);
  });
});

describe("visibleColumns", () => {
  const col = (
    key: string,
    over: Partial<{
      appointments: unknown[];
      workState: ColumnWorkState;
      workingSpans: { startMin: number; endMin: number }[];
    }> = {},
  ) => ({
    key,
    appointments: [] as unknown[],
    workState: "off" as ColumnWorkState,
    workingSpans: [] as { startMin: number; endMin: number }[],
    ...over,
  });

  const SATURDAY = [
    col("busy", { appointments: [{}], workState: "working", workingSpans: [{ startMin: 540, endMin: 780 }] }),
    col("in-but-empty", { workState: "working", workingSpans: [{ startMin: 540, endMin: 780 }] }),
    ...Array.from({ length: 10 }, (_, i) => col(`idle-${i}`)),
  ];

  it("draws only the clinicians who are on, and says how many it held back", () => {
    const { drawn, hidden } = visibleColumns(SATURDAY, "working");
    expect(drawn.map((c) => c.key)).toEqual(["busy", "in-but-empty"]);
    expect(hidden).toBe(10);
  });

  it("draws every column when the reader asks for everyone", () => {
    const { drawn, hidden } = visibleColumns(SATURDAY, "all");
    expect(drawn).toHaveLength(12);
    expect(hidden).toBe(0);
  });

  it("hides NOTHING while the hours read is still in flight", () => {
    // Every column's working spans are empty until Dentally answers, so a filter
    // applied then would blank the diary and refill it a moment later. The reader
    // would watch ten clinicians appear out of nowhere and stop trusting it.
    const { drawn, hidden } = visibleColumns(SATURDAY, "working", { hoursPending: true });
    expect(drawn).toHaveLength(12);
    expect(hidden).toBe(0);
  });

  it("refuses to hide EVERY column, which would be a bare time gutter", () => {
    // A bank holiday, or a site shut on Sundays. A grid with no columns and no
    // explanation is the confident empty this diary refuses everywhere else.
    const shut = Array.from({ length: 4 }, (_, i) => col(`shut-${i}`));
    const { drawn, hidden } = visibleColumns(shut, "working");
    expect(drawn).toHaveLength(4);
    expect(hidden).toBe(0);
  });
});

// ===========================================================================
// ROUND 2, ITEM 3: "open slots etc need to be clearly visible in the day view".
//
// Round 1 labelled only a hole bounded on BOTH sides by a drawn block, so a
// clinician working 09:00-17:00 with one appointment at 14:00 said nothing at
// all about the five free hours above it. `working` is Dentally's own
// availability now -- the same set the column is painted white from -- so the
// edges of the day are answerable, and are answered.
// ===========================================================================
describe("freeLabel", () => {
  it("says hours and minutes, and says the word", () => {
    expect(freeLabel(100)).toBe("1h 40m free");
    expect(freeLabel(45)).toBe("45m free");
    expect(freeLabel(120)).toBe("2h free");
    expect(freeLabel(60)).toBe("1h free");
  });

  it("never prints the bare minute count it replaced", () => {
    // "140m" is a duration; "2h 20m free" is a statement about the diary.
    expect(freeLabel(140)).toBe("2h 20m free");
    expect(freeLabel(140)).not.toBe("140m");
  });
});

describe("freeStretches", () => {
  const span = (startMin: number, endMin: number) => ({ startMin, endMin });
  /** A clinician who is in all day, so the geometry cases isolate the geometry. */
  const ALL_DAY = [span(0, 1440)];

  it("LABELS the run before the first block and after the last", () => {
    // The round-2 correction, and the whole of the owner's ask. 08:00-10:00 and
    // 10:30-19:00 are both real open time and both used to be silent.
    const gaps = freeStretches([span(600, 630)], 480, 1140, "normal", ALL_DAY);
    expect(gaps.map((g) => g.minutes)).toEqual([120, 510]);
    expect(gaps.map((g) => g.label)).toEqual(["2h free", "8h 30m free"]);
  });

  it("labels a stretch between two blocks on the same geometry as a card", () => {
    const gaps = freeStretches([span(540, 570), span(600, 630)], 540, 1080, "normal", ALL_DAY);
    expect(gaps[0].minutes).toBe(30);
    expect(gaps[0].top).toBe(72);
    expect(gaps[0].height).toBe(72);
    expect(gaps[0].label).toBe("30m free");
  });

  it("drops a stretch shorter than one bookable slot", () => {
    // 09:30-09:40 is ten minutes: real, and nothing anybody can book into.
    const gaps = freeStretches([span(540, 570), span(580, 610)], 540, 1080, "normal", ALL_DAY);
    expect(gaps.map((g) => g.minutes)).toEqual([470]);
    expect(FREE_LABEL_MIN_MINUTES).toBe(15);
  });

  it("drops a stretch too short to carry the words legibly at this density", () => {
    // THE PIXEL FLOOR, and it bites at Compact. Fifteen minutes clears the minute
    // floor above but is only 24px at Compact, which is not enough air for a 10px
    // label between two cards -- so it says nothing there and says "15m free" at
    // Normal, where the same stretch is 36px.
    expect(FREE_LABEL_MIN_PX).toBe(26);
    const compact = freeStretches([span(540, 570), span(585, 615)], 540, 1080, "compact", ALL_DAY);
    expect(compact.map((g) => g.minutes)).not.toContain(15);
    const normal = freeStretches([span(540, 570), span(585, 615)], 540, 1080, "normal", ALL_DAY);
    expect(normal.map((g) => g.label)).toContain("15m free");
    // Twenty minutes is 32px at Compact and clears it there too.
    const bigger = freeStretches([span(540, 570), span(590, 620)], 540, 1080, "compact", ALL_DAY);
    expect(bigger.map((g) => g.minutes)).toContain(20);
  });

  it("labels a clinician who is IN with an empty book, in one span", () => {
    // The column the owner sees on a quiet Saturday: nothing booked, and the
    // header already says so. The body now says how much of the day that is.
    expect(freeStretches([], 540, 1080, "normal", [span(540, 1080)])[0].label).toBe("9h free");
  });

  it("counts a cancelled or did-not-attend block as occupying its span", () => {
    // A recoverable hour has an affordance of its own -- the dashed card, or the
    // counted edge tab. Printing "30m free" over the same pixels would make the
    // same statement twice, and the free label reads as "nothing to do here".
    const gaps = freeStretches(
      [span(540, 570), span(600, 630), span(660, 690)],
      540,
      1080,
      "normal",
      ALL_DAY,
    );
    expect(gaps.map((g) => g.minutes)).toEqual([30, 30, 390]);
  });

  it("merges overlapping blocks before looking for free time", () => {
    const gaps = freeStretches(
      [span(540, 600), span(550, 620), span(660, 690)],
      540,
      1080,
      "normal",
      ALL_DAY,
    );
    expect(gaps.map((g) => g.minutes)).toEqual([40, 390]);
  });

  // THE FIGURE IS A CLAIM ABOUT BOOKABLE TIME. Everything below is the difference
  // between the label a receptionist reads and the capacity that actually exists.

  it("labels NOTHING when there is no working time to measure against", () => {
    // No availability, no claim. A figure with no source is exactly the confident
    // empty this screen refuses.
    expect(freeStretches([span(540, 570), span(600, 630)], 540, 1080, "normal")).toEqual([]);
    expect(freeStretches([span(540, 570), span(600, 630)], 540, 1080, "normal", [])).toEqual([]);
  });

  it("cuts the stretch down to the clinician's actual session", () => {
    // Blocks at 09:00 and 15:00, but the session ends at 12:00. The bookable hole
    // is 09:30 to 12:00, and there is no free time at all after it.
    const gaps = freeStretches(
      [span(540, 570), span(900, 930)],
      540,
      1080,
      "normal",
      [span(540, 720)],
    );
    expect(gaps.map((g) => g.minutes)).toEqual([150]);
  });

  it("subtracts a break, and splits the label either side of it", () => {
    // 12:00 to 12:30 booked, 15:00 to 15:30 booked, lunch 13:00 to 14:00. The
    // reader must never see one span running across the lunch hour.
    const gaps = freeStretches(
      [span(720, 750), span(900, 930)],
      540,
      1080,
      "normal",
      [span(540, 1080)],
      [span(780, 840)],
    );
    expect(gaps.map((g) => g.minutes)).toEqual([180, 30, 60, 150]);
  });

  it("labels each part of a session that is split by off time", () => {
    const gaps = freeStretches(
      [span(540, 570), span(900, 930)],
      540,
      1080,
      "normal",
      [span(540, 660), span(780, 930)],
    );
    expect(gaps.map((g) => g.minutes)).toEqual([90, 120]);
  });

  it("never runs a label past the drawn day", () => {
    // A session that outlives the grid's own bottom edge is clipped to it, or the
    // label sits over the page behind the diary.
    const gaps = freeStretches([], 540, 1080, "normal", [span(400, 1400)]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].minutes).toBe(540);
    expect(gaps[0].top).toBe(0);
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

  // Funding reaches the reader through a 3px rail, and colour must never be the
  // only carrier. At the 'lead' tier and below the body text is not drawn at all,
  // so this sentence is the ONLY channel left besides the rail.
  it("names the funding after the clinician and before the state", () => {
    expect(accessibleSentence(appt({ note: null }), "Jin Kim", 1, "nhs")).toBe(
      "09:20 to 09:50, 30 minutes. Jaya Sharma. Examination. Jin Kim. NHS. Confirmed.",
    );
    expect(accessibleSentence(appt({ note: null }), "Jin Kim", 1, "private")).toContain(
      "Jin Kim. Private. Confirmed.",
    );
    expect(accessibleSentence(appt({ note: null }), "Jin Kim", 1, "udc")).toContain(
      "Jin Kim. UDC. Confirmed.",
    );
  });

  it("says NOTHING at all for unresolvable funding, never the word unknown", () => {
    const s = accessibleSentence(appt({ note: null }), "Jin Kim", 1, "unknown");
    expect(s).toBe("09:20 to 09:50, 30 minutes. Jaya Sharma. Examination. Jin Kim. Confirmed.");
    expect(s.toLowerCase()).not.toContain("unknown");
    // Defaulting the argument must behave identically to passing "unknown".
    expect(accessibleSentence(appt({ note: null }), "Jin Kim", 1)).toBe(s);
  });
});

describe("shortPatientName", () => {
  it("prints the reference's form: initial, full stop, no space, surname", () => {
    expect(shortPatientName("Nadia Lamprell")).toBe("N.Lamprell");
    expect(shortPatientName("Jaya Sharma")).toBe("J.Sharma");
  });

  it("uses the LAST word as the surname, so a middle name is dropped not the surname", () => {
    expect(shortPatientName("Ana Maria Ferreira")).toBe("A.Ferreira");
  });

  it("returns a single word unchanged, so a non-person diary column stays readable", () => {
    expect(shortPatientName("Unassigned")).toBe("Unassigned");
    expect(shortPatientName("  Lamprell  ")).toBe("Lamprell");
  });

  it("returns an empty string for an empty name rather than a stray full stop", () => {
    expect(shortPatientName("")).toBe("");
    expect(shortPatientName("   ")).toBe("");
  });
});

describe("blockLeadLine", () => {
  it("is the start time then the short name", () => {
    expect(blockLeadLine(appt({ patientName: "Nadia Lamprell" }))).toBe("09:20 N.Lamprell");
  });

  it("falls back to the name alone when the start cannot be parsed, never a fake time", () => {
    const line = blockLeadLine(appt({ start: "not-a-date", patientName: "Nadia Lamprell" }));
    expect(line).toBe("N.Lamprell");
    expect(line).not.toContain(":");
  });
});

describe("blockBodyText", () => {
  it("joins funding, the type label, the raw reason and the note with single spaces", () => {
    const text = blockBodyText(
      appt({ reason: "Hygienist", note: "needs pre med, check with dentist" }),
      "nhs",
    );
    expect(text).toBe("NHS Hygienist needs pre med, check with dentist");
  });

  it("prints the raw reason beside the label when the two say different things", () => {
    // "Check up" canonicalises onto the "Checkup" row, so the practice's own
    // wording is kept alongside the tidy label rather than being overwritten.
    const text = blockBodyText(appt({ reason: "Check up", note: null }), "private");
    expect(text).toBe("Private Checkup Check up");
  });

  it("does not print the reason twice when it already equals its label", () => {
    expect(blockBodyText(appt({ reason: "Extraction", note: null }), "unknown")).toBe("Extraction");
    // A pure difference of case is not a difference worth printing twice.
    expect(blockBodyText(appt({ reason: "scale & polish", note: null }), "private")).toBe(
      "Private Scale & Polish",
    );
  });

  it("omits unresolvable funding entirely, so nothing can be read as a fact", () => {
    const text = blockBodyText(appt({ reason: "Examination", note: null }), "unknown");
    expect(text).toBe("Examination");
    expect(text.toLowerCase()).not.toContain("unknown");
  });

  it("returns an empty string when there is genuinely nothing to say", () => {
    expect(blockBodyText(appt({ reason: null, note: null }), "unknown")).toBe("");
  });

  it("keeps an unrecognised reason verbatim rather than inventing a tidy name", () => {
    expect(blockBodyText(appt({ reason: "Denture reline", note: null }), "unknown")).toBe(
      "Denture reline",
    );
  });
});

describe("ruleMarks", () => {
  const bounds = { startMin: 540, endMin: 660 }; // 09:00 to 11:00

  it("emits three DISJOINT sets: an hour is never also a half, a half never a quarter", () => {
    const { quarters, halves, hours } = ruleMarks(bounds);
    expect(hours).toEqual([540, 600, 660]);
    expect(halves).toEqual([570, 630]);
    for (const m of quarters) {
      expect(m % 30).not.toBe(0);
      expect(m % 60).not.toBe(0);
    }
    const all = [...quarters, ...halves, ...hours];
    expect(new Set(all).size).toBe(all.length);
  });

  it("rules the QUARTER hour, which is the reference's slot, and nothing finer", () => {
    // The correction. A rule every five minutes is a rule every 12px at Normal
    // and every 8px at Compact: a grey wash rather than a grid, and the loudest
    // thing on the screen beside Dentally's own diary. Nine marks across two
    // hours, not twenty-five.
    const { quarters, halves, hours } = ruleMarks(bounds);
    expect([...quarters, ...halves, ...hours].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 9 }, (_, i) => 540 + i * 15),
    );
    expect(quarters).toEqual([555, 585, 615, 645]);
  });

  it("does not vary with the row height: 15 minutes is countable at every zoom", () => {
    // The five minute rules had to be SUPPRESSED at compact, where 8px apart is
    // moire. At 15 minutes compact is 24px, so there is nothing left to suppress
    // and the zoom argument is gone rather than being carried and ignored.
    expect(ruleMarks(bounds)).toEqual(ruleMarks({ ...bounds }));
  });

  it("returns empty sets for unusable bounds rather than looping", () => {
    expect(ruleMarks({ startMin: Number.NaN, endMin: 600 })).toEqual({
      quarters: [],
      halves: [],
      hours: [],
    });
  });
});

describe("parseSpan / multidaySpanKeys", () => {
  it("offers 3, 5 and 7 and defaults to 5 for anything else", () => {
    expect(MULTIDAY_SPANS).toEqual([3, 5, 7]);
    expect(parseSpan("3")).toBe(3);
    expect(parseSpan("5")).toBe(5);
    expect(parseSpan("7")).toBe(7);
    expect(parseSpan("4")).toBe(5);
    expect(parseSpan("")).toBe(5);
    expect(parseSpan(null)).toBe(5);
    expect(parseSpan("rubbish")).toBe(5);
  });

  it("runs FORWARD from the anchor and is never week-aligned", () => {
    // 2026-08-05 is a Wednesday. Week-aligning would throw the reader back to
    // Monday the 3rd, which is not what the reference's own URL does.
    expect(multidaySpanKeys("2026-08-05", 5)).toEqual([
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
      "2026-08-09",
    ]);
  });

  it("crosses a month boundary correctly", () => {
    expect(multidaySpanKeys("2026-07-31", 3)).toEqual(["2026-07-31", "2026-08-01", "2026-08-02"]);
  });

  it("clamps the span to 1..7 and returns nothing for an unparseable anchor", () => {
    expect(multidaySpanKeys("2026-08-05", 0)).toHaveLength(1);
    expect(multidaySpanKeys("2026-08-05", 99)).toHaveLength(7);
    expect(multidaySpanKeys("nonsense", 5)).toEqual([]);
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
