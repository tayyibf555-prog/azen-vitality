// ===========================================================================
// THE PLAN PANEL, PROVED BY RENDER.
//
// WHY THIS FILE EXISTS. Three passes on this feature have now produced the same
// defect: every test green, and the pixels unchanged or wrong. Blank surfaces
// shipped that way. Unparsed Palmer teeth shipped that way. Both were caught
// late, by looking at a screen, because the units under them all agreed with
// each other about a contract nobody had rendered.
//
// So this renders the real components — the panel, its cards, its rows and its
// footer — through react-dom/server against a fixture with the LIVE
// distribution, and reads the markup. It is the only test in this feature that
// can fail when the logic is right and the screen is still wrong.
//
// A .ts FILE AND NO JSX, exactly as disabled-controls.test.ts is and for the
// same reason: vitest collects src/ ** / *.test.ts in a node environment and
// never a .tsx. Everything here is built with createElement. That is also a
// second, quieter assertion — this whole subtree renders with no DOM, which is
// what "server-safe" means, and is the property boundary.test.ts pins from the
// source side.
// ===========================================================================

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { PlanPanel } from "@/components/client/patients/record/chart/plan-panel";
import { CHART_COPY } from "@/lib/patient/tabs";
import { buildPlanPanel, type PlanAppointment, type PlanHeader, type PlanPanelItem } from "./plan-panel";
import type { PlanCardHeader } from "@/lib/dentally/charting-read";
import { toPlanPanelView, type PlanPanelSource, type PlanPanelViewModel } from "./plan-panel-view";

// --- Fixtures --------------------------------------------------------------

function item(over: Partial<PlanPanelItem> & { id: string }): PlanPanelItem {
  return {
    teeth: [],
    rawTeeth: "",
    surfaces: [],
    rawSurfaces: "",
    surfaceIndices: [],
    unrecognisedSurfaces: [],
    wholeTooth: false,
    region: null,
    baseChart: false,
    completed: false,
    completedAt: null,
    charged: false,
    notes: null,
    nomenclature: "Composite Filling",
    price: 0,
    value: 0,
    durationMin: 15,
    nhsTreatmentCat: null,
    udaBand: null,
    position: 0,
    planId: "688300",
    treatmentId: null,
    practitionerId: null,
    paymentPlanId: 2,
    createdAt: "2026-01-04T09:00:00Z",
    updatedAt: "2026-07-30T09:00:00Z",
    treatmentAppointmentId: null,
    pricePence: 1000,
    ...over,
  };
}

const PLAN: PlanHeader = {
  id: "688300",
  nickname: "Upper right quadrant",
  completed: false,
  completedAt: null,
  startDate: "2026-01-04",
  endDate: null,
  paymentPlanId: 2,
  practitionerId: null,
  privateTreatmentValuePence: 12_500,
  nhsUdaHundredths: 300,
  nhsCompletedUdaHundredths: 100,
};

const CARD: PlanAppointment = {
  id: "ta-1",
  position: 0,
  appointmentId: "appt-1",
  notes: "Bring the shade guide.",
  bookable: true,
};

const CARD_HEADER: PlanCardHeader = {
  treatmentAppointmentId: "ta-1",
  appointmentId: "appt-1",
  start: "2026-08-02T15:00:00Z",
  finish: "2026-08-02T15:45:00Z",
  durationMin: 45,
  state: "booked",
  practitioner: "Zara Hussain",
  practitionerId: "prac-1",
  unresolvedReason: null,
};

/** THE LIVE SHAPE: 18 items, 3 of them on the one card. 17%, as production. */
const CARDED_IDS = ["i-1", "i-2", "i-3"];
const LOOSE_IDS = Array.from({ length: 15 }, (_, n) => `i-${n + 4}`);

