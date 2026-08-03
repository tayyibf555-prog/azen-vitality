// ===========================================================================
// THE PLAN PANEL'S VIEW MODEL — the seam between the three builds.
//
// WHY THIS FILE EXISTS AT ALL. Three builders worked this feature in parallel
// against a written interface and each of them was internally right:
//
//   * plan-panel.ts groups the plan and refuses to drop a row. Its model is
//     `{ plan, groups: (AppointmentGroup | UnassignedGroup)[], totals }`, and
//     every row it hands back is a whole ChartItem.
//   * charting-read.ts reads four Dentally streams and resolves each card's
//     header off the DIARY, producing a sentence when it cannot.
//   * the .tsx cards render flat rows — a tooth LABEL, a treatment NAME, a
//     practitioner's INITIALS, a date — none of which exist on a ChartItem.
//
// Nothing joined those three. `ChartItem` has no `name` (the treatment's wording
// is `nomenclature`), no `toothLabel` (it has FDI integers), no practitioner name
// (it has a uuid) and no date column. Rendering the read straight into the cards
// would have produced a screen of blank name, blank tooth and blank clinician
// columns that still looked like a finished table — the failure this feature has
// now shipped twice, once as blank surfaces and once as unparsed Palmer teeth.
//
// So the join lives HERE, in a .ts, because vitest collects only src/ ** / *.test.ts
// in a node environment and can never reach a .tsx. The .tsx files hold markup and
// nothing else, and every decision about what a cell says is asserted in
// plan-panel-view.test.ts and rendered in plan-panel-render.test.ts.
//
// ---------------------------------------------------------------------------
// THE FINDING THIS FILE MUST NOT UNDO
//
//   Only 17 of 100 live treatment_plan_items carry a treatment_appointment_id.
//
// plan-panel.ts protects that with a single row-bearing field and a discriminated
// union, precisely so a consumer cannot render "just the cards". This file is
// that consumer, and it flattens the union into two fields the cards can take —
// which is exactly the move the union exists to make hard. It is therefore the
// one place in the build where 83% of a patient's plan could go missing again.
//
// Two mechanics stand against that, and neither is a comment:
//   * `reconciliation` counts the rows in the source model against the rows this
//     view actually carries, and `balanced` is asserted by the view tests, by the
//     render test and at the top of the rendered panel itself.
//   * the switch over `group.kind` is exhaustive with a `never` default, so a
//     third group kind added upstream is a COMPILE error here rather than a
//     quietly dropped bucket.
//
// ---------------------------------------------------------------------------
// UNITS. Money is integer PENCE throughout and is divided exactly once, at
// render. UDA figures are HUNDREDTHS OF A UDA and are deliberately named apart:
// a UDA is a unit of activity, and printing `nhs_uda_value: 3` as "£3.00" would
// be a claim about a claim. Nullable stays nullable all the way to the screen —
// a figure Dentally did not send renders as "not given", never as a plausible
// £0.00, which is this house's oldest recorded mistake.
//
// NO CLOCK IS READ HERE. Every instant printed under this panel came off the
// wire. There is no Date.now() and no new Date().
// ===========================================================================

import { FUNDING_LABEL, type FundingCode } from "@/lib/calendar/funding";
import { toothLabel as fdiLabel } from "./fdi";
import { surfaceIndexText } from "./history";
import { serialiseSurfaces, surfaceIndicesOf } from "./surfaces";
import { UNASSIGNED_LABEL } from "./plan-panel";
import type { PlanPanelItem, PlanPanelModel, PlanPanelRow } from "./plan-panel";
import type { PlanCardHeader } from "@/lib/dentally/charting-read";

// ---------------------------------------------------------------------------
// The shapes the cards render.
//
// These were written twice during the parallel build — once here in intent and
// once provisionally inside appointment-card.tsx — and they are now defined ONCE,
// in the file vitest can reach, and imported by the .tsx. Two spellings of one
// row on a clinical table is how a renderer ends up printing the stale one.
// ---------------------------------------------------------------------------

