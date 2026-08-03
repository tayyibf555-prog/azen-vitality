// ===========================================================================
// WHAT ONE TOOTH AND ONE SURFACE SHOULD LOOK LIKE.
//
// PURE.
//
// COLOUR ENCODES STATE, NOT TREATMENT FAMILY, and that is a correction rather
// than a preference. DENTALLY.md:91 records a STATE vocabulary. The diary's
// palette is keyed on appointment REASON strings and its family rules put
// filling, crown, bridge, veneer, inlay, onlay, composite and bonding in ONE
// slot, so a restorative chart drawn from it would be a single amber; and
// treatment-type.ts's own banner says colour is not the safety channel BECAUSE
// the treatment name is printed on the block, which a 20px trapezoid cannot do.
// paletteSlotFor is deliberately NOT imported here.
//
// COLOURS TRAVEL AS CSS CUSTOM PROPERTY NAMES and land in `style` or an SVG
// `fill`. NEVER in an interpolated Tailwind arbitrary-value class: globals.css
// keeps these variables outside @theme inline on purpose, so a background
// utility built around one of them renders TRANSPARENT and a completed filling
// would draw as an unmarked tooth. The example is not spelled out here, because
// Tailwind v4's scanner reads raw source rather than parsing comments and will
// happily emit a rule from a class name written inside one.
//
// FUNDING IS NOT REDEFINED HERE. src/lib/calendar/funding.ts owns that
// vocabulary and this module reads through it.
// ===========================================================================

import { fundingFromPlanId, type FundingCode } from "@/lib/calendar/funding";
import { isDeciduous } from "./fdi";
import {
  regionForIndex,
  regionsForBoxSide,
  surfaceIndicesOf,
  surfaceLayout,
  type SurfaceRegion,
} from "./surfaces";
import type {
  ChartItem,
  DraftEntry,
  Dentition,
  PlanRow,
  SurfaceId,
  SurfaceOrigin,
  SurfaceStyle,
  ToothMark,
} from "./types";

/**
 * The five origins, plus "none". Everything is derived from the ORIGIN ALONE,
 * so chart-legend.tsx rendering from this function genuinely cannot drift from
 * what the arch draws.
 *
 * The draft is the only dashed, glyphed, unfilled one. That is deliberate and
 * tested: a distinction carried by hue alone does not survive a photocopy into
 * a complaint file or a red-green deficient reader.
 *
 * THE VARIABLE NAMES ARE THE STABLE INTERFACE; THE COLOURS BEHIND THEM ARE NOT.
 * Every fill and line moved in the legibility pass — the four fills went from
 * roughly 1.1:1 against the card to 1.8-3.1:1, because side by side with Dentally
 * ours read as pale cream where theirs read as a saturated gold, and this screen
 * is read from a metre away. Not one name changed and not one origin changed hue
 * family, so nothing in this module or in tooth.tsx needed touching. The values,
 * the luminance ladder they form and the dichromat separation they were checked
 * against all live in the CHARTING block of globals.css, next to the numbers.
 *
 * WHICH STATE OWNS WHICH HUE IS NOT A VISUAL DECISION AND DOES NOT BELONG IN A
 * VISUAL PASS. CHARTING.md 5 records planned-vs-completed as a convention with no
 * reversed example found in any vendor checked, non-configurable by design in at
 * least one. Re-pointing an origin at a different fill variable here is a clinical
 * change: a reader who has learnt that gold means planned will read gold as
 * planned whatever this switch says.
 *
 * lineVar IS ALSO THE WHOLE-TOOTH RING. tooth.tsx strokes a surfaceless finding —
 * an extraction, crown, bridge, endodontic or implant — with the origin's lineVar
 * at 3px around the crown, which is the ONLY mark such an item ever gets. So a
 * line variable is never merely the outline of its own fill: it has to hold up
 * alone, in a colour a reader can tell from the other four rings. Anything that
 * weakens the -line values weakens the mark that exists to stop a wrong-site
 * event, and it will look like a hairline tweak when it does.
 */