function source(): PlanPanelSource {
  const carded: PlanPanelItem[] = [
    item({
      id: "i-1",
      treatmentAppointmentId: "ta-1",
      teeth: [16],
      surfaceIndices: [3, 8],
      pricePence: 4500,
      durationMin: 30,
      nomenclature: "RCT stage 1",
      practitionerId: "prac-1",
    }),
    item({
      id: "i-2",
      treatmentAppointmentId: "ta-1",
      pricePence: 0,
      durationMin: 15,
      paymentPlanId: 1,
      nomenclature: "Urgent Assessment - Problem Focused",
      udaBand: "1",
    }),
    item({
      id: "i-3",
      treatmentAppointmentId: "ta-1",
      pricePence: 1250,
      durationMin: 10,
      nomenclature: "Intraoral Periapical Image",
      completed: true,
      completedAt: "2026-08-02T15:10:00Z",
    }),
  ];
  const loose = LOOSE_IDS.map((id, n) =>
    item({ id, pricePence: 1000, durationMin: 5, position: n, nomenclature: `Loose treatment ${n + 1}` }),
  );
  return {
    model: buildPlanPanel({ plan: PLAN, appointments: [CARD], items: [...carded, ...loose] }),
    cardHeaders: { "ta-1": CARD_HEADER },
    practitioners: {},
    synthetic: false,
  };
}

function view(): PlanPanelViewModel {
  return toPlanPanelView(source());
}

function render(model: PlanPanelViewModel | null, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(PlanPanel, { plan: model, ...props }));
}

// --- Markup helpers --------------------------------------------------------

function idsIn(html: string): string[] {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
}

function describedByTargets(html: string): string[] {
  return [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
}

/** The text inside the element carrying this id. */
function textOfElementWithId(html: string, id: string): string | null {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const open = html.indexOf(">", at);
  const close = html.indexOf("<", open);
  if (open < 0 || close < 0) return null;
  return html.slice(open + 1, close);
}

/** Tags stripped, entities undone enough to search for a sentence. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&middot;/g, "-")
    .replace(/\s+/g, " ");
}

// ===========================================================================

describe("the panel actually renders every row it was handed", () => {
  const html = render(view());

  it("renders a row for all 18 items, not the 3 that have an appointment", () => {
    // The completed affordance carries the row id, so its presence is proof that
    // the row itself reached the DOM. This is the assertion that fails the day
    // somebody renders model.groups.filter(kind === "appointment").
    for (const id of [...CARDED_IDS, ...LOOSE_IDS]) {
      expect(html, `row ${id} is missing from the rendered panel`).toContain(
        `chart-plan-688300-unassigned-complete-${id}"`.replace(
          "unassigned",
          CARDED_IDS.includes(id) ? "appt-ta-1" : "unassigned",
        ),
      );
    }
  });

  it("renders the unassigned card, titled, tinted and counted", () => {
    const plain = text(html);
    expect(plain).toContain("Not on an appointment");
    // The count is the fact. Fifteen of eighteen.
    expect(plain).toContain("15 items");
    // The amber tint this screen already uses for "read before you rely on it".
    expect(html).toContain("border-tint-amber-line");
  });

  it("renders the COUNTED reason sentence and the standing one, both in full", () => {
    const plain = text(html);
    expect(plain).toContain("15 items are not attached to an appointment in Dentally");
    expect(plain).toContain("They are listed here in full.");
    expect(plain).toContain("reads as work that has been booked");
  });

  it("puts the unassigned card AFTER the appointment cards, never folded into one", () => {
    expect(html.indexOf("Not on an appointment")).toBeGreaterThan(html.indexOf("Appt. 1"));
    // And the appointment card holds exactly its own three rows.
    const cardStart = html.indexOf("chart-plan-688300-appt-ta-1");
    const bucketStart = html.indexOf("chart-plan-688300-unassigned");
    const cardHtml = html.slice(cardStart, bucketStart);
    for (const id of LOOSE_IDS) {
      expect(cardHtml, `loose row ${id} was rendered inside the appointment card`).not.toContain(
        `-complete-${id}"`,
      );
    }
  });

  it("says 'Appt. 1' for position 0, and never invents a number", () => {
    expect(text(html)).toContain("Appt. 1");
  });

  it("does not dress the unassigned group up as an appointment", () => {
    // FOUND BY READING THE RENDERED MARKUP, not by a unit test: the bucket was
    // rendering an appointment's note row and an appointment's overflow menu, so a
    // group that is by definition NOT an appointment carried the line "There is no
    // note on this appointment in Dentally" and a control labelled "More actions for
    // this appointment". Both are claims about a Dentally record that does not exist.
    const bucket = html.slice(html.indexOf("chart-plan-688300-unassigned"));
    expect(bucket).not.toContain("There is no note on this appointment");
    expect(bucket).not.toContain("More actions for this appointment");
    expect(bucket).not.toContain("Dictate this note");
    // The appointment card, which does have those records, still has all three.
    const card = html.slice(0, html.indexOf("chart-plan-688300-unassigned"));
    expect(card).toContain("More actions for this appointment");
    expect(card).toContain("Dictate this note");
  });
});

describe("what the cells say", () => {
  const html = render(view());
  const plain = text(html);

  it("prints the tooth in FDI, converted by the library", () => {
    expect(plain).toContain("UR6");
  });

  it("prints the treatment names Dentally sent", () => {
    expect(plain).toContain("RCT stage 1");
    expect(plain).toContain("Urgent Assessment - Problem Focused");
    expect(plain).toContain("Loose treatment 15");
  });

  it("prints the card's date and clinician, taken from the diary", () => {
    expect(plain).toContain("Zara Hussain");
    // A London wall-clock label built from the ISO instant the read captured.
    expect(plain).toMatch(/Sun 2 Aug/);
  });

  it("prints the appointment note, and never a 'last updated' age for it", () => {
    expect(plain).toContain("Bring the shade guide.");
    expect(plain).not.toContain("Last updated");
    expect(plain).not.toContain("minutes ago");
  });

  it("badges NHS and Private per row, and nothing at all for an unresolved plan", () => {
    expect(plain).toContain("NHS");
    expect(plain).toContain("Private");
    expect(plain).not.toContain("Unknown");
  });

  it("prints Dentally's surface NUMBERS, never a named anatomy", () => {
    expect(plain).toContain("surfaces 3, 8");
    expect(plain).not.toContain("disto-buccal");
  });
});

// ===========================================================================
// THE CLINICIAN COLUMN, MEASURED IN THE MARKUP.
//
// This column was EMPTY on every row of every card of all three panels a real
// patient renders, and no unit test noticed because two of them asserted the
// blank as correct. It is measured here the same way the bug was found: by
// reading the cells of a rendered row.
// ===========================================================================

/**
 * One row's cells, in COLUMN ORDER, as a reader's eye takes them: the eight
 * top-level children of the row grid, tags stripped.
 *
 * Written as a depth-tracking split rather than a span regex because two of the
 * eight cells now hold nested elements (the funding pill, and the practitioner
 * cell's marker plus its screen-reader sentence), and a flat regex silently
 * shifted every column after them — which is how a measurement of this table
 * reads "Private" out of the clinician column and calls the bug fixed.
 */
function topLevelChildren(inner: string): string[] {
  const VOID = new Set(["br", "img", "input", "hr", "meta", "link", "source"]);
  const out: string[] = [];
  const tag = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
  let depth = 0;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(inner)) !== null) {
    const closing = m[1] === "/";
    const selfClosing = VOID.has(m[2].toLowerCase()) || m[3].trimEnd().endsWith("/");
    if (closing) {
      depth -= 1;
      if (depth === 0) out.push(inner.slice(start, tag.lastIndex));
    } else {
      if (depth === 0) start = m.index;
      if (selfClosing) {
        if (depth === 0) out.push(inner.slice(m.index, tag.lastIndex));
      } else {
        depth += 1;
      }
    }
  }
  return out;
}