export interface PlanItemRow {
  id: string;
  /** ISO. See `rowDate` below for exactly which date this is and which it is not. */
  dateIso: string | null;
  /** FDI, already converted. NEVER derived in a component. */
  toothLabel: string | null;
  /** What Dentally actually sent, printed when the teeth value would not parse. */
  rawTeeth: string | null;
  name: string;
  /** Initials, or null. Null renders NOTHING: invented initials name the wrong
   *  clinician on a clinical record. */
  practitionerInitials: string | null;
  /**
   * Dentally named a clinician on this line and we could not turn the id into a
   * name.
   *
   * THIS IS NOT THE SAME AS `practitionerInitials === null` AND THAT IS THE POINT.
   * The initials column holds its width whether or not a row has a value, and an
   * EMPTY cell on this table means "Dentally sent nothing here" — that rule is
   * written where the columns are defined. A row whose practitioner_id we could not
   * look up is the opposite case: Dentally did record who treated this patient, and
   * printing an empty cell for it makes a false statement about a clinical record
   * (GDC 4.1.4 requires the treating clinician's name or initials, and CHARTING.md
   * §8.1 forbids a silent "unknown clinician" state). So the two are carried apart
   * and rendered apart.
   */
  practitionerUnresolved: boolean;
  funding: FundingCode;
  /**
   * Minutes, or NULL when Dentally's figure was not a finite number.
   *
   * NULLABLE RATHER THAN COERCED, because both alternatives lie. Passing NaN
   * through rendered the literal string "NaN min" in a duration column; coercing it
   * to 0 prints "0 min", which is a figure a coordinator reads as a fact. The group
   * footer excludes the row either way, and `PlanGroupTotals.unreadableFigures`
   * counts it so the footer can say it is short rather than presenting a partial
   * sum as complete.
   */
  durationMin: number | null;
  /** Pence, or NULL for exactly the reason durationMin is nullable. Never 0: a
   *  £0.00 row is an ordinary line on a plan and must stay distinguishable from a
   *  figure we could not read. */
  pricePence: number | null;
  completed: boolean;
  completedAtIso: string | null;
  charged: boolean;
  notes: string | null;
  nomenclature: string | null;
  udaBand: string | null;
  nhsTreatmentCat: string | null;
  /** Dentally's surfaces, verbatim: the letter code when we have one, otherwise
   *  its own surface NUMBERS as a phrase. Never an anatomical name nobody has
   *  confirmed. */
  surfacesLabel: string | null;
}

export interface PlanGroupTotals {
  /** Summed from the rows by plan-panel.ts, never stored by Dentally. */
  durationMin: number;
  pricePence: number;
  /**
   * Rows whose duration or price was not a finite number, and which the two sums
   * above therefore EXCLUDE.
   *
   * plan-panel.ts has always computed this "so the footer can caveat itself" and
   * nothing carried it this far, so the footer quietly presented a short total as a
   * complete one. It is carried now and rendered by the card, because a total that
   * silently omits a row is the same class of claim as a plan that silently omits
   * one.
   */
  unreadableFigures: number;
}

export interface PlanAppointmentGroup {
  key: string;
  /** Dentally's RAW position, zero based; the card renders `Appt. {position + 1}`.
   *  Null when the position was unreadable, and then the card is titled without a
   *  number rather than being given an invented one. */
  position: number | null;
  appointmentId: string | null;
  /** From the LINKED DIARY APPOINTMENT, not from the treatment_appointment. */
  startsAtIso: string | null;
  practitioner: string | null;
  note: string | null;
  completed: boolean;
  /**
   * THE SENTENCE FROM THE READ, not a generic one. charting-read.ts distinguishes
   * four outcomes — never booked, the diary read failed, a dangling appointment id
   * (which it names), and an appointment carrying no start time — and they are
   * different statements to a clinician. Collapsing them into one "not linked to a
   * diary appointment" line would tell somebody a plan is unbooked when the truth
   * is that Dentally timed out.
   */
  unresolvedReason: string | null;
  rows: PlanItemRow[];
  totals: PlanGroupTotals;
}

export interface PlanUnassignedGroup {
  key: string;
  rows: PlanItemRow[];
  totals: PlanGroupTotals;
  /** plan-panel.ts's counted sentence: how many items have no appointment at all,
   *  and how many name an appointment that was not returned. Two different facts,
   *  and the bucket says which it is holding. */
  reason: string;
}