export function surfaceStyle(origin: SurfaceOrigin): SurfaceStyle {
  switch (origin) {
    case "dentally-completed":
      return {
        fillVar: "--chart-completed-fill",
        lineVar: "--chart-completed-line",
        dashed: false,
        glyph: "none",
        label: "Completed in Dentally",
      };
    case "dentally-planned":
      return {
        fillVar: "--chart-planned-fill",
        lineVar: "--chart-planned-line",
        dashed: false,
        glyph: "none",
        label: "Planned in Dentally",
      };
    case "dentally-unaccepted":
      return {
        fillVar: "--chart-unaccepted-fill",
        lineVar: "--chart-unaccepted-line",
        dashed: false,
        glyph: "none",
        label: "On a treatment plan the patient has not accepted",
      };
    case "dentally-base":
      return {
        fillVar: "--chart-base-fill",
        lineVar: "--chart-base-line",
        dashed: false,
        glyph: "none",
        label: "From the base chart in Dentally",
      };
    case "draft":
      return {
        fillVar: null,
        lineVar: "--chart-draft-line",
        dashed: true,
        glyph: "draft",
        label: "Planned here, and not sent to Dentally",
      };
    default:
      return {
        fillVar: null,
        lineVar: "--chart-tooth-line",
        dashed: false,
        glyph: "none",
        label: "No treatment item read for this surface",
      };
  }
}

function planStatusOf(planId: string | null, plans: readonly PlanRow[]) {
  if (!planId) return null;
  return plans.find((p) => p.id === planId)?.status ?? null;
}

/** The origin of one Dentally item, ignoring the draft entirely. */
function originOfItem(item: ChartItem, plans: readonly PlanRow[]): SurfaceOrigin {
  // Precedence: a FACT about the tooth outranks an INTENTION. Completed work
  // and base-chart work are both facts; planned and unaccepted are intentions.
  if (item.completed) return "dentally-completed";
  if (item.baseChart) return "dentally-base";
  // An item on a plan we could not read is PLANNED, never unaccepted: a failed
  // plans read must not demote treatment the patient actually agreed to.
  return planStatusOf(item.planId, plans) === "unaccepted"
    ? "dentally-unaccepted"
    : "dentally-planned";
}

const ORIGIN_RANK: Record<SurfaceOrigin, number> = {
  "dentally-completed": 0,
  "dentally-base": 1,
  "dentally-planned": 2,
  "dentally-unaccepted": 3,
  draft: 4,
  none: 5,
};

/**
 * Does this item put a fill on THIS region of THIS tooth?
 *
 * TWO VOCABULARIES REACH THE SAME PIXEL, and this is the one place they meet.
 * A row can arrive naming a SURFACE ("MO", from the mock and from our own draft
 * table) or an INDEX ([3, 8], which is what live Dentally actually sends —
 * CHARTING.md §2.6, measured across production). Matching only the first was the
 * defect: on a real patient `item.surfaces` is empty on every row, so every
 * restoration filled nothing and the arch drew thirty-two clean teeth for a
 * patient with a full restorative history.
 *
 * THE INDEX IS CHECKED AGAINST THIS TOOTH'S OWN SCHEME, not against the row.
 * charting-read keeps an index that any ONE of the row's teeth can hold — a
 * bridge spanning a molar and a premolar keeps the molar's 7 — so the same row
 * must still draw nothing on the premolar, which has no seventh region. That is
 * regionForIndex's null, honoured here rather than clamped onto a nearby region.
 */
function itemCoversRegion(
  item: ChartItem,
  fdi: number,
  surface: SurfaceId,
  region: SurfaceRegion,
): boolean {
  if (!item.teeth.includes(fdi)) return false;
  // A NAMED surface covers every region of its box side, which on a molar's
  // centre is all four quadrants: "O" is the whole occlusal table, and drawing
  // it as one quadrant would show a quarter of a filling the practice recorded
  // across the lot.
  if (item.surfaces.includes(surface)) return true;
  if (regionForIndex(fdi, region.index) === null) return false;
  return surfaceIndicesOf(item).includes(region.index);
}

/**
 * What fills ONE REGION of the grid.
 *
 * Where a draft sits on a surface Dentally already holds, DENTALLY OWNS THE
 * FILL and the draft draws on top: the mirror is the record, and our planning
 * must never obscure it. surfaceDraft() reports the overlay separately, so the
 * draft is still visible rather than hidden by precedence.
 *
 * The draft is still matched by NAME, because our own table stores letters and
 * has no index to offer. It therefore lights every region of its box side, which
 * is the same rule the named Dentally path follows.
 */