/** The cells of every item row, in column order. Cell 0 is the expand chevron and
 *  is always empty; 1 date, 2 tooth, 3 name, 4 PRACTITIONER, 5 funding,
 *  6 duration, 7 price. */
function rowCells(html: string): string[][] {
  return [
    ...html.matchAll(/<summary class="grid grid-cols-\[18px[^"]*"[^>]*>([\s\S]*?)<\/summary>/g),
  ].map((m) => topLevelChildren(m[1]).map((cell) => text(cell).trim()));
}

describe("the practitioner column", () => {
  /** A plan with NO appointment card at all: the 83% shape, and the one in which
   *  the old implementation could name nobody. */
  function cardlessView(practitioners: Record<string, string>): PlanPanelViewModel {
    return toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [],
        items: [
          item({ id: "n1", practitionerId: "prac-1", nomenclature: "Composite Filling" }),
          item({ id: "n2", practitionerId: "prac-none", nomenclature: "Crown - Porcelain" }),
          item({ id: "n3", practitionerId: null, nomenclature: "Study Models" }),
        ],
      }),
      cardHeaders: {},
      practitioners,
      synthetic: false,
    });
  }

  it("carries initials on a plan with no resolved card, which is 83% of live rows", () => {
    const cells = rowCells(render(cardlessView({ "prac-1": "Dana Hale" })));
    expect(cells).toHaveLength(3);
    // The row anatomy PLAN-PANEL.md:32 specifies, measured. Column 5 (index 4) is
    // the practitioner and it was "" on every row of every card of all three panels.
    expect(cells[0]).toEqual(["", "", "", "Composite Filling", "DH", "Private", "15 min", "£10.00"]);
  });

  it("marks a clinician it could not look up, rather than leaving the cell blank", () => {
    const cells = rowCells(render(cardlessView({ "prac-1": "Dana Hale" })));
    // Dentally named somebody on this line and we could not resolve them. A blank
    // here would say Dentally sent nothing, which is false.
    expect(cells[1][4]).toContain("?");
    expect(text(render(cardlessView({}))))
      .toContain("could not look up their name");
    // And the row that genuinely names nobody IS blank. Both states on one screen.
    expect(cells[2][4]).toBe("");
  });

  it("never prints the practitioner id itself", () => {
    const html = render(cardlessView({}));
    expect(html).not.toContain("prac-1");
    expect(html).not.toContain("prac-none");
  });
});

