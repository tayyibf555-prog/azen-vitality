// ===========================================================================
// GROUPING FOR THE HOVER TOOLTIP AND THE HISTORY VIEW.
//
// PURE.
//
// WHAT THIS IS, PLAINLY: the history contained in /v1/treatment_plan_items, and
// NOT Dentally's full clinical history, which also holds base-chart changes,
// clinical notes and periodontal assessments. The sentence that says so lives
// in CANNOT_READ_COPY.chartHistoryScope and is rendered at the top of History
// and in the tooltip, because a narrower history presented as the whole one is
// the same class of claim as an empty read presented as an empty patient.
//
// SORTING: newest first by completedAt, then updatedAt, then createdAt. A date
// that will not parse sorts LAST and is still PRESENT. Sorting it to the epoch
// would bury a real finding at the bottom AND make it look ancient; dropping it
// would remove a finding from a clinical screen.
// ===========================================================================

import { toothLabel } from "./fdi";
import { serialiseSurfaces, surfaceIndicesOf } from "./surfaces";
import type { ChartItem, PlanRow } from "./types";

/**
 * Dentally's own surface numbers, as a phrase, and VERBATIM.
 *
 * DENTALLY.md's instruction, in its own words: fill the correct region, and print
 * the index until Dentally confirms the anatomy. So this says "surfaces 3, 8" and
 * never "distal and disto-buccal" — the mapping from index to named surface
 * depends on how Dentally orients each quadrant and nothing public says. A
 * printed guess is a wrong-surface clinical claim; a printed number is a
 * reconcilable fact.
 *
 * ONE FUNCTION for History, the hover tooltip and the CSV, because three renderers
 * each writing their own phrasing is how an exported chart and the screen it came
 * from end up disagreeing about what Dentally holds.
 */
export function surfaceIndexText(indices: readonly number[]): string {
  if (indices.length === 0) return "";
  return `${indices.length === 1 ? "surface" : "surfaces"} ${indices.join(", ")}`;
}

export interface HistoryLine {
  itemId: string;
  /** "UR6", or "UR6, UR4" for an item on several teeth, or "" when unplaced. */
  toothLabel: string;
  /** The single tooth this line is about, or null when it names several or none. */
  fdi: number | null;
  /** The two-digit FDI number, or numbers, as printed beside the label. It
   *  travels with every line because reconciling against Dentally, which prints
   *  the number, is this screen's purpose. */
  fdiLabel: string;
  /** What Dentally actually sent, kept verbatim for the unplaced case. */
  rawTeeth: string;
  /** The surfaces CODE ("MOD"), not the surface list. Empty for a whole-tooth
   *  item, which is why the renderer prints "Whole tooth" rather than nothing.
   *
   *  ONE SPELLING. The History table and the tooth tooltip were built in
   *  parallel against `surfaces` and `surfacesCode`, and the two were carried as
   *  identical aliases so they could not diverge before they were reconciled.
   *  They are now reconciled: two names for one value on a clinical line is how
   *  a renderer ends up printing the stale one. */
  surfaces: string;
  /** Dentally's own surface NUMBERS for this row, which on live data is the only
   *  form that ever arrives. Carried separately from `surfaces` because it is a
   *  different vocabulary and printing it as letters would name an anatomy nobody
   *  has confirmed. Empty on the mock, which speaks in letters. */
  surfaceIndices: number[];
  /** The same numbers as a phrase, already built, so the History table, the hover
   *  tooltip and the CSV cannot phrase Dentally's record three different ways. */
  surfaceIndexText: string;
  unrecognisedSurfaces: string[];
  wholeTooth: boolean;
  baseChart: boolean;
  nomenclature: string | null;
  price: number;
  completed: boolean;
  planId: string | null;
  planLabel: string | null;
  /** null when the plan could not be read. NEVER defaulted to "accepted". */
  planStatus: PlanRow["status"] | null;
  date: string | null;
}

function dateOf(item: ChartItem): string | null {
  return item.completedAt ?? item.updatedAt ?? item.createdAt ?? null;
}