export function regionOrigin(
  fdi: number,
  surface: SurfaceId,
  region: SurfaceRegion,
  items: readonly ChartItem[],
  plans: readonly PlanRow[],
  draft: Readonly<Record<string, DraftEntry>>,
): SurfaceOrigin {
  let best: SurfaceOrigin = "none";
  for (const item of items) {
    if (!itemCoversRegion(item, fdi, surface, region)) continue;
    const origin = originOfItem(item, plans);
    if (ORIGIN_RANK[origin] < ORIGIN_RANK[best]) best = origin;
  }
  if (best !== "none") return best;
  return surfaceDraft(fdi, surface, draft) ? "draft" : "none";
}

/**
 * What fills this NAMED surface, taken across every region it covers.
 *
 * The roll-up, for a caller that thinks in surfaces rather than in regions. The
 * renderer uses regionOrigin because a molar's four centre quadrants can each
 * carry a different Dentally index and so a different origin; this returns the
 * strongest of them.
 */
export function surfaceOrigin(
  fdi: number,
  surface: SurfaceId,
  items: readonly ChartItem[],
  plans: readonly PlanRow[],
  draft: Readonly<Record<string, DraftEntry>>,
): SurfaceOrigin {
  const regions = regionsForBoxSide(fdi, surfaceLayout(fdi)[surface]);
  // A value that is not a tooth draws no region at all, so the named draft is
  // the only thing left that can be true of it.
  if (regions.length === 0) return surfaceDraft(fdi, surface, draft) ? "draft" : "none";
  let best: SurfaceOrigin = "none";
  for (const region of regions) {
    const origin = regionOrigin(fdi, surface, region, items, plans, draft);
    if (ORIGIN_RANK[origin] < ORIGIN_RANK[best]) best = origin;
  }
  return best;
}

/** True when this practice has planned this surface HERE. Always reported, even
 *  when Dentally already holds the surface. */
export function surfaceDraft(
  fdi: number,
  surface: SurfaceId,
  draft: Readonly<Record<string, DraftEntry>>,
): boolean {
  return Object.values(draft).some((e) => e.tooth === fdi && e.surfaces.includes(surface));
}

/**
 * WHOLE-TOOTH findings: an extraction, crown, bridge, endo or implant carries
 * parseable teeth and NO surfaces, so a per-surface renderer alone would draw a
 * clean, unmarked tooth for a planned extraction. That was the most direct
 * route from this screen to a wrong-site event, and it is fixed here in code
 * rather than in a sentence.
 */
export function toothMarks(
  fdi: number,
  items: readonly ChartItem[],
  draft: Readonly<Record<string, DraftEntry>>,
  plans: readonly PlanRow[] = [],
): ToothMark[] {
  const marks: ToothMark[] = items
    .filter((i) => i.wholeTooth && i.teeth.includes(fdi))
    .map((i) => ({ origin: originOfItem(i, plans), nomenclature: i.nomenclature, itemId: i.id }));
  // The reducer never produces a surfaceless draft entry, but a hydrate from
  // our own table could, and a whole-tooth plan drawn nowhere is the same
  // defect on our side of the line.
  for (const [key, entry] of Object.entries(draft)) {
    if (entry.tooth === fdi && entry.surfaces.length === 0) {
      marks.push({ origin: "draft", nomenclature: entry.treatmentName, itemId: key });
    }
  }
  return marks;
}

/**
 * Does this item draw ANYTHING on this tooth's grid?
 *
 * The exact complement of what the renderer paints, which is the point: this and
 * regionOrigin must answer from the same rule or the arch shows a fill with a
 * "could not place" ring over it, or worse, shows neither.
 */
function drawsOnTooth(item: ChartItem, fdi: number): boolean {
  // Every named surface has a box side on every tooth, so a name always draws.
  if (item.surfaces.length > 0) return true;
  return surfaceIndicesOf(item).some((n) => regionForIndex(fdi, n) !== null);
}