/** Every figure the footer prints. Nullable where Dentally may not have sent it. */
export interface PlanViewTotals {
  /** Summed from the rows ON SCREEN, so the footer always equals what a reader
   *  can count above it. Never null: it is our arithmetic, not Dentally's field. */
  itemsPricePence: number;
  /** Items with charged === false. Live sampling found charged false on 100/100,
   *  so uncharged equalling the total is the NORMAL reading, not a bug. */
  unchargedPence: number;
  /** treatment_plan.private_treatment_value. NULL when Dentally sent none — a
   *  different claim from the sum above, and kept beside it rather than replacing
   *  it so a disagreement between the two is visible. */
  privateTreatmentValuePence: number | null;
  /** HUNDREDTHS OF A UDA. Not money. */
  nhsUdaHundredths: number | null;
  nhsCompletedUdaHundredths: number | null;
}

/** Proof that flattening the union dropped nothing. */
export interface PlanViewReconciliation {
  /** Rows in the source model, across every group of every kind. */
  modelRowCount: number;
  /** Rows carried by this view, across the cards AND the bucket. */
  viewRowCount: number;
  balanced: boolean;
}

export interface PlanPanelViewModel {
  /** The treatment_plan id, which is the chip Dentally prints beside the +. */
  id: string;
  nickname: string | null;
  completed: boolean;
  /** True for the synthetic panel holding treatment that names no plan we read. */
  synthetic: boolean;
  /** The prefix every DOM id under this panel is built from. Required, because a
   *  patient with two plans renders two panels on ONE page: fixed ids would
   *  collide and every aria-describedby would resolve to the first panel's
   *  sentence, leaving the second panel's controls explained by the wrong plan. */
  domId: string;
  appointments: PlanAppointmentGroup[];
  unassigned: PlanUnassignedGroup | null;
  totals: PlanViewTotals;
  reconciliation: PlanViewReconciliation;
}

/** A treatment_plan_item Dentally returned with no wording of its own. Named
 *  rather than left blank: an empty name column reads as a missing row. */
export const UNNAMED_TREATMENT_LABEL = "Treatment (unnamed in Dentally)";

/** The DOM id prefix for the synthetic panel, whose plan id is the empty string. */
export const UNFILED_PLAN_DOM_KEY = "unfiled";

// ---------------------------------------------------------------------------
// Row mapping.
// ---------------------------------------------------------------------------

/** Titles carry no information as initials, and "DZH" names nobody. */
const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "prof", "professor", "sr", "sister"]);

/**
 * Initials from a practitioner's NAME, and only from a name.
 *
 * Never from an id: `practitioner_id` is a uuid, and taking letters off one would
 * put a plausible-looking pair of initials against a treatment on a clinical
 * record while naming nobody at all. A practitioner we cannot resolve to a name
 * renders an EMPTY cell, exactly as the funding badge does for an unresolved
 * payment plan.
 */
export function initialsOf(name: string | null): string | null {
  if (name === null) return null;
  const words = name
    .trim()
    .split(/[\s.]+/)
    .filter((w) => w.length > 0 && !TITLES.has(w.toLowerCase().replace(/[^a-z]/g, "")));
  if (words.length === 0) return null;
  const letters = words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return letters.length > 0 ? letters : null;
}

/**
 * The date column.
 *
 * ONE MEANING ONLY: the day this treatment is booked for, or the day it was done.
 * For a row on a card that resolved, that is the card's own appointment start —
 * which is what Dentally prints on every row of a card in the reference
 * screenshot. For anything else it is the item's completedAt, and when there is
 * neither the cell is EMPTY.
 *
 * It is deliberately NOT `updatedAt ?? createdAt`, which history.ts falls back to.
 * History is a log and is labelled as one, so "when this record last changed" is
 * a sensible answer there. Here the column sits beside a treatment name and a
 * price, where a reader takes it for when the work happens; printing a record's
 * edit date in that position would tell a patient their extraction is booked for
 * the day somebody corrected a typo. A blank cell on an unscheduled item is the
 * true answer, and on live data most of the plan is unscheduled.
 */
export function rowDate(item: PlanPanelItem, cardStart: string | null): string | null {
  if (cardStart !== null) return cardStart;
  return item.completedAt ?? null;
}

/** Dentally's surfaces, in whichever vocabulary it actually sent. */
function surfacesLabelOf(item: PlanPanelItem): string | null {
  const code = serialiseSurfaces(item.surfaces);
  if (code.length > 0) return code;
  const phrase = surfaceIndexText(surfaceIndicesOf(item));
  return phrase.length > 0 ? phrase : null;
}

/** A figure Dentally sent in a form we could not read is NULL, never 0 and never
 *  NaN. See PlanItemRow.durationMin for why both alternatives are worse. */
