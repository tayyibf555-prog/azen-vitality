// ===========================================================================
// THE CARD, AS THE GRID ACTUALLY DRAWS IT.
//
// THE DEFECT THIS PINS, seen beside Dentally's own diary on 22 August 2026. One
// clinician's column, 112px wide, holding sixteen bookings and nineteen
// cancellations and no-shows between them. What the practice got was a picket
// fence: blocks 28px wide, of which 39px of chrome had already been spent, so
// nothing legible was drawn on any of them. Dentally drew the same day as a
// column of full-width cards with a time, a name and a treatment on each.
//
// The lane arithmetic that caused it is pinned in diary-grid.test.ts. THIS pins
// what a reader actually sees at each width, because a lane count that is right
// and a card that still cannot carry a name is the same defect one layer down.
//
// TECHNIQUE. vitest collects only src/**/*.test.ts in a node environment, so the
// components are mounted with createElement + renderToStaticMarkup, exactly as
// the other component suites here do it.
// ===========================================================================
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiaryDay, type DayColumnInput } from "./diary-day";
import { RECOVERABLE_STRIP_PX } from "./diary-grid";
import { COL_MIN_PX, type DiaryAppointment } from "./diary-view";

const BOUNDS = { startMin: 480, endMin: 1200 }; // 08:00 - 20:00
const noop = () => {};

let seq = 0;
function appt(over: Partial<DiaryAppointment> = {}): DiaryAppointment {
  seq += 1;
  return {
    id: `a${seq}`,
    patientId: `p${seq}`,
    patientName: "Nadia Lamprell",
    start: "2026-07-30T08:30:00Z", // 09:30 London (BST)
    finish: null,
    durationMin: 30,
    state: "confirmed",
    reason: "Scale & Polish",
    note: null,
    practitioner: "Jin Kim",
    practitionerId: "prac-1",
    ...over,
  };
}

