// ===========================================================================
// THE TREATMENT PLAN PANEL — the pure engine behind the working half of the
// charting screen.
//
// The arch above it says what is IN the mouth. This says what is PLANNED for it:
// appointment cards, their rows, their footers, the plan's money. It is a
// READ-ONLY MIRROR exactly as the chart is — there is no create route on any
// Dentally charting resource, so nothing here writes and nothing here may grow a
// write. Every action control on the panel renders disabled, and that decision
// lives in the UI, not in this file.
//
// EVERYTHING TESTABLE LIVES HERE. vitest collects only src/**/*.test.ts in a node
// environment, so a .tsx panel is untestable by construction. Grouping, ordering,
// totals, the funding rollup and the unassigned bucket are therefore all here,
// and the .tsx above is left with nothing but markup.
//
// ---------------------------------------------------------------------------
// THE FINDING THIS FILE EXISTS TO SURVIVE
//
//   Only 17 of 100 live treatment_plan_items carry a treatment_appointment_id.
//
// 83% of a real patient's plan belongs to NO appointment card. Build this as
// pure "Appt. 1 / Appt. 2" groups and most of the plan silently disappears while
// the screen still looks complete — the same failure class as the blank surfaces
// and the unparsed Palmer teeth, both of which shipped on this feature and were
// caught late, and the most dangerous kind precisely because it looks finished.
//
// So the return shape is built to make dropping those items HARD:
//
//   * There is exactly ONE row-bearing field on the model, `groups`. There is no
//     `cards` array. A consumer that maps the model's rows cannot map only the
//     appointment cards, because that collection does not exist to be mapped.
//   * `groups` is a DISCRIMINATED UNION on `kind`. A `switch` over it with the
//     usual `never` default is a compile error the moment "unassigned" is not
//     handled, which is the closest TypeScript gets to "you may not forget this".
//   * `reconciliation` states inputItemCount vs groupedItemCount and whether they
//     balance, so a regression is an assertable fact rather than a visual one.
//
// Items are never dropped for ANY reason. An item pointing at an appointment we
// did not receive joins the bucket with its own count and its own sentence,
// following the precedent already set on this screen by `unplaced` teeth: what we
// could not place is counted and shown, never quietly discarded.
//
// ---------------------------------------------------------------------------
// UNITS, AND WHY THE ITEM TYPE ADDS A FIELD
//
// Money on this screen is PENCE, integer, so that summing forty rows cannot
// accumulate binary rounding error. But ChartItem.price is `num(r.price)` — the
// raw wire value coerced to a JS number, with no unit attached and no decision
// recorded about whether Dentally sent "45.0" pounds or 4500 pence. Summing that
// field here would be guessing, and a plan total 100x wrong is a money bug on a
// clinical screen.
//
// PlanPanelItem therefore REQUIRES its own `pricePence`. A caller that has not
// decided the unit cannot construct the input at all, which is the same trick
// ChartItem.surfaceIndices uses: a required field makes forgetting it a compiler
// error rather than a plausible-looking zero. `pricePenceFromPounds` is the one
// blessed conversion.
//
// NHS UDA figures are NOT money and are deliberately named apart. A UDA is a unit
// of activity; rendering `nhs_uda_value: 3` as "£3.00" would be a claim about a
// claim. They are carried as HUNDREDTHS, matching dashboard/money.ts.
//
// No clock is read here and no I/O is performed: this file is a pure function of
// its arguments, callable from a server component without a cache boundary.
// ===========================================================================

import { FUNDING_LABEL, fundingFromPlanId, type FundingCode } from "@/lib/calendar/funding";
import type { ChartItem } from "@/lib/charting/types";

// --- Input -----------------------------------------------------------------

/**
 * A plan item as this panel needs it: everything the chart already maps, plus the
 * two facts the chart never needed.
 *
 * `treatmentAppointmentId` is REQUIRED and nullable rather than optional. Optional
 * would mean a data layer that simply forgot to read the field compiled cleanly
 * and produced a panel where 100% of items looked unassigned — a wrong screen that
 * passes every type check.
 */
export interface PlanPanelItem extends ChartItem {
  /** The card this row belongs to, or null when Dentally attached it to none —
   *  which is the majority case on live data. */
  treatmentAppointmentId: string | null;
  /** WHOLE PENCE. See the units note in the file header: this is not
   *  ChartItem.price, and conflating them is a 100x money bug. */
  pricePence: number;
}

/** One treatment_appointment: the card itself, without its rows. The date, time
 *  and practitioner in the card header come from the linked diary appointment
 *  (`appointmentId`), not from this record — see PLAN-PANEL.md §2. */
export interface PlanAppointment {
  id: string;
  /** Dentally's own ordering. position 0 IS "Appt. 1"; numbering is never invented. */
  position: number;
  appointmentId: string | null;
  /** The note printed in the card header. Readable; editing it is gated. */
  notes: string | null;
  bookable: boolean;
}