function figure(n: number): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function toRow(
  row: PlanPanelRow,
  cardStart: string | null,
  practitioners: ReadonlyMap<string, string>,
): PlanItemRow {
  const { item } = row;
  const name = item.nomenclature?.trim();
  const practitionerName =
    item.practitionerId === null ? null : (practitioners.get(item.practitionerId) ?? null);
  const practitionerInitials = initialsOf(practitionerName);
  return {
    id: item.id,
    dateIso: rowDate(item, cardStart),
    // The teeth are already FDI integers, parsed and exhaustively tested by
    // fdi.ts. Nothing here derives a quadrant: an off-by-one-quadrant conversion
    // labels the contralateral tooth.
    toothLabel: item.teeth.length > 0 ? item.teeth.map((t) => fdiLabel(t)).join(", ") : null,
    rawTeeth: item.rawTeeth.trim().length > 0 ? item.rawTeeth : null,
    name: name && name.length > 0 ? name : UNNAMED_TREATMENT_LABEL,
    practitionerInitials,
    // Dentally NAMED somebody here and we could not say who. Distinct from a row
    // that names nobody at all, which is the empty cell.
    practitionerUnresolved: item.practitionerId !== null && practitionerInitials === null,
    funding: row.funding,
    durationMin: figure(item.durationMin),
    pricePence: figure(item.pricePence),
    completed: item.completed,
    completedAtIso: item.completedAt,
    charged: item.charged,
    notes: item.notes,
    nomenclature: item.nomenclature,
    udaBand: item.udaBand,
    nhsTreatmentCat: item.nhsTreatmentCat,
    surfacesLabel: surfacesLabelOf(item),
  };
}

/** A group's footer, carried whole rather than field by field: the count of rows
 *  the sums had to leave out travels WITH the sums, so a card cannot render one
 *  without the other. */
function groupTotals(totals: {
  durationMin: number;
  pricePence: number;
  unreadableFigures: number;
}): PlanGroupTotals {
  return {
    durationMin: totals.durationMin,
    pricePence: totals.pricePence,
    unreadableFigures: totals.unreadableFigures,
  };
}

/** A card is complete when every row on it is, and an EMPTY card never is: an
 *  appointment with no treatment on it has completed nothing. */
function cardCompleted(rows: readonly PlanItemRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.completed);
}

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

/** Exactly what charting-read.ts hands over per plan, named structurally so this
 *  module needs no value import from the data layer. */
export interface PlanPanelSource {
  model: PlanPanelModel;
  cardHeaders: Record<string, PlanCardHeader>;
  /**
   * Practitioner id to display NAME, from the read's /v1/practitioners stream.
   *
   * REQUIRED AND NOT OPTIONAL, for the same reason PlanPanelItem.treatmentAppointmentId
   * is: optional would mean a data layer that simply never read the stream compiled
   * cleanly and produced a panel with a blank clinician on every row — which is
   * exactly the defect this field exists to fix. Empty is a legitimate value and
   * means the read returned nobody; it is not the same as the field being absent.
   */
  practitioners: Record<string, string>;
  synthetic: boolean;
}

/**
 * One plan, as the cards render it.
 *
 * THE SWITCH IS EXHAUSTIVE ON PURPOSE. plan-panel.ts made `groups` a discriminated
 * union so that forgetting the unassigned bucket is a compile error rather than a
 * missing 83% of a plan. Flattening it back into two fields here would throw that
 * guarantee away, so the guarantee is re-earned: the default arm assigns to
 * `never`, and `reconciliation` proves by count that every row survived the trip.
 */