describe("money on the screen", () => {
  const html = render(view());
  const plain = text(html);

  it("renders the plan total as the sum of the rows, to the penny", () => {
    // 4500 + 0 + 1250 + 15 x 1000 = 20750.
    expect(plain).toContain("£207.50");
  });

  it("renders the card's own total, equal to the rows above it", () => {
    // 4500 + 0 + 1250 = 5750, and 30 + 15 + 10 = 55 minutes.
    expect(plain).toContain("£57.50");
    expect(plain).toContain("55 min");
  });

  it("renders a zero-price row as £0.00 rather than as an empty cell", () => {
    expect(plain).toContain("£0.00");
  });

  it("renders Uncharged even though it equals the total, which is the live reading", () => {
    expect(plain).toContain("Uncharged");
    expect(plain.match(/£207\.50/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("renders Dentally's own plan value beside our sum, not instead of it", () => {
    expect(plain).toContain("Private plan value");
    expect(plain).toContain("£125.00");
  });

  it("renders UDA as a plain decimal, with no pound sign anywhere near it", () => {
    expect(plain).toContain("NHS UDA");
    expect(plain).toContain("UDA completed");
    expect(plain).toContain("3.00");
    expect(plain).not.toContain("£3.00");
  });

  it("prints no money at all when the treatment plan LINES could not be read", () => {
    // With the items stream down there are no rows, so Total Price and Uncharged
    // were summed over nothing and printed a confident "£0.00 / £0.00" beside a
    // real private plan value: a positive claim about what a patient owes, made out
    // of a failed read. The read-level caveat above the panels is not enough, since
    // £0.00 is still a figure on the screen.
    const html = render(
      toPlanPanelView({
        model: buildPlanPanel({ plan: PLAN, appointments: [], items: [] }),
        cardHeaders: {},
        practitioners: {},
        synthetic: false,
      }),
      { itemsFailed: true },
    );
    const plain = text(html);
    expect(plain).not.toContain("£0.00");
    expect(plain).toContain("cannot be worked out");
    // Dentally's OWN figures come from a different stream and are still shown.
    expect(plain).toContain("Private plan value");
    expect(plain).toContain("£125.00");
  });

  it("still prints a genuine £0.00 when the lines read fine and came to nothing", () => {
    // A plan really worth nothing is an ordinary thing, and suppressing its zero
    // would be the mirror image of the bug above.
    const plain = text(
      render(
        toPlanPanelView({
          model: buildPlanPanel({
            plan: PLAN,
            appointments: [],
            items: [item({ id: "free", pricePence: 0 })],
          }),
          cardHeaders: {},
          practitioners: {},
          synthetic: false,
        }),
      ),
    );
    expect(plain).toContain("Total Price");
    expect(plain).toContain("£0.00");
  });

  it("never renders the string NaN, and says the card total is short instead", () => {
    // plan-panel.ts counts a row whose duration or price was not a finite number so
    // "the footer can caveat itself", and nothing carried the count: the row printed
    // "NaN min £NaN" while the footer silently excluded it and claimed nothing.
    const html = render(
      toPlanPanelView({
        model: buildPlanPanel({
          plan: PLAN,
          appointments: [],
          items: [
            item({ id: "bad", pricePence: Number.NaN, durationMin: Number.NaN }),
            item({ id: "ok", pricePence: 500, durationMin: 20 }),
          ],
        }),
        cardHeaders: {},
        practitioners: {},
        synthetic: false,
      }),
    );
    const plain = text(html);
    expect(plain).not.toContain("NaN");
    const cells = rowCells(html);
    expect(cells[0][6]).toBe("");
    expect(cells[0][7]).toBe("");
    // The remaining row still foots, and the card says which figures it left out.
    expect(plain).toContain("20 min");
    expect(plain).toContain("could not read");
    expect(plain).toContain("1 line on this card");
  });

  it("says a missing plan value is missing, and never prints it as £0.00", () => {
    const bare = toPlanPanelView({
      model: buildPlanPanel({
        plan: {
          ...PLAN,
          privateTreatmentValuePence: null,
          nhsUdaHundredths: null,
          nhsCompletedUdaHundredths: null,
        },
        appointments: [],
        items: [item({ id: "solo", pricePence: 100 })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    const out = text(render(bare));
    expect(out).toContain("Not given by Dentally");
    // The £1.00 row is real and is still printed; only the plan's own value is absent.
    expect(out).toContain("£1.00");
    // And a private plan with no UDA carries no permanent UDA caveat at all.
    expect(out).not.toContain("NHS UDA");
  });

  it("uses tabular figures for every money cell, so columns line up down the card", () => {
    expect(html).toContain("tabular-nums");
  });
});

describe("the card header states WHICH fact is missing", () => {
  it("renders the read's own dangling-id sentence, naming the appointment", () => {
    const reason =
      "Dentally links this card to appointment appt-404, which was not in this patient's appointment list. Its date, time and clinician cannot be shown.";
    const model = toPlanPanelView({
      model: buildPlanPanel({
        plan: PLAN,
        appointments: [{ ...CARD, appointmentId: "appt-404" }],
        items: [item({ id: "i", treatmentAppointmentId: "ta-1" })],
      }),
      cardHeaders: {
        "ta-1": { ...CARD_HEADER, start: null, practitioner: null, unresolvedReason: reason },
      },
      practitioners: {},
      synthetic: false,
    });
    const plain = text(render(model));
    expect(plain).toContain("appt-404");
    // NOT the generic fallback, which would say the treatment is unbooked.
    expect(plain).not.toContain("is not linked to a diary appointment");
  });

  it("renders the diary-outage sentence rather than claiming the card is unbooked", () => {
    const reason =
      "This patient's diary could not be read, so this card's date, time and clinician are unavailable. This is a connection problem, not a fact about the appointment.";
    const model = toPlanPanelView({
      model: buildPlanPanel({ plan: PLAN, appointments: [CARD], items: [] }),
      cardHeaders: { "ta-1": { ...CARD_HEADER, start: null, unresolvedReason: reason } },
      practitioners: {},
      synthetic: false,
    });
    expect(text(render(model))).toContain("This is a connection problem");
  });
});

describe("every blocked control still explains itself", () => {
  const html = render(view());

  it("resolves every aria-describedby to a sentence that is really on the screen", () => {
    for (const id of describedByTargets(html)) {
      const body = textOfElementWithId(html, id);
      expect(body, `aria-describedby="${id}" points at nothing`).not.toBeNull();
      expect((body ?? "").trim().length, `the explanation for ${id} is empty`).toBeGreaterThan(0);
    }
  });

  it("gives every inert control an aria-describedby, and never a bare disabled attribute", () => {
    const inert = [...html.matchAll(/<button[^>]*aria-disabled="true"[^>]*>/g)].map((m) => m[0]);
    expect(inert.length).toBeGreaterThan(0);
    for (const button of inert) {
      expect(button, "an inert control with no explanation").toContain("aria-describedby=");
    }
    // `disabled` takes a control out of the tab order, so a keyboard user could
    // never reach the explanation at all.
    expect(html).not.toMatch(/<button[^>]*\sdisabled(=|\s|>)/);
  });

  it("renders every gated control PLAN-PANEL.md names, rather than removing them", () => {
    const plain = text(html);
    for (const label of ["add appointment", "Charge", "Complete treatment plan", "Submit claim"]) {
      expect(plain, `${label} must still be on the screen`).toContain(label);
    }
    // The row checkboxes and the note's editing affordances, by their labels.
    expect(html).toContain("Mark RCT stage 1 completed");
    expect(html).toContain("Dictate this note");
    expect(html).toContain("Draft");
  });

  it("gives Charge its own commercial sentence, not the generic API one", () => {
    const charge = textOfElementWithId(html, "chart-plan-688300-charge-reason") ?? "";
    expect(charge).toContain("moves money");
    expect(charge).toContain("signs it off in writing");
    expect(charge).not.toBe(CHART_COPY.writeBlockedTitle);
  });

  it("renders the write-blocked sentence in full, never a shortened paraphrase", () => {
    expect(text(html)).toContain(text(CHART_COPY.writeBlockedTitle).trim());
  });

  it("calls no Dentally write path: every control is a plain inert button", () => {
    expect(html).not.toMatch(/<form/);
    expect(html).not.toMatch(/formaction=/i);
    expect(html).not.toMatch(/href="[^"]*dentally/i);
  });
});

describe("two panels on one page", () => {
  it("collides on no DOM id at all", () => {
    const second = toPlanPanelView({
      model: buildPlanPanel({
        plan: { ...PLAN, id: "688301", nickname: "Lower left" },
        appointments: [],
        items: [item({ id: "other-1" }), item({ id: "other-2" })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    const html = render(view()) + render(second);
    const ids = idsIn(html);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    // A duplicate id makes every aria-describedby pointing at it resolve to the
    // FIRST panel's sentence, so the second plan's controls are explained by the
    // wrong plan while the page looks perfect.
    expect(duplicates, `duplicate DOM ids: ${[...new Set(duplicates)].join(", ")}`).toEqual([]);
    expect(ids.length).toBeGreaterThan(20);
  });

  it("resolves every describedby inside the page that holds both", () => {
    const second = toPlanPanelView({
      model: buildPlanPanel({ plan: { ...PLAN, id: "688301" }, appointments: [], items: [] }),
      cardHeaders: {},
      practitioners: {},
      synthetic: false,
    });
    const html = render(view()) + render(second);
    for (const id of describedByTargets(html)) {
      expect(textOfElementWithId(html, id), `${id} dangles`).not.toBeNull();
    }
  });
});

describe("the states that are not a plan", () => {
  it("renders Dentally's own empty-state cards when there is genuinely no plan", () => {
    const plain = text(render(null));
    expect(plain).toContain("No treatment plans on record.");
    expect(plain).toContain("New treatment plan");
    expect(plain).toContain("Select template");
  });

  it("says a failed read is a failed read, never an empty plan", () => {
    const plain = text(render(null, { failed: true }));
    expect(plain).toContain("could not read this patient's treatment plans");
    expect(plain).not.toContain("No treatment plans on record.");
  });

  it("labels the synthetic panel as having no plan rather than printing an empty chip", () => {
    const synthetic = toPlanPanelView({
      model: buildPlanPanel({
        plan: {
          ...PLAN,
          id: "",
          nickname: "Treatment not shown against a plan",
          privateTreatmentValuePence: null,
          nhsUdaHundredths: null,
          nhsCompletedUdaHundredths: null,
        },
        appointments: [],
        items: [item({ id: "orphan", planId: null })],
      }),
      cardHeaders: {},
      practitioners: {},
      synthetic: true,
    });
    const html = render(synthetic);
    const plain = text(html);
    expect(plain).toContain("No plan");
    expect(plain).toContain("Treatment not shown against a plan");
    // Its ids hang off a prefix of their own, not off "chart-plan-".
    expect(html).toContain("chart-plan-unfiled-charge");
  });

  it("shows the incomplete-screen warning only when the counts disagree", () => {
    expect(text(render(view()))).not.toContain("could not be placed on this screen");
    const broken = { ...view() };
    broken.reconciliation = { modelRowCount: 18, viewRowCount: 17, balanced: false };
    expect(text(render(broken))).toContain("could not be placed on this screen");
  });
});

// ===========================================================================
// THE BUCKET, MEASURED RATHER THAN ASSUMED.
//
// ADDED AFTER A MUTATION PASS, and each of these exists because a specific
// mutation of the panel survived the whole suite. The tests above prove the
// bucket EXISTS on the 15-of-18 fixture; none of them proved it survives at a
// count of one, that its printed count is its own row count, or that its
// footer is its own arithmetic. Those three gaps are exactly the shape of the
// finding this panel was built around, so they are closed here:
//
//   * hiding the bucket below two items      -- suite stayed green
//   * hard-coding the bucket's printed count -- suite stayed green
//   * giving the bucket the whole plan total -- suite stayed green
//
// The one-item case is not a curiosity. On the mock patient the platform
// renders today, TWO of the three panels hold exactly one unassigned item, and
// a plan whose only unplaced line vanished would show an empty screen that
// still looked finished.
// ===========================================================================

/** A plan whose card total, bucket total and plan total are three DIFFERENT
 *  figures, so a footer printing the wrong one cannot coincide with the right one. */
function distinctTotalsView(looseCount: number): PlanPanelViewModel {
  const carded = [
    item({ id: "c-1", treatmentAppointmentId: "ta-1", pricePence: 100, durationMin: 5, position: 0 }),
    item({ id: "c-2", treatmentAppointmentId: "ta-1", pricePence: 200, durationMin: 10, position: 1 }),
  ];
  const loose = Array.from({ length: looseCount }, (_, n) =>
    item({ id: `l-${n}`, pricePence: 1000 * (n + 1), durationMin: 20, position: n }),
  );
  return toPlanPanelView({
    model: buildPlanPanel({
      plan: { ...PLAN, privateTreatmentValuePence: null, nhsUdaHundredths: null, nhsCompletedUdaHundredths: null },
      appointments: [CARD],
      items: [...carded, ...loose],
    }),
    cardHeaders: { "ta-1": CARD_HEADER },
    practitioners: {},
    synthetic: false,
  });
}

/** The markup of the unassigned card alone: from its own id prefix to the
 *  "add appointment" affordance that follows the last card. */
function bucketMarkup(html: string): string {
  // From the <section> that OPENS the card, not from the first id inside it: the
  // printed count lives in the header, ahead of any id, and slicing past it is how
  // this helper silently stopped measuring the thing it was written for.
  const heading = html.indexOf("Not on an appointment");
  expect(heading, "the unassigned card was not rendered at all").toBeGreaterThan(-1);
  const start = html.lastIndexOf("<section", heading);
  const end = html.indexOf("chart-plan-688300-add-appointment");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("the unassigned bucket, at every size and with its own arithmetic", () => {
  it("renders when it holds exactly ONE item, which is the commonest live plan", () => {
    const html = render(distinctTotalsView(1));
    const plain = text(html);
    expect(plain, "a plan's only unplaced line disappeared").toContain("Not on an appointment");
    expect(plain).toContain("1 item");
    // The row itself, not merely the heading.
    expect(html).toContain("chart-plan-688300-unassigned-complete-l-0");
  });

  it("prints a count that equals the rows it actually rendered", () => {
    for (const n of [1, 2, 15]) {
      const html = render(distinctTotalsView(n));
      const bucket = bucketMarkup(html);
      const rendered = (bucket.match(/-unassigned-complete-l-\d+"/g) ?? []).length;
      expect(rendered, `bucket rendered ${rendered} rows for ${n} items`).toBe(n);
      // THE HEADER ALONE. The counted reason sentence below it repeats the figure,
      // so searching the whole card would let a hard-coded header count pass on the
      // strength of a paragraph the reader has to open the card to reach.
      const header = bucket.slice(bucket.indexOf("<h3"), bucket.indexOf("</summary>"));
      expect(text(header), `the printed count disagrees with the ${n} rows above it`).toContain(
        `${n} ${n === 1 ? "item" : "items"}`,
      );
    }
  });

  it("foots itself from its OWN rows, never from the whole plan", () => {
    // card: 100 + 200 = £3.00 over 15 min. bucket: 1000 + 2000 + 3000 = £60.00
    // over 60 min. plan: £63.00. Three distinct figures on purpose.
    const html = render(distinctTotalsView(3));
    const bucket = text(bucketMarkup(html));
    expect(bucket).toContain("£60.00");
    expect(bucket).toContain("60 min");
    expect(bucket, "the bucket footed the whole plan instead of itself").not.toContain("£63.00");
    expect(bucket, "the bucket printed the appointment card's total").not.toContain("£3.00");
    expect(bucket).not.toContain("15 min");
    // And the plan footer is still the whole plan, not the bucket.
    expect(text(html)).toContain("£63.00");
  });
});