/**
 * The treatment_plan itself.
 *
 * The three value fields are NULLABLE, and that is load-bearing. A figure Dentally
 * did not give us is reported as absent so the footer can say so; a plausible
 * zero on a money line is the house's oldest recorded mistake.
 */
export interface PlanHeader {
  id: string;
  nickname: string | null;
  completed: boolean;
  completedAt: string | null;
  startDate: string | null;
  endDate: string | null;
  paymentPlanId: number | null;
  practitionerId: string | null;
  /** private_treatment_value, in WHOLE PENCE. */
  privateTreatmentValuePence: number | null;
  /** nhs_uda_value in HUNDREDTHS of a UDA. Units of activity, not money. */
  nhsUdaHundredths: number | null;
  /** nhs_completed_uda_value in HUNDREDTHS of a UDA. */
  nhsCompletedUdaHundredths: number | null;
}

export interface PlanPanelInput {
  plan: PlanHeader;
  appointments: PlanAppointment[];
  items: PlanPanelItem[];
}

// --- Output ----------------------------------------------------------------

/** One rendered row. The item is carried whole rather than flattened, so the row
 *  cannot drift from what the chart above it drew from the same record. */
export interface PlanPanelRow {
  item: PlanPanelItem;
  funding: FundingCode;
  /** "" for `unknown`, deliberately: an unresolved payment plan prints NOTHING,
   *  never a dash or the word "Unknown", either of which a reader could take for
   *  a fact about the treatment. FUNDING_LABEL owns that rule. */
  fundingLabel: string;
}

/** A group footer. Summed from the group's OWN rows, so what the footer says
 *  always equals what the reader can count above it. */
export interface GroupTotals {
  itemCount: number;
  completedCount: number;
  durationMin: number;
  pricePence: number;
  /** Rows whose duration or price was not a finite number. Counted so the footer
   *  can caveat itself rather than presenting a short total as complete. */
  unreadableFigures: number;
}

interface GroupBase {
  /** Stable across renders: the appointment id, or UNASSIGNED_GROUP_KEY. */
  key: string;
  label: string;
  rows: PlanPanelRow[];
  totals: GroupTotals;
  /** The DISTINCT funding codes present, canonically ordered. A card may
   *  legitimately mix NHS and private work; there is no single winner and
   *  picking one would mislabel real rows. */
  funding: FundingCode[];
}

export interface AppointmentGroup extends GroupBase {
  kind: "appointment";
  appointment: PlanAppointment;
  /** position + 1. NULL when `position` was unreadable: an unnumbered card is
   *  honest, an invented "Appt. 1" is not. */
  number: number | null;
}

export interface UnassignedGroup extends GroupBase {
  kind: "unassigned";
  /** A rendered sentence stating WHY these rows have no card. */
  reason: string;
  counts: UnassignedCounts;
}

/**
 * THE union that makes forgetting the bucket a compile error under `switch`.
 * See the file header.
 */
export type PlanPanelGroup = AppointmentGroup | UnassignedGroup;

export interface UnassignedCounts {
  /** Dentally attached the item to no appointment at all. 83% of live rows. */
  noAppointmentId: number;
  /** The item names an appointment that was not in the appointments we read. */
  unknownAppointmentId: number;
}

export interface PlanTotals {
  /** From the plan's own private_treatment_value. NOT a sum of the rows: the two
   *  are different claims and Dentally's is the authoritative one. */
  privateTreatmentValuePence: number | null;
  nhsUdaHundredths: number | null;
  nhsCompletedUdaHundredths: number | null;
  /** Summed from items with charged === false. Live sampling found charged false
   *  on 100/100 items, so uncharged == total is the NORMAL reading, not a bug —
   *  and the line still renders when it is zero. */
  unchargedPence: number;
  unchargedItemCount: number;
  /** The sum of every row on screen. Kept beside the plan's own figure rather
   *  than replacing it, so a mismatch between them is visible instead of hidden. */
  itemsPricePence: number;
  itemsDurationMin: number;
}

/** Proof that the panel renders everything it was handed. */
export interface PlanPanelReconciliation {
  inputItemCount: number;
  groupedItemCount: number;
  balanced: boolean;
}

export interface PlanPanelModel {
  plan: PlanHeader;
  /**
   * THE ONLY ROW-BEARING FIELD. Appointment cards in position order, then the
   * unassigned bucket last. Render this; there is nothing else to render.
   */
  groups: PlanPanelGroup[];
  appointmentGroupCount: number;
  unassignedItemCount: number;
  totals: PlanTotals;
  /** Distinct funding across every row on the plan. */
  funding: FundingCode[];
  /** The plan record's OWN payment plan, which is a different fact from what its
   *  items are funded by, and is kept apart for exactly that reason. */
  headerFunding: FundingCode;
  reconciliation: PlanPanelReconciliation;
}