export function toPlanPanelView(source: PlanPanelSource): PlanPanelViewModel {
  const { model, cardHeaders, synthetic } = source;

  // THE PRACTITIONER NAMES, FROM THE PRACTITIONERS STREAM FIRST.
  //
  // This map used to be built from `cardHeaders` ALONE — that is, only from
  // clinicians who happened to appear on a resolved DIARY APPOINTMENT of this same
  // plan. 17 of 100 live items belong to an appointment at all, so 83% of a real
  // plan could be named only by coincidence, and a plan with no resolved card
  // rendered a blank clinician on 100% of its rows while looking complete. The read
  // now walks /v1/practitioners and hands the whole site's roster over.
  //
  // THE CARD HEADER IS KEPT AS A FALLBACK, and only as one. A diary appointment
  // carries a `practitioner` name for the clinician it is booked with; if the
  // roster read failed, or came back without somebody a card names, that name is
  // still a name Dentally sent for that id and is better than nothing. It never
  // OVERWRITES the roster: the roster is the practice's own record of who someone
  // is, and a diary row's display string is a copy of it.
  const practitioners = new Map<string, string>(Object.entries(source.practitioners));
  for (const header of Object.values(cardHeaders)) {
    if (
      header.practitionerId !== null &&
      header.practitioner !== null &&
      !practitioners.has(header.practitionerId)
    ) {
      practitioners.set(header.practitionerId, header.practitioner);
    }
  }

  const appointments: PlanAppointmentGroup[] = [];
  let unassigned: PlanUnassignedGroup | null = null;

  for (const group of model.groups) {
    switch (group.kind) {
      case "appointment": {
        const header = cardHeaders[group.appointment.id] ?? null;
        const start = header?.start ?? null;
        const rows = group.rows.map((row) => toRow(row, start, practitioners));
        appointments.push({
          key: group.key,
          // The card renders position + 1, so the raw position is handed back from
          // the number plan-panel.ts already computed rather than re-derived from
          // the appointment: one of the two would eventually drift.
          position: group.number === null ? null : group.number - 1,
          appointmentId: group.appointment.appointmentId,
          startsAtIso: start,
          practitioner: header?.practitioner ?? null,
          note: group.appointment.notes,
          completed: cardCompleted(rows),
          unresolvedReason: header?.unresolvedReason ?? null,
          rows,
          totals: groupTotals(group.totals),
        });
        break;
      }
      case "unassigned": {
        unassigned = {
          key: group.key,
          // No card, so no appointment date: these rows fall back to their own
          // completion date, and most of them have none.
          rows: group.rows.map((row) => toRow(row, null, practitioners)),
          totals: groupTotals(group.totals),
          reason: group.reason,
        };
        break;
      }
      default: {
        // A third group kind upstream stops the build here rather than silently
        // vanishing from the screen.
        const never: never = group;
        throw new Error(`unhandled plan panel group: ${JSON.stringify(never)}`);
      }
    }
  }

  const modelRowCount = model.groups.reduce((n, g) => n + g.rows.length, 0);
  const viewRowCount =
    appointments.reduce((n, g) => n + g.rows.length, 0) + (unassigned?.rows.length ?? 0);

  return {
    id: model.plan.id,
    nickname: model.plan.nickname,
    completed: model.plan.completed,
    synthetic,
    domId: `chart-plan-${model.plan.id.trim().length > 0 ? model.plan.id : UNFILED_PLAN_DOM_KEY}`,
    appointments,
    unassigned,
    totals: {
      itemsPricePence: model.totals.itemsPricePence,
      unchargedPence: model.totals.unchargedPence,
      privateTreatmentValuePence: model.totals.privateTreatmentValuePence,
      nhsUdaHundredths: model.totals.nhsUdaHundredths,
      nhsCompletedUdaHundredths: model.totals.nhsCompletedUdaHundredths,
    },
    reconciliation: { modelRowCount, viewRowCount, balanced: modelRowCount === viewRowCount },
  };
}

/** Every panel of a read, in the order the read produced them: the patient's own
 *  plans first, the synthetic "not shown against a plan" panel last. */
export function toPlanPanelViews(sources: readonly PlanPanelSource[]): PlanPanelViewModel[] {
  return sources.map((s) => toPlanPanelView(s));
}

// ---------------------------------------------------------------------------
// The sentences the tab itself renders, above the panels.
//
// PROVISIONAL LOCATION, as with the three copy blocks the UI builder left in the
// .tsx files: every other honesty sentence on this screen lives in CHART_COPY in
// src/lib/patient/tabs.ts, where tabs.test.ts sweeps it for British English and
// for em-dashes. A concurrent session is editing that file, so these are written
// to the same standard and left here to be moved across in one pass rather than
// merged into a file being written underneath us.
// ---------------------------------------------------------------------------

