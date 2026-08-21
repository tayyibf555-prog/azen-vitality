// ===========================================================================
// THE HOURS NOBODY COULD ASK ABOUT, AS THE GRID ACTUALLY PAINTS THEM.
//
// THE BUG THIS PINS, seen by the practice every single afternoon. Dentally
// answers availability only from a start time in the future, so the diary's
// question about TODAY is clamped to now+2min and every window that had already
// closed is missing from the answer. A clinician rostered 09:00-13:00 with
// nothing booked therefore came back empty from lunchtime onwards, and an empty
// answer collapsed to grey with the word "Off" printed down it: a positive claim
// that somebody was not working, made about hours nobody was able to ask about.
//
// Two things have to be true on the grid, and neither is provable from the state
// machine alone:
//
//   THE COLUMN  a clinician with nothing at all in the answer must not read
//               "Not working". It hatches and says its own sentence.
//   THE STRIP   even on a column that IS working -- rescued by one booking, or
//               by an afternoon session that did come back -- the elapsed part
//               of the day must not wear the word "Off".
//
// TECHNIQUE. vitest collects only src/**/*.test.ts in a node environment, so the
// components are mounted with createElement + renderToStaticMarkup, exactly as
// the other component suites here do it.
// ===========================================================================
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Span } from "@/lib/calendar/working-spans";
import { DiaryDay, type DayColumnInput } from "./diary-day";
import { DiaryDays, type DayColumnDayInput } from "./diary-week";

const BOUNDS = { startMin: 480, endMin: 1200 }; // 08:00 - 20:00
/** 15:02 London: the clamped start of a diary read taken at three o'clock. */
const AFTERNOON = 15 * 60 + 2;
/** One booked appointment, 10:00-10:30, as a working span. */
const MORNING_BOOKING: Span = { startMin: 600, endMin: 630 };

const noop = () => {};

function column(over: Partial<DayColumnInput> = {}): DayColumnInput {
  return {
    key: "prac-1",
    id: "prac-1",
    name: "Jin Kim",
    appointments: [],
    workState: "working",
    workingSpans: [],
    entries: [],
    ...over,
  };
}

function renderDay(col: DayColumnInput): string {
  return renderToStaticMarkup(
    createElement(DiaryDay, {
      columns: [col],
      bounds: BOUNDS,
      zoom: "normal" as const,
      ariaLabel: "Diary",
      soloKey: null,
      onSolo: noop,
      countsUnavailable: false,
      funding: {},
      nowTop: null,
      nowLabel: null,
      focusedId: null,
      onFocusItem: noop,
      onOpen: noop,
      onKeyDown: noop,
      describedById: "d",
    }),
  );
}

function renderDays(day: Partial<DayColumnDayInput> = {}): string {
  const input: DayColumnDayInput = {
    dayKey: "2026-07-31",
    appointments: [],
    inWindow: true,
    isToday: true,
    nowTop: null,
    workState: "working",
    workingSpans: [],
    entries: [],
    ...day,
  };
  return renderToStaticMarkup(
    createElement(DiaryDays, {
      days: [input],
      clinicianName: "Jin Kim",
      bounds: BOUNDS,
      zoom: "normal" as const,
      ariaLabel: "Diary",
      countsUnavailable: false,
      funding: {},
      onPickDay: noop,
      focusedId: null,
      onFocusItem: noop,
      onOpen: noop,
      onKeyDown: noop,
      describedById: "d",
      selectedDay: "2026-07-31",
    }),
  );
}

/** How many times the word "Off" is printed as a label in the column body. */
function offLabels(html: string): number {
  return html.split(">Off<").length - 1;
}

/** The hatch: the one texture that means "we do not have an answer". */
function hatches(html: string): number {
  return html.split("repeating-linear-gradient(45deg").length - 1;
}