// --- Constants -------------------------------------------------------------

export const UNASSIGNED_GROUP_KEY = "unassigned";
/**
 * THE ONE SPELLING of the bucket's heading, and it is used from one place.
 *
 * It read "Not in an appointment" here while the card that renders it hardcoded
 * "Not on an appointment", so the constant was dead and the screen carried a
 * second, unowned copy of the same label. Settled on "on", which is the wording
 * the rest of this feature already uses ("these lines belong to no appointment"),
 * and the card now imports it rather than spelling it again.
 */
export const UNASSIGNED_LABEL = "Not on an appointment";
/** A card whose `position` we could not read. Never "Appt. 1". */
export const UNNUMBERED_APPOINTMENT_LABEL = "Appointment";

/** Canonical badge order, so two cards with the same funding mix never render it
 *  in two different orders. */
const FUNDING_ORDER: readonly FundingCode[] = ["nhs", "private", "udc", "unknown"];

// --- Helpers ---------------------------------------------------------------

/** Pounds to whole pence, for the one caller that has established the unit.
 *  Rounded to the nearest penny; a non-finite input is 0 and is reported by the
 *  totals' unreadableFigures rather than being hidden. */
export function pricePenceFromPounds(pounds: number): number {
  return Number.isFinite(pounds) ? Math.round(pounds * 100) : Number.NaN;
}

function finite(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n);
}

function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

/**
 * The sentence printed on the unassigned bucket.
 *
 * Exported and pure so the wording is testable: this is the one piece of copy on
 * the panel that explains away 83% of a real patient's plan, and it has to be
 * right in both the singular and the plural.
 */
export function describeUnassigned(counts: UnassignedCounts): string {
  const { noAppointmentId: none, unknownAppointmentId: ghost } = counts;
  const total = none + ghost;
  if (total === 0) return "Every item on this plan sits in an appointment.";

  const tail = `${total === 1 ? "It" : "They"} ${total === 1 ? "is" : "are"} listed here in full.`;
  const parts: string[] = [];

  if (none > 0) {
    parts.push(
      `${none} ${plural(none, "item")} ${none === 1 ? "is" : "are"} not attached to an ` +
        `appointment in Dentally, so ${none === 1 ? "it has" : "they have"} no card.`,
    );
  }
  if (ghost > 0 && none > 0) {
    parts.push(
      `A further ${ghost} ${ghost === 1 ? "references" : "reference"} an appointment that ` +
        `was not returned with this plan.`,
    );
  } else if (ghost > 0) {
    parts.push(
      `${ghost} ${plural(ghost, "item")} ${ghost === 1 ? "references" : "reference"} an ` +
        `appointment that was not returned with this plan, so ${ghost === 1 ? "it" : "they"} ` +
        `cannot be placed on a card.`,
    );
  }

  parts.push(tail);
  return parts.join(" ");
}

/** Totals for a set of rows. Zero is a real value and is summed like any other:
 *  a £0.00 examination is a row on the plan, not an absence. */
function totalsOf(rows: PlanPanelRow[]): GroupTotals {
  let durationMin = 0;
  let pricePence = 0;
  let completedCount = 0;
  let unreadableFigures = 0;

  for (const { item } of rows) {
    let bad = false;
    if (finite(item.durationMin)) durationMin += item.durationMin;
    else bad = true;
    if (finite(item.pricePence)) pricePence += item.pricePence;
    else bad = true;
    if (item.completed) completedCount += 1;
    if (bad) unreadableFigures += 1;
  }

  return { itemCount: rows.length, completedCount, durationMin, pricePence, unreadableFigures };
}

function fundingOf(rows: PlanPanelRow[]): FundingCode[] {
  const present = new Set(rows.map((r) => r.funding));
  return FUNDING_ORDER.filter((code) => present.has(code));
}

function toRow(item: PlanPanelItem): PlanPanelRow {
  const funding = fundingFromPlanId(item.paymentPlanId);
  return { item, funding, fundingLabel: FUNDING_LABEL[funding] };
}

/**
 * Rows in the order Dentally holds them: by the item's own `position`, ties broken
 * by arrival order so the same read always renders the same way. An unreadable
 * position sorts last rather than to the top, where it would displace a real row 0.
 */
function sortRows(rows: PlanPanelRow[]): PlanPanelRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const pa = finite(a.row.item.position) ? a.row.item.position : Number.POSITIVE_INFINITY;
      const pb = finite(b.row.item.position) ? b.row.item.position : Number.POSITIVE_INFINITY;
      return pa === pb ? a.index - b.index : pa - pb;
    })
    .map((d) => d.row);
}

/** position 0 renders as "Appt. 1". PLAN-PANEL.md §2 confirmed this against live
 *  data; nothing here derives a number from render order. */