export const PLAN_PANEL_READ_COPY = {
  /** THE ONE THE SCREEN CANNOT DO WITHOUT. A panel that dropped rows still looks
   *  like a finished table, so when the counts do not reconcile the screen says so
   *  in words rather than leaving a clinician to count. */
  unbalanced:
    "Some treatment on this patient's plan could not be placed on this screen, so what is shown below is " +
    "incomplete. Read this patient's treatment plan in Dentally before relying on it.",
  truncated:
    "This patient has more treatment plan lines than we read in one go, so the plan below may be missing its " +
    "oldest entries.",
  truncatedSupporting:
    "This patient's plan list or diary was longer than we read in one go, so an appointment card may show no " +
    "date or clinician even though it has one in Dentally.",
  itemsFailed:
    "The treatment plan lines could not be read from Dentally just now, so this is not a statement that this " +
    "patient has no planned treatment.",
  appointmentsFailed:
    "The appointments on this treatment plan could not be read from Dentally just now, so every line below is " +
    "shown without its appointment card. This is a connection problem, not a fact about the plan.",
  diaryFailed:
    "This patient's diary could not be read just now, so the appointment cards below carry no date, time or " +
    "clinician.",
  /** THE ONE THAT STOPS A BLANK COLUMN READING AS A FACT. Dentally records who
   *  treated a patient on every line; when the clinician list cannot be read, the
   *  initials column is blank because we could not look the names up, not because
   *  nobody was recorded. */
  practitionersFailed:
    "The practice's clinician list could not be read from Dentally just now, so the initials beside each line " +
    "below may be missing. Dentally does hold a clinician for these lines; we could not look up their names.",
} as const;

/**
 * What the initials column shows for a line whose clinician we could not name.
 *
 * NOT AN EMPTY CELL, which on this table means "Dentally sent nothing here", and
 * not the practitioner id, which would put a plausible pair of characters against
 * a treatment while naming nobody. A question mark carrying the sentence below is
 * the one honest answer: it says a clinician IS recorded and that we could not
 * resolve them, which is what GDC 4.1.4 and CHARTING.md §8.1 require instead of a
 * silent unknown.
 */
export const PRACTITIONER_UNRESOLVED_MARK = "?";
export const PRACTITIONER_UNRESOLVED_EXPLANATION =
  "Dentally recorded a clinician against this line, but we could not look up their name.";

/**
 * The caveat a group footer prints when its own sums had to leave rows out.
 *
 * Null when there is nothing to say, so a card renders no line at all rather than
 * a permanent "0 lines were excluded", which is a caveat a reader learns to skip
 * past — and skipping past caveats is how the ones that matter stop being read.
 */
export function unreadableFiguresNote(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  const lines = count === 1 ? "1 line" : `${count} lines`;
  const carry = count === 1 ? "carries" : "carry";
  return (
    `${lines} on this card ${carry} a duration or a price that Dentally sent in a form we could not read, so ` +
    `the totals above leave ${count === 1 ? "it" : "them"} out. Read this treatment plan in Dentally before ` +
    `relying on these figures.`
  );
}

/** The notices a read's health and counts require, in the order they should be
 *  rendered. Pure, so the wording and the conditions are both testable. */
export function planPanelNotices(read: {
  balanced: boolean;
  truncated: boolean;
  truncatedSupporting: boolean;
  health: {
    items: "ok" | "failed";
    appointments: "ok" | "failed";
    diary: "ok" | "failed";
    /** REQUIRED, so a caller that added the stream and forgot its caveat does not
     *  compile. A failed clinician read is invisible on screen otherwise: the
     *  initials column simply goes blank, which reads as a fact about the record. */
    practitioners: "ok" | "failed";
  };
}): string[] {
  const out: string[] = [];
  // Most serious first: a screen that is quietly incomplete outranks every other
  // caveat on it.
  if (!read.balanced) out.push(PLAN_PANEL_READ_COPY.unbalanced);
  if (read.health.items === "failed") out.push(PLAN_PANEL_READ_COPY.itemsFailed);
  if (read.health.appointments === "failed") out.push(PLAN_PANEL_READ_COPY.appointmentsFailed);
  if (read.health.diary === "failed") out.push(PLAN_PANEL_READ_COPY.diaryFailed);
  if (read.health.practitioners === "failed") {
    out.push(PLAN_PANEL_READ_COPY.practitionersFailed);
  }
  if (read.truncated) out.push(PLAN_PANEL_READ_COPY.truncated);
  if (read.truncatedSupporting) out.push(PLAN_PANEL_READ_COPY.truncatedSupporting);
  return out;
}

/** Re-exported so a component takes one import for the label vocabulary rather
 *  than reaching past this module into the calendar's. UNASSIGNED_LABEL rides the
 *  same rule, and for a sharper reason: the card used to spell that heading itself,
 *  so the constant went stale and the two disagreed. */
export { FUNDING_LABEL, UNASSIGNED_LABEL };
export type { FundingCode };