/** Milliseconds, or null when it will not parse. */
function timeOf(item: ChartItem): number | null {
  const raw = dateOf(item);
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function lineFor(item: ChartItem, fdi: number | null, plans: readonly PlanRow[]): HistoryLine {
  const plan = item.planId ? plans.find((p) => p.id === item.planId) : undefined;
  const code = serialiseSurfaces(item.surfaces);
  // WITHOUT THIS, HISTORY GOES BLANK ON LIVE DATA. `surfaces` is a letter code and
  // live Dentally sends none: a real filling then printed neither a code nor an
  // unrecognised value, so the one column that says WHERE on the tooth was empty
  // on every row of a real patient's clinical history and of its export.
  const indices = surfaceIndicesOf(item);
  return {
    itemId: item.id,
    toothLabel:
      fdi !== null ? toothLabel(fdi) : item.teeth.map((t) => toothLabel(t)).join(", "),
    fdi,
    fdiLabel: fdi !== null ? String(fdi) : item.teeth.join(", "),
    rawTeeth: item.rawTeeth,
    surfaces: code,
    surfaceIndices: indices,
    surfaceIndexText: surfaceIndexText(indices),
    unrecognisedSurfaces: [...item.unrecognisedSurfaces],
    wholeTooth: item.wholeTooth,
    baseChart: item.baseChart,
    nomenclature: item.nomenclature,
    price: item.price,
    completed: item.completed,
    planId: item.planId,
    planLabel: plan?.label ?? null,
    planStatus: plan?.status ?? null,
    date: dateOf(item),
  };
}

/** Newest first, unparseable dates last. */
function byDate(a: ChartItem, b: ChartItem): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta;
}

/**
 * One tooth's history, for the hover-and-focus tooltip.
 *
 * An item on several teeth appears in EVERY one of their histories: a bridge is
 * not the property of one abutment, and attributing it to the first tooth only
 * hides it from the tooth the clinician happens to hover.
 */
export function toothHistory(
  items: readonly ChartItem[],
  fdi: number,
  plans: readonly PlanRow[] = [],
): HistoryLine[] {
  return [...items]
    .filter((i) => i.teeth.includes(fdi))
    .sort(byDate)
    .map((i) => lineFor(i, fdi, plans));
}

export interface HistoryFilter {
  query?: string;
  planId?: string | null;
  completedOnly?: boolean;
  /** Default TRUE. An unplaced item is the one the parser could not draw, so
   *  excluding it by default would make History agree with the arch about a
   *  finding neither of them is showing. */
  includeUnplaced?: boolean;
  plans?: readonly PlanRow[];
}

export function historyLines(items: readonly ChartItem[], filter: HistoryFilter): HistoryLine[] {
  const plans = filter.plans ?? [];
  const includeUnplaced = filter.includeUnplaced !== false;
  const query = (filter.query ?? "").trim().toLowerCase();
  return [...items]
    .filter((i) => {
      if (!includeUnplaced && i.teeth.length === 0) return false;
      if (filter.planId && i.planId !== filter.planId) return false;
      if (filter.completedOnly && !i.completed) return false;
      return true;
    })
    .sort(byDate)
    .map((i) => lineFor(i, null, plans))
    .filter((line) => {
      if (query.length === 0) return true;
      const haystack = [
        line.toothLabel,
        line.fdiLabel,
        line.rawTeeth,
        line.surfaces,
        // Searchable, or a clinician who has Dentally open beside them and types
        // the surface number it shows them finds nothing.
        line.surfaceIndexText,
        line.nomenclature ?? "",
        line.planLabel ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
}

export interface PlanGroup {
  planId: string | null;
  label: string;
  status: PlanRow["status"] | null;
  /** The raw items, so a caller holding its own filters can re-run
   *  historyLines over one plan rather than re-deriving the grouping. */
  items: ChartItem[];
  /** The same rows already rendered as lines, for a caller that has no filters. */
  lines: HistoryLine[];
}

/**
 * History grouped by treatment plan.
 *
 * Items with NO plan get their own group. Merging them into the first plan
 * would attribute treatment to a plan the patient may never have seen, and the
 * plan tabs are what a TP: button opens.
 */
export function groupByPlan(items: readonly ChartItem[], plans: readonly PlanRow[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const item of [...items].sort(byDate)) {
    const key = item.planId ?? "";
    const line = lineFor(item, null, plans);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      existing.lines.push(line);
      continue;
    }
    groups.set(key, {
      planId: item.planId,
      label:
        line.planLabel ??
        // A plan id we could not read is NOT the same as no plan at all, and
        // neither is "Plan 1". Both say so in their own words.
        (item.planId === null ? "Not attached to a treatment plan" : "Treatment plan not read"),
      status: line.planStatus,
      items: [item],
      lines: [line],
    });
  }
  return [...groups.values()];
}