function cardNumber(position: number): number | null {
  return finite(position) && position >= 0 ? Math.trunc(position) + 1 : null;
}

// --- The engine ------------------------------------------------------------

/**
 * Build the whole panel model from one plan, its appointments and its items.
 *
 * Pure, total, and it never filters: every item handed in comes back out inside
 * exactly one group, and `reconciliation` proves it.
 */
export function buildPlanPanel(input: PlanPanelInput): PlanPanelModel {
  const { plan, appointments, items } = input;

  // Duplicate ids first-wins. Two groups for one id would put the same rows on
  // screen twice and break the reconciliation that the rest of this file leans on.
  const byId = new Map<string, PlanAppointment>();
  for (const appt of appointments) if (!byId.has(appt.id)) byId.set(appt.id, appt);

  const carded = new Map<string, PlanPanelRow[]>();
  for (const id of byId.keys()) carded.set(id, []);

  const loose: PlanPanelRow[] = [];
  const counts: UnassignedCounts = { noAppointmentId: 0, unknownAppointmentId: 0 };

  for (const item of items) {
    const row = toRow(item);
    const id = item.treatmentAppointmentId;
    if (id !== null && id !== "" && carded.has(id)) {
      carded.get(id)!.push(row);
      continue;
    }
    // NOT DROPPED, and the two reasons are counted apart because they are
    // different statements: "Dentally filed this against no appointment" (the
    // majority case) and "this names an appointment we did not read" (a paging or
    // permissions gap) need different words on screen.
    if (id === null || id === "") counts.noAppointmentId += 1;
    else counts.unknownAppointmentId += 1;
    loose.push(row);
  }

  const cards: AppointmentGroup[] = [...byId.values()].map((appointment) => {
    const rows = sortRows(carded.get(appointment.id) ?? []);
    const number = cardNumber(appointment.position);
    return {
      kind: "appointment",
      key: appointment.id,
      label: number === null ? UNNUMBERED_APPOINTMENT_LABEL : `Appt. ${number}`,
      appointment,
      number,
      rows,
      totals: totalsOf(rows),
      funding: fundingOf(rows),
    };
  });

  // By Dentally's own position, ties and unnumbered cards stable and last.
  const orderedCards = cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => {
      const na = a.card.number ?? Number.POSITIVE_INFINITY;
      const nb = b.card.number ?? Number.POSITIVE_INFINITY;
      return na === nb ? a.index - b.index : na - nb;
    })
    .map((d) => d.card);

  const groups: PlanPanelGroup[] = [...orderedCards];
  if (loose.length > 0) {
    const rows = sortRows(loose);
    groups.push({
      kind: "unassigned",
      key: UNASSIGNED_GROUP_KEY,
      label: UNASSIGNED_LABEL,
      rows,
      totals: totalsOf(rows),
      funding: fundingOf(rows),
      reason: describeUnassigned(counts),
      counts,
    });
  }

  const allRows = groups.flatMap((g) => g.rows);
  const itemTotals = totalsOf(allRows);
  let unchargedPence = 0;
  let unchargedItemCount = 0;
  for (const { item } of allRows) {
    if (item.charged) continue;
    unchargedItemCount += 1;
    if (finite(item.pricePence)) unchargedPence += item.pricePence;
  }

  return {
    plan,
    groups,
    appointmentGroupCount: orderedCards.length,
    unassignedItemCount: loose.length,
    totals: {
      privateTreatmentValuePence: plan.privateTreatmentValuePence,
      nhsUdaHundredths: plan.nhsUdaHundredths,
      nhsCompletedUdaHundredths: plan.nhsCompletedUdaHundredths,
      unchargedPence,
      unchargedItemCount,
      itemsPricePence: itemTotals.pricePence,
      itemsDurationMin: itemTotals.durationMin,
    },
    funding: fundingOf(allRows),
    headerFunding: fundingFromPlanId(plan.paymentPlanId),
    reconciliation: {
      inputItemCount: items.length,
      groupedItemCount: allRows.length,
      balanced: allRows.length === items.length,
    },
  };
}

// --- Narrowing helpers -----------------------------------------------------
// FOR INSPECTION AND TESTS. Neither of these is the render source: the panel
// renders `model.groups` in order, and reaching for appointmentGroups() to build
// the screen is precisely how 83% of a plan goes missing.

/** The appointment cards alone. Never render only these. */
export function appointmentGroups(model: PlanPanelModel): AppointmentGroup[] {
  return model.groups.filter((g): g is AppointmentGroup => g.kind === "appointment");
}

/** The bucket, or null when every item on the plan sits in a card. */
export function unassignedGroup(model: PlanPanelModel): UnassignedGroup | null {
  return model.groups.find((g): g is UnassignedGroup => g.kind === "unassigned") ?? null;
}
