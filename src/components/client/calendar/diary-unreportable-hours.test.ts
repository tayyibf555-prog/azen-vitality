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
import {
  COLUMN_WORK_PRESENTATION,
  type ColumnWorkState,
  type Span,
} from "@/lib/calendar/working-spans";
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

function renderDay(col: DayColumnInput, opts: { hoursPending?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(DiaryDay, {
      columns: [col],
      bounds: BOUNDS,
      zoom: "normal" as const,
      ariaLabel: "Diary",
      soloKey: null,
      onSolo: noop,
      hoursPending: opts.hoursPending ?? false,
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

function renderDays(
  day: Partial<DayColumnDayInput> = {},
  opts: { hoursPending?: boolean } = {},
): string {
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
      hoursPending: opts.hoursPending ?? false,
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

/**
 * The weight and colour the header's SECOND LINE is set in, lifted out of the
 * rendered class list. Both grids build this span from the same three base classes,
 * so one regex reads either of them.
 *
 *   "font-semibold text-ink"     LOUD    -- this column needs a human
 *   "font-semibold text-muted"   quiet   -- "Not working": emphatic, but not a problem
 *   "font-medium text-muted"     quiet   -- ordinary
 */
function summaryWeight(html: string): string | null {
  const m = html.match(/class="block truncate text-\[10px\] leading-\[1\.25\] tabular-nums ([^"]*)"/);
  return m ? m[1] : null;
}

const LOUD = "font-semibold text-ink";

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

// ===========================================================================
// EVERY state's words, in BOTH grids, iterated from the mapping itself.
//
// The one above pins "unreportable" because that is the state this file was
// written for. This pins all six, and it is derived rather than listed: the day
// grid and the week grid each used to carry their own ternary chain of the same
// six sentences, synchronised by a comment, so the pair could drift on any state
// and a SEVENTH state would have fallen out of the bottom of both and printed
// "Not working" -- grey, and a claim that a clinician was off, from a union
// member nobody had taught the grids about. Both now read
// COLUMN_WORK_PRESENTATION, and this walks it: add a state to the union and it
// is a compile error in working-spans.ts; point one grid back at words of its
// own and one of these goes red by name.
// ===========================================================================
describe("the words for a work state, in both grids at once", () => {
  const STATES = Object.keys(COLUMN_WORK_PRESENTATION) as ColumnWorkState[];

  for (const state of STATES) {
    const shown = COLUMN_WORK_PRESENTATION[state];
    // "working" has no sentence: it prints the counts, and an empty column's
    // count line is the one this suite's fixtures produce.
    const expected = shown.label ?? "Nothing booked";

    it(`says "${expected}" for "${state}" in the day view and the day-per-column views alike`, () => {
      const day = renderDay(column({ workState: state }));
      const week = renderDays({ workState: state });
      expect(day, `day view does not say "${expected}"`).toContain(expected);
      expect(week, `week view does not say "${expected}"`).toContain(expected);

      // And says NOTHING ELSE from the mapping. Two states sharing a screen is
      // how six states collapse back into "we could not read it" or "they are
      // off", which is the distinction the whole union exists to hold.
      for (const other of STATES) {
        const otherLabel = COLUMN_WORK_PRESENTATION[other].label;
        if (otherLabel === null || otherLabel === expected) continue;
        expect(day, `day view for "${state}" also says "${otherLabel}"`).not.toContain(otherLabel);
        expect(week, `week view for "${state}" also says "${otherLabel}"`).not.toContain(otherLabel);
      }

      // The texture is the other half of the claim, and it comes from the same
      // row of the same mapping: hatched states must never be grey, because grey
      // is a positive claim that somebody was not working.
      expect(hatches(day) > 0, `day view hatch for "${state}"`).toBe(shown.hatched);
      expect(hatches(week) > 0, `week view hatch for "${state}"`).toBe(shown.hatched);
      if (shown.hatched) {
        expect(offLabels(day), `day view prints "Off" for "${state}"`).toBe(0);
        expect(offLabels(week), `week view prints "Off" for "${state}"`).toBe(0);
      }
    });
  }
});

// ===========================================================================
// AND THE OTHER HALF OF THE HEADER: WHICH STATES SHOUT.
//
// The words came from COLUMN_WORK_PRESENTATION; the WEIGHT did not. It was a
// byte-identical or-chain in each grid --
//
//     (state === "unknown" && !hoursPending) || state === "unconfirmed"
//
// -- which is the same non-exhaustive shape the words were rescued from, one
// property later, and with a worse failure: a seventh state falling out of the
// bottom of a ternary chain at least printed VISIBLE nonsense, while one falling
// out of these renders correct words in a quiet grey. A state that exists because
// something needs attention would have been added, worded carefully, and then
// whispered on both screens.
//
// This walks the mapping and asserts the pair agree, per state, in both settled
// and pending readings. It is the mutation test too: flip one `loud` in the Record
// and BOTH grids change together, which is exactly the coupling that was missing.
// ===========================================================================
describe("which states shout, in both grids at once", () => {
  const STATES = Object.keys(COLUMN_WORK_PRESENTATION) as ColumnWorkState[];

  for (const state of STATES) {
    const shown = COLUMN_WORK_PRESENTATION[state];

    // hoursPending is the availability read still being in flight. Only "unknown"
    // is allowed to care: a failure sentence flashing on every day change is the
    // false alarm the pendingLabel exists to avoid.
    for (const hoursPending of [false, true]) {
      const expectedLoud =
        shown.loud === "whenHoursSettled" ? !hoursPending : shown.loud;
      const how = hoursPending ? "while the hours are still loading" : "once the hours have settled";

      it(`"${state}" is ${expectedLoud ? "LOUD" : "quiet"} ${how}, in both grids`, () => {
        const day = summaryWeight(renderDay(column({ workState: state }), { hoursPending }));
        const week = summaryWeight(renderDays({ workState: state }, { hoursPending }));

        expect(day, "the day grid's header line was not found at all").not.toBeNull();
        expect(week, "the week grid's header line was not found at all").not.toBeNull();
        expect(day === LOUD, `day view loudness for "${state}"`).toBe(expectedLoud);
        expect(week === LOUD, `week view loudness for "${state}"`).toBe(expectedLoud);
        // The pair, stated directly: the two grids must not merely each be right,
        // they must be the SAME, because drifting apart is the defect this closes.
        expect(week, `the grids disagree about "${state}"`).toBe(day);
      });
    }
  }

  // The three states that were loud before this moved into the Record, named
  // rather than derived, so the migration is pinned as byte-identical rather than
  // pinned against itself.
  it("shouts for exactly the states it shouted for before", () => {
    const loudNow = STATES.filter(
      (s) => summaryWeight(renderDay(column({ workState: s }))) === LOUD,
    );
    expect(loudNow).toEqual(["unknown", "unconfirmed"]);
    // ...and "unknown" alone falls silent while the read is in flight.
    const loudPending = STATES.filter(
      (s) => summaryWeight(renderDay(column({ workState: s }), { hoursPending: true })) === LOUD,
    );
    expect(loudPending).toEqual(["unconfirmed"]);
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