describe("the column for a clinician whose whole answer went unasked", () => {
  it("does NOT say 'Not working' about a morning nobody could ask about", () => {
    const html = renderDay(
      column({ workState: "unreportable", answerableFromMin: AFTERNOON }),
    );
    expect(html).toContain("Hours not reportable");
    expect(html).not.toContain("Not working");
    // And not the past-day sentence either: the date is today.
    expect(html).not.toContain("Date has passed");
  });

  it("hatches rather than greys, so nothing claims they were off", () => {
    const html = renderDay(
      column({ workState: "unreportable", answerableFromMin: AFTERNOON }),
    );
    expect(hatches(html)).toBeGreaterThan(0);
    expect(offLabels(html)).toBe(0);
  });

  it("says the same words in the day-per-column views, which draw this independently", () => {
    const html = renderDays({ workState: "unreportable", answerableFromMin: AFTERNOON });
    expect(html).toContain("Hours not reportable");
    expect(html).not.toContain("Not working");
  });

  it("still says 'Not working' when the whole day WAS answerable", () => {
    // The contrast that proves the new wording is doing work rather than
    // replacing the old: a day asked about in full and answered with nothing
    // really does mean the clinician is not in, and grey is honest there.
    const html = renderDay(column({ workState: "off" }));
    expect(html).toContain("Not working");
    expect(html).not.toContain("Hours not reportable");
  });
});

describe("the elapsed strip on a column that IS working", () => {
  it("does not print 'Off' over hours that were never asked about", () => {
    // One booking at 10:00 rescues the column to "working". The grey above and
    // below it used to carry the word "Off" all the way from 08:00, which is a
    // claim about a morning the read never covered.
    const html = renderDay(
      column({ workingSpans: [MORNING_BOOKING], answerableFromMin: AFTERNOON }),
    );
    // Exactly one label survives: the stretch from 15:02 to 20:00, which we did
    // ask about and which really did come back empty.
    expect(offLabels(html)).toBe(1);
    // Both unasked stretches -- 08:00-10:00 and 10:30-15:02 -- take the hatch.
    expect(hatches(html)).toBe(2);
  });

  it("labels every off stretch as before when the day was answered in full", () => {
    // The same column with no clamp: two grey fields, two labels, no hatch. This
    // is the shape every future day has, and it must not have changed.
    const html = renderDay(column({ workingSpans: [MORNING_BOOKING] }));
    expect(offLabels(html)).toBe(2);
    expect(hatches(html)).toBe(0);
  });

  it("holds in the day-per-column views too", () => {
    const html = renderDays({
      workingSpans: [MORNING_BOOKING],
      answerableFromMin: AFTERNOON,
    });
    expect(offLabels(html)).toBe(1);
    expect(hatches(html)).toBe(2);
  });

  it("keeps the working column reading as working, counts and all", () => {
    // The union rescue is the whole reason a day with anything booked is
    // untouched by this: it must still be a plain working column.
    const html = renderDay(
      column({ workingSpans: [MORNING_BOOKING], answerableFromMin: AFTERNOON }),
    );
    expect(html).not.toContain("Hours not reportable");
    expect(html).not.toContain("Not working");
  });
});

describe("the board's wiring, which is what makes any of this reach the grid", () => {
  // Read from SOURCE because the wiring lives in a React closure inside a client
  // component this node-environment suite cannot mount, exactly as move-copy's
  // own board assertion does it. Both halves matter and they fail differently:
  // drop the first and every morning column silently claims "Not working" again;
  // drop the second and the column is right while the strip inside it still wears
  // the word "Off" over hours nobody asked about.
  const board = readFileSync(
    fileURLToPath(new URL("./calendar-board.tsx", import.meta.url)),
    "utf8",
  );

  it("hands the minute to columnWorkState, so an empty answer cannot read as 'off'", () => {
    const call = /columnWorkState\(\{([\s\S]*?)\}\)/.exec(board);
    expect(call, "calendar-board no longer calls columnWorkState").not.toBeNull();
    expect((call as RegExpExecArray)[1]).toMatch(/\banswerableFromMin\b/);
  });

  it("hands the same minute on to the columns, so the grids can paint the strip", () => {
    expect(board).toContain("diaryDay.answerableFromMin");
    expect(board).toMatch(/return \{[\s\S]{0,120}answerableFromMin,/);
  });
});