/**
 * Items on this tooth that draw NOTHING on it.
 *
 * DENTALLY.md's correction says surfaces arrive as INTEGERS, 1-5 and 1-8 on
 * molars. An index inside the tooth's own scheme now fills its region, so it is
 * NOT one of these. Two things still are, and both draw nothing without a mark
 * of their own:
 *   - a value we could not read at all (an unknown letter, a 9, a word), which
 *     lands in unrecognisedSurfaces; and
 *   - an index outside THIS tooth's scheme on a row that names several teeth —
 *     a bridge carrying a molar's 7 draws it on the molar and nothing on the
 *     premolar beside it, which without this mark is a premolar that silently
 *     drops a surface the row names.
 *
 * WITHOUT THIS FUNCTION such an item draws NOTHING. It is not whole-tooth, so it
 * gets no ring; it fills no region; and the tooth renders exactly as a tooth with
 * no findings. That is the same false claim as an unmarked extraction, arriving
 * by a different route, so the tooth carries a mark and the status bar a count.
 */
export function unreadSurfaceItems(fdi: number, items: readonly ChartItem[]): ChartItem[] {
  return items.filter((i) => i.teeth.includes(fdi) && !i.wholeTooth && !drawsOnTooth(i, fdi));
}

/**
 * The values we could not place on THIS tooth, printed verbatim.
 *
 * Verbatim because surfaces.ts refuses to name an index it cannot place: the
 * mark says only that something is here, and the number beside it is what lets a
 * clinician find the row in Dentally. Unreadable values and out-of-scheme indices
 * are printed alike, because to the reader they are the same fact.
 */
export function unreadValuesFor(fdi: number, items: readonly ChartItem[]): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    if (v.length > 0 && !out.includes(v)) out.push(v);
  };
  for (const item of unreadSurfaceItems(fdi, items)) {
    for (const v of item.unrecognisedSurfaces) add(v);
    for (const n of surfaceIndicesOf(item)) {
      if (regionForIndex(fdi, n) === null) add(String(n));
    }
  }
  return out;
}

/**
 * Every item anywhere in the read that draws on none of the teeth it names, so
 * the status bar can state a count without walking the arch.
 *
 * A ROW THAT NAMES NO TOOTH is only counted when the surfaces THEMSELVES were
 * unreadable. An examination, a radiograph and a denture all name no tooth and no
 * surface, and on a real chart they are most of the rows: counting them printed a
 * large "could not place" figure on every patient and taught the reader to ignore
 * the one signal that matters.
 */
export function unreadSurfaceCount(items: readonly ChartItem[]): number {
  return items.filter((i) => {
    if (i.wholeTooth) return false;
    if (i.teeth.length === 0) return i.unrecognisedSurfaces.length > 0;
    return !i.teeth.some((t) => drawsOnTooth(i, t));
  }).length;
}

const FUNDING_ORDER: readonly FundingCode[] = ["nhs", "private", "udc", "unknown"];

/**
 * EVERY distinct funding code on this tooth.
 *
 * An array, not one value: a tooth can carry an NHS filling AND a private
 * crown, and picking one by unstated precedence would print a funding rail that
 * is simply untrue. The rail draws one segment per code.
 */
export function toothFunding(fdi: number, items: readonly ChartItem[]): FundingCode[] {
  const found = new Set<FundingCode>();
  for (const item of items) {
    if (!item.teeth.includes(fdi)) continue;
    found.add(fundingFromPlanId(item.paymentPlanId));
  }
  return FUNDING_ORDER.filter((c) => found.has(c));
}

/**
 * Items on the dentition this view does NOT draw.
 *
 * A mixed-dentition child whose deciduous findings simply vanish is the failure
 * this exists to count. Silently gone was the defect; a count is the floor.
 */
export function offArchItems(items: readonly ChartItem[], dentition: Dentition): ChartItem[] {
  if (dentition === "combined" || dentition === "base") return [];
  const wantDeciduous = dentition === "deciduous";
  return items.filter(
    // A tooth-less row is UNPLACED, not off-arch, and is counted separately.
    (i) => i.teeth.length > 0 && !i.teeth.some((t) => isDeciduous(t) === wantDeciduous),
  );
}