function render(appointments: DiaryAppointment[]): string {
  const col: DayColumnInput = {
    key: "prac-1",
    id: "prac-1",
    name: "Jin Kim",
    appointments,
    workState: "working",
    workingSpans: [{ startMin: 480, endMin: 1200 }],
    entries: [],
  };
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

/** The style attribute of the <li> that carries this appointment id. */
function blockStyleOf(html: string, id: string): string {
  const m = new RegExp(`<li[^>]*data-diary-block="${id}"[^>]*style="([^"]*)"`).exec(html);
  if (m) return m[1];
  // React may emit style before the data attribute; try the other order.
  const n = new RegExp(`<li[^>]*style="([^"]*)"[^>]*data-diary-block="${id}"`).exec(html);
  return n ? n[1] : "";
}

/** The VISIBLE text of a block, with the screen-reader sentence stripped out. */
function blockText(html: string, id: string): string {
  const open = html.indexOf(`data-diary-block="${id}"`);
  if (open === -1) return "";
  const end = html.indexOf("</li>", open);
  return html
    .slice(open, end)
    .replace(/<span class="sr-only">[\s\S]*?<\/span>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("a card with the column to itself", () => {
  const html = render([appt({ id: "solo", patientName: "Nadia Lamprell" })]);

  it("carries the time, the patient and the treatment, which is Dentally's card", () => {
    const text = blockText(html, "solo");
    expect(text).toContain("09:30");
    expect(text).toContain("N.Lamprell");
    expect(text).toContain("Scale & Polish");
  });

  it("takes the whole width, with no leftover slot and no clash seam", () => {
    const style = blockStyleOf(html, "solo");
    expect(style).toContain("width:calc(1 * 100% / 1)");
    expect(style).toContain("left:calc(0 * 100% / 1)");
    // The navy seam means "there is another booking beside this one". There is not.
    expect(html).not.toContain("absolute inset-y-0 right-0 w-[3px] bg-navy");
  });
});

describe("a card sharing its hour with one other", () => {
  const html = render([
    appt({ id: "left", patientName: "Nadia Lamprell", durationMin: 60 }),
    appt({ id: "right", patientName: "Femi Osei", durationMin: 30 }),
  ]);

  it("leads with the TIME, which is never ambiguous, and names the patient below", () => {
    // The correction. Half a 112px column is 56px, and the old chrome spent 39 of
    // them on padding: what it printed was "09:3", a time that is not a time,
    // above a patient nobody could name. Two short lines carry both.
    const text = blockText(html, "left");
    expect(text).toContain("09:30");
    expect(text).toContain("N.Lamprell");
    // The treatment line is what gives way at this width, not the patient.
    expect(text).not.toContain("Scale & Polish");
  });

  it("splits the column exactly in two", () => {
    expect(blockStyleOf(html, "left")).toContain("width:calc(1 * 100% / 2)");
    expect(blockStyleOf(html, "right")).toContain("width:calc(1 * 100% / 2)");
  });

  it("draws the navy seam on the block that HAS a neighbour to its right", () => {
    expect(html).toContain("absolute inset-y-0 right-0 w-[3px] bg-navy");
  });
});

describe("a cancellation that shares its hour with a real booking", () => {
  const html = render([
    appt({ id: "coming-in", patientName: "Nadia Lamprell" }),
    appt({ id: "called-off", patientName: "Femi Osei", state: "cancelled" }),
  ]);

  it("leaves the patient who is coming in all but the tab's own width", () => {
    // The card RESERVES the tab's 14px rather than being painted under it. A tab
    // drawn over a full-width card takes that card's state mark and the end of
    // the patient's name with it, which would have swapped one unreadable block
    // for another.
    const style = blockStyleOf(html, "coming-in");
    expect(style).toContain(`width:calc(1 * 100% / 1 - ${RECOVERABLE_STRIP_PX}px)`);
    expect(blockText(html, "coming-in")).toContain("N.Lamprell");
  });

  it("is drawn as a slim tab at the column's edge, not as half the column", () => {
    const style = blockStyleOf(html, "called-off");
    expect(style).toContain("right:0");
    expect(style).toContain(`width:${RECOVERABLE_STRIP_PX}px`);
    expect(RECOVERABLE_STRIP_PX).toBeLessThan(COL_MIN_PX / 4);
  });

  it("never loses the cancelled patient: the full sentence is still announced", () => {
    // Dentally takes cancellations out of the diary altogether. We keep a trace,
    // and the trace is still a real, focusable, announced appointment.
    expect(html).toContain("data-diary-block=\"called-off\"");
    expect(html).toContain("Femi Osei.");
    expect(html).toContain("Cancelled");
  });
});

describe("a fourth booking in the same half hour", () => {
  const html = render([
    appt({ id: "one" }),
    appt({ id: "two" }),
    appt({ id: "three" }),
    appt({ id: "four" }),
  ]);

  it("is stepped in front of the last slot rather than shredding the other three", () => {
    for (const id of ["one", "two", "three"]) {
      expect(blockStyleOf(html, id)).toContain("width:calc(1 * 100% / 3)");
    }
    // The overflow keeps the slot's width and is stepped 5px into it, stacked in
    // front. A quarter-width column carries nothing at all; this at least carries
    // its colour, its mark and its click target.
    const over = blockStyleOf(html, "four");
    expect(over).toContain("width:calc(1 * 100% / 3)");
    expect(over).toContain("+ 5px");
    expect(over).toContain("z-index:1");
  });

  it("draws all four, because a hidden appointment is a missed patient", () => {
    for (const id of ["one", "two", "three", "four"]) {
      expect(html, `${id} was not drawn`).toContain(`data-diary-block="${id}"`);
    }
  });
});

describe("a run of back-to-back bookings, which is the ordinary case", () => {
  const html = render(
    Array.from({ length: 8 }, (_, i) =>
      appt({
        id: `seq-${i}`,
        patientName: `Patient Number${i}`,
        start: `2026-07-30T${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 === 0 ? "00" : "30"}:00Z`,
      }),
    ),
  );

  it("gives every one of them the full column and a readable card", () => {
    for (let i = 0; i < 8; i += 1) {
      const style = blockStyleOf(html, `seq-${i}`);
      expect(`seq-${i}: ${style}`).toContain("width:calc(1 * 100% / 1)");
      expect(blockText(html, `seq-${i}`)).toContain(`P.Number${i}`);
    }
  });
});
