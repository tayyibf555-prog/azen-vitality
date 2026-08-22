// ---------------------------------------------------------------------------
// The diary's VIEW logic: everything the column grid needs to decide that is not
// already answered by diary-grid.ts (placement, lanes, bounds, the now-line and
// the column set, all of which are used here exactly as they are given).
//
// It lives in a .ts and not in the .tsx because the board is a client component
// and vitest collects only src/**/*.test.ts, in a node environment with no jsdom.
// The threshold numbers below (13 / 20 / 34 px), the edge-rounding rule and the
// state treatments are exactly the kind of values that drift silently, so they
// are pure, exported and tested rather than inlined into a component.
//
// Two rules govern the whole file:
//   - an appointment drawn at the wrong time or against the wrong clinician is a
//     patient-safety event, so geometry rounds the EDGES and never the height,
//   - nothing here quantifies free time. The one exception is a gap bounded on
//     both sides by a drawn block, which is a fact about the booked day rather
//     than a claim about who is working.
// ---------------------------------------------------------------------------

import type { Weekday } from "@/lib/types";
import { FUNDING_LABEL, type FundingCode } from "@/lib/calendar/funding";
import { mergeSpans } from "@/lib/calendar/working-spans";
import { diaryColumns, effectiveMinutes, labelMinutes, londonMinutes, type DiaryColumn } from "./diary-grid";
import { stateLabel } from "./calendar-logic";
import { typeLabelFor } from "./treatment-type";

// --- zoom, and the layout constants the grid is built from ---------------------

export type Zoom = "compact" | "normal" | "roomy";

/**
 * Pixels per five minutes, at each density.
 *
 * Whole pixels per five-minute slot at every step, so every Dentally-aligned
 * booking tiles exactly and a run of back-to-back 15 minute appointments has no
 * accumulating half-pixel seam between the blocks.
 */
export const PX_PER_5MIN: Record<Zoom, number> = { compact: 8, normal: 12, roomy: 16 };

/** 1.6 / 2.4 / 3.2 px per minute. One constant governs blocks, rules and the now-line. */
export function pxPerMinute(zoom: Zoom): number {
  return PX_PER_5MIN[zoom] / 5;
}

/** The time gutter, at lg and above. */
export const GUTTER_PX = 52;
/** The narrower gutter below lg, where the diary shows a single column. */
export const GUTTER_PX_SM = 44;
/** A clinician column never draws narrower than this before the grid scrolls sideways. */
export const COL_MIN_PX = 112;
/**
 * The sticky column-header row.
 *
 * 56, not 44, because the day header now carries THREE lines: the clinician, the
 * booked count, and the free-time figure. Two lines at 44px left no room for the
 * third, and the free figure is the one a practice manager scans across the row
 * when somebody calls in sick — it cannot be the line that gets clipped. Twelve
 * pixels of chrome buys the answer to "who has room this afternoon".
 */
export const HEADER_PX = 56;

/** Cookie holding the remembered row height, read server-side so the first paint is right. */
export const DIARY_ZOOM_COOKIE = "az_diary_zoom";

/** The stored zoom, defaulting to Normal for anything unrecognised or unset. */
export function parseZoom(raw: string | null | undefined): Zoom {
  return raw === "compact" || raw === "roomy" ? raw : "normal";
}

// --- opening hours ------------------------------------------------------------

/** The fallback window when a site has no usable one: it makes NO claim about being closed. */
const DEFAULT_OPEN_MIN = 8 * 60;
const DEFAULT_CLOSE_MIN = 19 * 60;

/**
 * "09:00-17:30" as minutes past midnight.
 *
 * Anything missing, malformed, or ending at or before it starts falls back to
 * the existing 08:00 to 19:00 defaults rather than collapsing the grid. These
 * hours only ever EXTEND or trim the drawn extent: nothing counts against them,
 * because they live in our own config and have never been verified against the
 * practice.
 */
export function parseOpeningWindow(spec: string | null | undefined): { openMin: number; closeMin: number } {
  const fallback = { openMin: DEFAULT_OPEN_MIN, closeMin: DEFAULT_CLOSE_MIN };
  if (typeof spec !== "string") return fallback;
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(spec);
  if (!m) return fallback;
  const openMin = Number(m[1]) * 60 + Number(m[2]);
  const closeMin = Number(m[3]) * 60 + Number(m[4]);
  if (!Number.isFinite(openMin) || !Number.isFinite(closeMin)) return fallback;
  if (openMin < 0 || closeMin > 24 * 60) return fallback;
  if (closeMin <= openMin) return fallback;
  return { openMin, closeMin };
}

const WEEKDAYS: Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** The weekday a YYYY-MM-DD day key falls on. UTC-anchored: the key is already the London day. */
export function weekdayOf(dayIso: string): Weekday {
  const d = new Date(`${dayIso}T00:00:00Z`);
  const idx = d.getUTCDay();
  return WEEKDAYS[Number.isFinite(idx) ? idx : 1];
}

/** A site's opening window for a given day key, falling back when it is unset (a closed day). */
export function openingWindowFor(
  hours: Partial<Record<Weekday, string | null>> | null | undefined,
  dayIso: string,
): { openMin: number; closeMin: number } {
  return parseOpeningWindow(hours?.[weekdayOf(dayIso)] ?? null);
}

// --- geometry -----------------------------------------------------------------

/**
 * Where a block sits and how tall it is.
 *
 * BOTH edges are derived from the same px-per-minute constant and rounded; the
 * height is their difference and is never rounded on its own. Rounding top and
 * height independently lets a 10 minute block at 09:10 and one at 09:20 either
 * overlap by a pixel or show a false 1px gap, and a false gap on a diary reads
 * as a free slot.
 */
export function blockEdges(
  startMin: number,
  endMin: number,
  boundsStartMin: number,
  zoom: Zoom,
): { top: number; height: number } {
  const ppm = pxPerMinute(zoom);
  const top = Math.round((startMin - boundsStartMin) * ppm);
  const bottom = Math.round((endMin - boundsStartMin) * ppm);
  return { top, height: bottom - top };
}

// --- the degrade ladder -------------------------------------------------------

export type BlockTier = "full" | "lead" | "name" | "bar";

const TIER_RANK: Record<BlockTier, number> = { full: 3, lead: 2, name: 1, bar: 0 };
const RANK_TIER: BlockTier[] = ["bar", "name", "lead", "full"];

/**
 * The height of each line a block can draw, and the 1px hairline top and bottom.
 *
 * These are the numbers the thresholds below are DERIVED from, so the two can
 * never drift apart: the tier decides what exists, and a tier that admits a line
 * its own threshold cannot fit is a name rendered with its descenders sliced off.
 *
 * The block now carries the reference's dense WRAPPED text rather than a name
 * line and one truncated meta line, so there are exactly two line heights:
 *   lead line: 10px  at leading-[1.15] = 11.5   (time + short patient name, bold)
 *   body line: 9.5px at leading-[1.25] = 11.875, rounded to 12 for the arithmetic
 */
export const LINE_LEAD_PX = 11.5;
export const LINE_BODY_PX = 12;
export const BLOCK_BORDER_PX = 2;

/**
 * The vertical padding AppointmentBlock draws at each tier.
 *
 * It TIGHTENS as the block shortens rather than staying at a flat 4px, which is
 * what lets the 32 / 20 / 13 thresholds below stay where they are while the text
 * they admit genuinely fits.
 */
export const BLOCK_PAD_Y: Record<BlockTier, number> = { full: 3, lead: 3, name: 0, bar: 0 };

/** The usable height inside a block of this outer height at this tier. */
export function blockInnerHeight(heightPx: number, tier: BlockTier): number {
  return heightPx - BLOCK_BORDER_PX - 2 * BLOCK_PAD_Y[tier];
}

/**
 * How many WRAPPED body lines fit under the lead line in a block this tall.
 *
 * 19.5 is 2px of border plus 6px of padding plus the 11.5px lead line, so this
 * is derived from the constants above rather than guessed:
 *   32px  (the "full" threshold)      -> 1 line
 *   60px  (25 minutes at Normal)      -> 3
 *   96px  (40 minutes at Normal)      -> 4, the cap
 *
 * Capped at four because beyond that it is a wall of text and the reference
 * itself tops out at four. The block clamps with -webkit-line-clamp at exactly
 * this count, so text fills the block and stops on a WHOLE line: nothing is ever
 * half-drawn with its descenders sliced off.
 */
export function bodyLineCount(heightPx: number): number {
  const fits = Math.floor((heightPx - 19.5) / LINE_BODY_PX);
  return Math.min(4, Math.max(1, fits));
}

/**
 * The width a block is DRAWN at, in px, for its share of a column.
 *
 * Measured against COL_MIN_PX and not the column's real width, because the
 * columns are minmax(112px, 1fr): 112 is the width they take on the day the
 * layout matters, which is a Saturday with thirteen clinicians on screen. Any
 * wider screen only ever gives a block MORE room than this says, so a decision
 * made here is never one the reader has to live with at a smaller size. Pure,
 * so the degrade ladder can be tested without a browser.
 */
export function blockWidthPx(span: number, lanes: number): number {
  return Math.max(0, Math.round((COL_MIN_PX * Math.max(0, span)) / Math.max(1, lanes)));
}

/**
 * Below this drawn width a block cannot carry "09:30 N.Lamprell" on one line, so
 * it carries "09:30" and moves the name down to line two.
 *
 * 76px is two thirds of a minimum column. Measured: 112px minus the 2px border,
 * the 10px left pad and the 18px right strip leaves 82px for text at full width,
 * which is sixteen characters at 10px; halve the column and 52px minus the same
 * chrome leaves 22px, which is four. The old block kept the one-line form at
 * every width and printed "09:3" against a patient nobody could name.
 */
export const BLOCK_NARROW_PX = 76;

/**
 * Below this a block carries a state mark and a short name and nothing else --
 * no time, no second line. A third of a minimum column is 37px.
 */
export const BLOCK_MARK_ONLY_PX = 50;

/**
 * Which children a block may draw at its actual height AND width.
 *
 * The tier decides what EXISTS; nothing is ever half-drawn by clipping. A
 * 5 minute block at Normal is 12px and carries no text at all, which is why the
 * state also reaches the reader through the block's title, the keyboard path and
 * the detail panel, and why one step to Roomy resolves it. It is deliberately
 * NOT floored to a 24px WCAG target: drawing a 5 minute appointment at a
 * 10 minute height is a lie about the booking.
 *
 * WIDTH, NOT LANE COUNT, IS THE CAP, and that is the correction. The cap used to
 * read the cluster's lane count, so a block that was drawn FULL WIDTH inside a
 * three-lane cluster -- which layoutColumn's expansion rule now makes the common
 * case on a busy column -- was demoted to a state mark and four characters of a
 * name for no reason a reader could see. A block that has the room draws what
 * fits in it.
 */
export function blockTier(heightPx: number, widthPx: number): BlockTier {
  const byHeight: BlockTier =
    heightPx >= 32 ? "full" : heightPx >= 20 ? "lead" : heightPx >= 13 ? "name" : "bar";
  const cap: BlockTier = widthPx < BLOCK_MARK_ONLY_PX ? "name" : "full";
  return RANK_TIER[Math.min(TIER_RANK[byHeight], TIER_RANK[cap])];
}

/** The horizontal chrome a block of this drawn width can afford. */
export interface BlockChrome {
  /** Time alone on line 1, patient name on line 2. See BLOCK_NARROW_PX. */
  narrow: boolean;
  /** The state mark sits before the text instead of in the top-right corner. */
  inlineGlyph: boolean;
  padLeft: number;
  padRight: number;
  railLeft: number;
  railWidth: number;
}

/**
 * The one place a block's horizontal chrome is decided.
 *
 * It was four ternaries inlined in the component, all keyed off the lane count,
 * and between them they spent 39px of a 52px half-width block on padding. The
 * numbers here are what is LEFT for text once the 3px state spine and the 3px
 * funding rail are cleared, and they tighten with the width rather than with the
 * lane count, which is the same correction blockTier makes.
 */
export function blockChrome(widthPx: number): BlockChrome {
  const narrow = widthPx < BLOCK_NARROW_PX;
  const tight = widthPx < BLOCK_MARK_ONLY_PX;
  return {
    narrow,
    // The corner square needs 16px of clear strip. Below the narrow threshold
    // that is a fifth of the block, so the mark moves inline instead of the
    // text being squeezed around it.
    inlineGlyph: narrow,
    // The spine is 3px and the rail sits just inboard of it: 8 clears both at
    // full size, 7 at the tightened rail.
    padLeft: tight ? 7 : narrow ? 8 : 10,
    // The clear strip on the right, and it has to hold BOTH marks: the 4px note
    // dot, a 3px gap, and the 13px state square, plus 3px off the edge. 18 was
    // measured on a block without a note and clipped the last two characters of
    // every patient who had one.
    padRight: narrow ? 9 : 24,
    railLeft: narrow ? 3 : 4,
    railWidth: narrow ? 2 : 3,
  };
}

/** A large enough off span to carry the word "Off" rather than being bare grey. */
export const OFF_LABEL_MIN_PX = 60;

// --- the eight state treatments -----------------------------------------------

/**
 * FILL HAS MOVED TO THE TREATMENT TYPE. `fill`, `hairline`, `nameInk` and
 * `metaInk` below are RETAINED but are no longer read by the block for anything
 * except the three states that genuinely override the type surface:
 *
 *   cancelled   forced to white (--card) with a dashed border and no spine. The
 *               ONE state that replaces the type fill, because it is the one
 *               state whose meaning is "this space is available", and
 *               availability is now the fill channel's other job.
 *   in_surgery  keeps the type fill at 100% and takes a 2px solid navy border.
 *   completed   the type fill at 55%, mixed toward --card rather than faded with
 *               opacity, which would fade the text with it.
 *
 * did_not_attend KEEPS its type fill with the 45 degree hatch OVER it, because
 * the slot was consumed.
 *
 * State therefore reaches the reader through four channels, none of them hue:
 *   1. the 3px left SPINE, in --status-*, which survives a fully wrapped block
 *   2. the CORNER LETTER top right (P C B clock S tick X DNA), the exact
 *      notation the practice was trained on
 *   3. BORDER WEIGHT: 1px --type-N-line normally, 2px --navy for in_surgery
 *   4. the non-hue treatments: dashed, hatched, 55% fill
 */
export interface BlockStyle {
  /** Retained. Read only for cancelled, in_surgery and completed. */
  fill: string;
  /** Retained. Read only for cancelled's dashed border. */
  hairline: string;
  /** The hairline on hover: the state's own status colour, so the fill never changes. */
  hoverHairline: string;
  /** The 3px left spine, or "" for the one state that deliberately has none. */
  spine: string;
  /** The patient name's ink. Never a status ink. */
  nameInk: string;
  /** Line 2's ink. */
  metaInk: string;
  /** The state glyph's ink. */
  glyphInk: string;
  /** Cancelled: the hairline is dashed. */
  dashed: boolean;
  /** Did not attend: a 45 degree hatch over the fill, so it survives greyscale. */
  hatched: boolean;
  /** In surgery: the one saturated, solid block on the grid. */
  solid: boolean;
}

const CONFIRMED_STYLE: BlockStyle = {
  fill: "bg-tint-green",
  hairline: "border-tint-green-line",
  hoverHairline: "hover:border-status-green",
  spine: "bg-status-green",
  nameInk: "text-navy",
  metaInk: "text-muted",
  glyphInk: "text-navy",
  dashed: false,
  hatched: false,
  solid: false,
};

/**
 * Inside .app-frame there are only FOUR distinguishable tint families for eight
 * states (tint-royal is byte-identical to tint-blue, status-royal to
 * status-blue), so every state carries three channels: a fill family, a
 * non-hue treatment, and a printed glyph. The status colours appear only as the
 * 3px spine and the 1px hairline, which are non-text indicators needing 3:1;
 * status ink on its own tint is below AA at 10px, so glyph ink is navy.
 */
const BLOCK_STYLES: Record<string, BlockStyle> = {
  // It nags, correctly: the receptionist's work queue, and the only warm family.
  pending: {
    fill: "bg-tint-amber",
    hairline: "border-tint-amber-line",
    hoverHairline: "hover:border-status-amber",
    spine: "bg-status-amber",
    nameInk: "text-navy",
    metaInk: "text-muted",
    glyphInk: "text-navy",
    dashed: false,
    hatched: false,
    solid: false,
  },
  // The day's healthy mass reads pale green.
  confirmed: CONFIRMED_STYLE,
  // The mock's legacy stand-in for confirmed: same treatment, its own letter and
  // its own label. It is never silently relabelled as "confirmed".
  booked: CONFIRMED_STYLE,
  // The person is physically in the building, so the hairline runs at full
  // strength: one weight louder than anything else on the grid.
  arrived: {
    fill: "bg-tint-blue",
    hairline: "border-status-blue",
    hoverHairline: "hover:border-status-blue",
    spine: "bg-status-blue",
    nameInk: "text-navy",
    metaInk: "text-muted",
    glyphInk: "text-navy",
    dashed: false,
    hatched: false,
    solid: false,
  },
  // The ONE state that should shout. At most one per column at any moment, so
  // from across the room a single saturated block says the surgery is running,
  // and its position against the now-line says how far in. White on #16559a is
  // 7.46:1.
  in_surgery: {
    fill: "bg-status-blue",
    hairline: "border-status-blue",
    hoverHairline: "hover:border-navy",
    spine: "bg-navy",
    nameInk: "text-white",
    metaInk: "text-white/80",
    glyphInk: "text-white",
    dashed: false,
    hatched: false,
    solid: true,
  },
  // Recedes. A finished appointment gets a quiet mark and muted text, not a
  // pill. Over a day the morning drains of colour as it is worked through, which
  // is an honest read of how far the practice has got. The spine is --muted
  // because --line-strong is 1.27:1 on white and simply invisible.
  completed: {
    fill: "bg-card-muted",
    hairline: "border-line",
    hoverHairline: "hover:border-muted",
    spine: "bg-muted",
    nameInk: "text-muted",
    metaInk: "text-faint",
    glyphInk: "text-navy",
    dashed: false,
    hatched: false,
    solid: false,
  },
  // The hole: the same white as the empty grid, a dashed hairline, and the ONE
  // block with no spine at all. At arm's length it is clearly a cancelled
  // booking; at two metres it reads as free, which is operationally correct
  // because the slot IS recoverable. An amber cancelled block would read as
  // pending, which is why the dashboard's cancelled pill moves to neutral.
  cancelled: {
    fill: "bg-card",
    hairline: "border-dashed border-line-strong",
    hoverHairline: "hover:border-muted",
    spine: "",
    nameInk: "text-muted line-through",
    metaInk: "text-faint",
    glyphInk: "text-muted",
    dashed: true,
    hatched: false,
    solid: false,
  },
  // The patient exists and the slot was consumed; something happened here,
  // unlike a cancellation, so the name is NOT struck through. The hatch is what
  // separates it from a booked block in greyscale and on a projector.
  did_not_attend: {
    fill: "bg-tint-red",
    hairline: "border-tint-red-line",
    hoverHairline: "hover:border-status-red",
    spine: "bg-status-red",
    nameInk: "text-navy",
    metaInk: "text-muted",
    glyphInk: "text-navy",
    dashed: false,
    hatched: true,
    solid: false,
  },
};

/** Explicit and identical for every unknown value alike, never a lucky key miss. */
const UNKNOWN_STYLE: BlockStyle = {
  fill: "bg-card",
  hairline: "border-line",
  hoverHairline: "hover:border-line-strong",
  spine: "bg-line-strong",
  nameInk: "text-navy",
  metaInk: "text-muted",
  glyphInk: "text-navy",
  dashed: false,
  hatched: false,
  solid: false,
};

export function blockStyle(state: string): BlockStyle {
  return BLOCK_STYLES[state] ?? UNKNOWN_STYLE;
}

export interface StateGlyph {
  kind: "text" | "clock" | "check";
  text?: string;
}

/**
 * The glyphs the practice was trained on and named verbatim: P pending,
 * C confirmed, a clock arrived, S in surgery, a tick complete, X cancelled,
 * DNA did not attend. Reproduced exactly; inventing a better notation is a way
 * of losing. Null for a state we do not recognise, which then carries its raw
 * value in the accessible sentence and the panel instead.
 */
const STATE_GLYPHS: Record<string, StateGlyph> = {
  pending: { kind: "text", text: "P" },
  confirmed: { kind: "text", text: "C" },
  booked: { kind: "text", text: "B" },
  arrived: { kind: "clock" },
  in_surgery: { kind: "text", text: "S" },
  completed: { kind: "check" },
  cancelled: { kind: "text", text: "X" },
  did_not_attend: { kind: "text", text: "DNA" },
};

export function stateGlyph(state: string): StateGlyph | null {
  return STATE_GLYPHS[state] ?? null;
}

// --- interior gaps ------------------------------------------------------------

export interface InteriorGap {
  top: number;
  height: number;
  minutes: number;
}

/**
 * The ONE quantified statement this screen makes about empty time: a span lying
 * strictly BETWEEN two drawn blocks in the same column, INSIDE the clinician's
 * working time and OUTSIDE their breaks.
 *
 * Gaps before the first block and after the last are never returned, because
 * those are the ones that would presume working hours at the edges of the day.
 * Cancelled and did-not-attend blocks count as occupying their span, so the hole
 * around a cancellation is never double-labelled: the cancelled block's own
 * subtractive treatment is the signal there.
 *
 * WHY THE INTERSECTION EXISTS. An earlier note here said no data source in the
 * repo supported a working-hours claim. That was true before Dentally's own
 * availability was read; it is not true now, and `working` is exactly that
 * source, sitting in the same object as these blocks. Without the intersection,
 * a column with appointments at 12:00 and 15:00 and a lunch hour at 13:00
 * printed "150m" across a span the grid itself was drawing GREY for off and
 * blocking out for lunch: the one number a receptionist reads as bookable,
 * overstating real capacity by the whole off and break portion.
 *
 * `working` empty means "we cannot say", and NOTHING is labelled. That is the
 * correct direction: a figure is a claim, and a claim needs a source.
 */
export function interiorGaps(
  placed: readonly { startMin: number; endMin: number }[],
  boundsStartMin: number,
  boundsEndMin: number,
  zoom: Zoom,
  /** The clinician's white sessions. Omitted or empty means no gap is labelled. */
  working: readonly { startMin: number; endMin: number }[] = [],
  /** Breaks. A note does not consume time and does not subtract. */
  breaks: readonly { startMin: number; endMin: number }[] = [],
): InteriorGap[] {
  const spans = placed
    .filter((s) => Number.isFinite(s.startMin) && Number.isFinite(s.endMin) && s.endMin > s.startMin)
    .map((s) => ({ startMin: s.startMin, endMin: s.endMin }))
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  if (spans.length < 2) return [];

  const merged: { startMin: number; endMin: number }[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.startMin <= last.endMin) last.endMin = Math.max(last.endMin, s.endMin);
    else merged.push({ ...s });
  }

  const workable = mergeSpans(working);
  if (workable.length === 0) return [];
  const blocked = mergeSpans(breaks);

  const out: InteriorGap[] = [];
  for (let i = 1; i < merged.length; i += 1) {
    const gapStart = Math.max(merged[i - 1].endMin, boundsStartMin);
    const gapEnd = Math.min(merged[i].startMin, boundsEndMin);
    if (gapEnd <= gapStart) continue;
    // The hole, cut down to the time the clinician is actually here, then cut
    // again around their breaks. What survives is genuinely bookable.
    for (const piece of subtractSpans(intersectSpans({ startMin: gapStart, endMin: gapEnd }, workable), blocked)) {
      const minutes = piece.endMin - piece.startMin;
      if (minutes < 15) continue;
      const { top, height } = blockEdges(piece.startMin, piece.endMin, boundsStartMin, zoom);
      if (height < 20) continue;
      out.push({ top, height, minutes });
    }
  }
  return out;
}

/** The parts of `span` that lie inside `spans` (already merged). */
function intersectSpans(
  span: { startMin: number; endMin: number },
  spans: readonly { startMin: number; endMin: number }[],
): { startMin: number; endMin: number }[] {
  const out: { startMin: number; endMin: number }[] = [];
  for (const s of spans) {
    const startMin = Math.max(span.startMin, s.startMin);
    const endMin = Math.min(span.endMin, s.endMin);
    if (endMin > startMin) out.push({ startMin, endMin });
  }
  return out;
}

/** `pieces` with every part of `blocked` (already merged) removed. */
function subtractSpans(
  pieces: readonly { startMin: number; endMin: number }[],
  blocked: readonly { startMin: number; endMin: number }[],
): { startMin: number; endMin: number }[] {
  if (blocked.length === 0) return [...pieces];
  const out: { startMin: number; endMin: number }[] = [];
  for (const piece of pieces) {
    let cursor = piece.startMin;
    for (const b of blocked) {
      if (b.endMin <= cursor) continue;
      if (b.startMin >= piece.endMin) break;
      if (b.startMin > cursor) out.push({ startMin: cursor, endMin: Math.min(b.startMin, piece.endMin) });
      cursor = Math.max(cursor, b.endMin);
      if (cursor >= piece.endMin) break;
    }
    if (cursor < piece.endMin) out.push({ startMin: cursor, endMin: piece.endMin });
  }
  return out;
}

// --- the appointment, in words ------------------------------------------------

export interface DiaryAppointment {
  id: string;
  patientId: string;
  patientName: string;
  start: string;
  finish: string | null;
  durationMin: number;
  state: string;
  reason: string | null;
  note: string | null;
  practitioner: string | null;
  practitionerId: string | null;
}

/** The London wall-clock start and end of an appointment, as "HH:MM". */
export function blockTimes(appt: {
  start: string;
  finish: string | null;
  durationMin: number;
}): { startLabel: string; endLabel: string; minutes: number } | null {
  const startMin = londonMinutes(appt.start);
  if (!Number.isFinite(startMin)) return null;
  const minutes = effectiveMinutes(appt);
  return {
    startLabel: labelMinutes(startMin),
    endLabel: labelMinutes((startMin + minutes) % (24 * 60)),
    minutes,
  };
}

/**
 * "Nadia Lamprell" -> "N.Lamprell". First initial, a full stop, NO space, then
 * the surname, exactly as the reference prints it.
 *
 * A single-word name returns itself rather than being cut to an initial: a
 * record reading "UDC Diary" or one carrying only a surname must stay readable.
 * The FULL name is never lost - it stays in the block's title attribute, in the
 * accessible sentence and in the detail panel.
 */
export function shortPatientName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  const initial = [...words[0]][0] ?? "";
  return `${initial}.${words[words.length - 1]}`;
}

/**
 * Line 1 of a block, always drawn above "bar": "09:30 N.Lamprell".
 *
 * Falls back to the name alone when the start cannot be parsed, rather than
 * printing a placeholder time. An invented time on a diary is a clinical error.
 */
export function blockLeadLine(appt: DiaryAppointment, narrow = false): string {
  const short = shortPatientName(appt.patientName);
  const times = blockTimes(appt);
  if (!times) return short;
  // NARROW: the time alone, and the name moves to line two. Twenty-two pixels
  // cannot hold "09:30 N.Lamprell", and what it printed instead was "09:3" --
  // a time that is not a time, above a patient nobody could name. A block that
  // cannot say both says the one that is never ambiguous first.
  return narrow ? times.startLabel : `${times.startLabel} ${short}`;
}

/**
 * The block's WRAPPED body: one string, segments joined by a SINGLE SPACE.
 *
 * A single space and not " · ", because the reference runs these segments
 * together as flowing text rather than as a delimited list. Missing segments are
 * omitted entirely and never rendered as an empty separator.
 *
 * Order: the funding code, then the treatment type's label, then the RAW reason
 * when it differs from that label, then the booking note verbatim. So:
 *   "NHS Scale & Polish Hygienist appointment needs pre med, check with dentist"
 *
 * We do NOT invent price or deposit fields. The reference's
 * "Price: 99.00 Deposit: 15.00 Booked by patient via Dentally Portal" is
 * Dentally's own booking-note text; AppointmentRecord carries no money at all,
 * and our equivalent is appt.note, rendered verbatim.
 */
export function blockBodyText(
  appt: DiaryAppointment,
  funding: FundingCode,
  narrow = false,
): string {
  // On a narrow block line one is the time alone, so line two is the NAME. The
  // patient is the one thing a receptionist reading across a double booking has
  // to have; the treatment and the note are still in the tooltip, the panel and
  // the accessible sentence.
  if (narrow) return shortPatientName(appt.patientName);

  const parts: string[] = [];
  const fundingLabel = FUNDING_LABEL[funding];
  if (fundingLabel !== "") parts.push(fundingLabel);

  const label = typeLabelFor(appt.reason);
  if (label) parts.push(label);

  const reason = appt.reason?.trim() ?? "";
  // The raw reason only when it says something the label did not: an exact match
  // (case and spacing aside) would otherwise print the same words twice.
  if (reason !== "" && reason.toLowerCase() !== (label ?? "").toLowerCase()) parts.push(reason);

  const note = appt.note?.trim() ?? "";
  if (note !== "") parts.push(note);

  return parts.join(" ");
}

/**
 * The block's native title attribute: time, duration, reason, note, joined with
 * " · ". Retained for the tooltip and unchanged; the block's own drawn text is
 * now blockLeadLine plus blockBodyText.
 */
export function blockMetaLine(appt: DiaryAppointment): string {
  const times = blockTimes(appt);
  const parts: string[] = [];
  if (times) {
    parts.push(times.startLabel);
    parts.push(`${times.minutes}m`);
  }
  if (appt.reason) parts.push(appt.reason);
  if (appt.note) parts.push(appt.note);
  return parts.join(" · ");
}

/**
 * The complete sentence a screen reader announces for a block.
 *
 * Every block's VISIBLE text is aria-hidden and this is what the button carries,
 * so the announcement is identical at every degrade tier including "bar", where
 * nothing is visible at all. The range is spelled with "to" because a dash is
 * read as a pause and not a range. The clinician is always named, because a
 * half-width lane-1 block is visually ambiguous about which column it is in.
 *
 * FUNDING sits after the clinician and before the state:
 *   "09:30 to 10:00, 30 minutes. Nadia Lamprell. Scale & Polish. Femi Osei. NHS. Confirmed."
 * It is here at EVERY tier, which is what stops the 3px rail being the only
 * carrier: at "lead" and below the body text is not drawn, so the rail and this
 * sentence are how funding reaches the reader.
 *
 * "unknown" contributes NOTHING, not the word "unknown". An unresolvable patient
 * must render nothing at all, in ink and in speech alike, so that a reader can
 * never take an absence for a fact.
 */
export function accessibleSentence(
  appt: DiaryAppointment,
  clinicianName: string | null,
  lanes: number,
  funding: FundingCode = "unknown",
): string {
  const times = blockTimes(appt);
  const parts: string[] = [];
  parts.push(
    times ? `${times.startLabel} to ${times.endLabel}, ${times.minutes} minutes.` : "Time not recorded.",
  );
  parts.push(`${appt.patientName}.`);
  if (appt.reason) parts.push(`${appt.reason}.`);
  if (appt.note) parts.push(`Note: ${appt.note}.`);
  if (clinicianName) parts.push(`${clinicianName}.`);
  const fundingLabel = FUNDING_LABEL[funding];
  if (fundingLabel !== "") parts.push(`${fundingLabel}.`);
  const others = Math.max(0, lanes - 1);
  const clash = others > 0 ? `, double booked with ${others} other${others === 1 ? "" : "s"}` : "";
  parts.push(`${stateLabel(appt.state)}${clash}.`);
  return parts.join(" ");
}

// --- the rules ----------------------------------------------------------------

export interface RuleMarks {
  /** Every 15 minute slot mark that is NOT also a half hour or an hour. */
  quarters: number[];
  /** Every 30 minute mark that is NOT also an hour. */
  halves: number[];
  hours: number[];
}

/**
 * The three rule weights, computed ONCE and DISJOINT by construction.
 *
 * A 30 is never also emitted as a 15 and a 60 never also as a 30, so the grid
 * cannot draw two rules of different weights on the same pixel and leave a
 * half-hour line looking like a hairline.
 *
 * FIFTEEN MINUTES, NOT FIVE, and drawn DASHED. That is the reference's own slot
 * rule and it is the correction: a rule every five minutes is a rule every 12px
 * at Normal and every 8px at Compact, which is not a grid a reader can count --
 * it is a grey wash behind the appointments, and beside Dentally's own diary it
 * was the single biggest reason ours read as noisy. Fifteen minutes is 36px at
 * Normal, 24 at Compact and 48 at Roomy: countable at every density, so the
 * suppression the five minute rules needed at Compact is gone with them.
 *
 * Nothing is lost by it. A booking is placed by its own edges, which are drawn
 * from the same px-per-minute constant, so a 10 minute appointment at 09:05 sits
 * exactly where it sits whether or not a hairline happens to pass under it.
 */
export function ruleMarks(bounds: { startMin: number; endMin: number }): RuleMarks {
  const quarters: number[] = [];
  const halves: number[] = [];
  const hours: number[] = [];
  if (!Number.isFinite(bounds.startMin) || !Number.isFinite(bounds.endMin)) {
    return { quarters, halves, hours };
  }
  for (let m = Math.ceil(bounds.startMin / 15) * 15; m <= bounds.endMin; m += 15) {
    if (m % 60 === 0) hours.push(m);
    else if (m % 30 === 0) halves.push(m);
    else quarters.push(m);
  }
  return { quarters, halves, hours };
}

// --- multiday -----------------------------------------------------------------

/** The spans the multiday view offers. Seven is week view's own span. */
export const MULTIDAY_SPANS = [3, 5, 7] as const;

export type MultidaySpan = (typeof MULTIDAY_SPANS)[number];

/** The ?span= value, defaulting to 5 for anything unrecognised or unset. */
export function parseSpan(raw: string | null): MultidaySpan {
  const n = Number(raw);
  return (MULTIDAY_SPANS as readonly number[]).includes(n) ? (n as MultidaySpan) : 5;
}

/**
 * The day keys a multiday view draws: the anchor day, then FORWARD.
 *
 * Anchor-forward and never week-aligned. The reference's own URL
 * (/calendar/multiday/2026-08-05) confirms it, and a practice manager checking a
 * clinician's next five days does not want to be thrown back to Monday.
 */
export function multidaySpanKeys(anchorDayKey: string, span: number): string[] {
  const n = Math.max(1, Math.min(7, Math.floor(span)));
  const base = Date.parse(`${anchorDayKey}T00:00:00Z`);
  if (Number.isNaN(base)) return [];
  return Array.from({ length: n }, (_, i) =>
    new Date(base + i * 86_400_000).toISOString().slice(0, 10),
  );
}

// --- counts -------------------------------------------------------------------

export interface DayCounts {
  /** The live states: pending, confirmed, booked, arrived, in surgery, completed. */
  booked: number;
  /** The subset of those still awaiting confirmation. */
  pending: number;
  cancelled: number;
  noShow: number;
}

/**
 * Cancelled appointments and no-shows are counted SEPARATELY and never folded
 * into an appointment total, because "12 appointments" that includes three
 * cancellations overstates the day. An unrecognised state counts as booked: a
 * state we cannot read is not evidence that a slot is free.
 */
export function dayCounts(appts: readonly { state: string }[]): DayCounts {
  let booked = 0;
  let pending = 0;
  let cancelled = 0;
  let noShow = 0;
  for (const a of appts) {
    if (a.state === "cancelled") {
      cancelled += 1;
      continue;
    }
    if (a.state === "did_not_attend") {
      noShow += 1;
      continue;
    }
    booked += 1;
    if (a.state === "pending") pending += 1;
  }
  return { booked, pending, cancelled, noShow };
}

/** A column header's second line: only the non-zero segments, else "Nothing booked". */
export function columnCounts(appts: readonly { state: string }[]): string {
  const c = dayCounts(appts);
  const parts: string[] = [];
  if (c.booked > 0) parts.push(`${c.booked} booked`);
  if (c.pending > 0) parts.push(`${c.pending} pending`);
  if (c.cancelled > 0) parts.push(`${c.cancelled} cancelled`);
  if (c.noShow > 0) parts.push(`${c.noShow} no-show`);
  return parts.length > 0 ? parts.join(", ") : "Nothing booked";
}

/** The command bar's caption: the site, then only the non-zero segments. */
export function dayCaption(siteName: string, counts: DayCounts): string {
  const parts: string[] = [siteName];
  if (counts.booked > 0) parts.push(`${counts.booked} booked`);
  if (counts.pending > 0) parts.push(`${counts.pending} awaiting confirmation`);
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
  if (counts.noShow > 0) parts.push(`${counts.noShow} no-show`);
  if (parts.length === 1) parts.push("Nothing booked");
  return parts.join(" · ");
}

// --- columns ------------------------------------------------------------------

/**
 * The day's columns, in the order the grid draws them.
 *
 * Ordering is applied to the INPUT, so diaryColumns' own semantics are untouched:
 * clinicians with nothing booked keep their column, a locum who appears only in
 * the day's appointments is appended after them, and Unassigned stays last.
 * Columns key on practitionerId and never on the display name.
 */
export function orderColumns(
  practitioners: readonly { id: string; name: string }[],
  appts: readonly { practitionerId: string | null; practitioner: string | null }[],
): DiaryColumn[] {
  const sorted = [...practitioners].sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
  return diaryColumns(sorted, appts);
}

/**
 * The initials disc on a column header. Two letters at most, and never punctuation:
 * N15's practitioner list contains records that are not people ("DAY NOTES",
 * "UDC Diary"), which are reproduced faithfully as columns because they are
 * Dentally's own diary columns and the practice uses them.
 */
export function initialsOf(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

/** The stable key for a column: its practitioner id, or the unassigned sentinel. */
export const UNASSIGNED_KEY = "unassigned";

export function columnKey(id: string | null): string {
  return id ?? UNASSIGNED_KEY;
}

export interface SoloResolution {
  /** The column the grid actually draws alone, or null for every column. */
  effective: string | null;
  /** True when a clinician was picked who is not in this day's diary. */
  dropped: boolean;
}

/**
 * Which clinician the day grid draws, given the one the reader picked.
 *
 * A picked key that matches no column on the day now in view is IGNORED rather
 * than filtering every column away. It is reachable four ways: soloing
 * Unassigned then moving to a day where every row has a clinician, soloing a
 * locum who only appears in one day's appointments, switching site under All
 * sites (nothing resets the pick), and any pasted ?clinician= for a clinician
 * since deactivated. Filtering to nothing drew a bare time gutter with no
 * message at all while the caption above it still read "24 booked", which is a
 * confident empty diary on a fully booked day.
 *
 * `dropped` exists so the caller SAYS so. Silently showing every clinician when
 * one was asked for is a smaller lie than a blank grid, but it is still a lie.
 */
export function resolveSolo(
  columns: readonly { key: string }[],
  solo: string | null,
): SoloResolution {
  if (solo === null) return { effective: null, dropped: false };
  const exists = columns.some((c) => c.key === solo);
  return { effective: exists ? solo : null, dropped: !exists };
}

/**
 * The ONE clinician week view draws: whoever is soloed, else the first column.
 *
 * The name is returned alongside the key because week view is single-clinician
 * by construction and that must never be left implicit. Falling back to the
 * first column silently is how a week grid drawn for one person sat under a
 * caption counting the whole practice.
 */
export function weekColumn(
  columns: readonly { key: string; name: string }[],
  effectiveSolo: string | null,
): { key: string | null; name: string | null } {
  const picked = columns.find((c) => c.key === effectiveSolo) ?? columns[0] ?? null;
  return picked ? { key: picked.key, name: picked.name } : { key: null, name: null };
}

// --- keyboard movement --------------------------------------------------------

export type FocusKey = "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft" | "Home" | "End";

export interface FocusItem {
  id: string;
  startMin: number;
}

export interface FocusPos {
  colIndex: number;
  id: string;
  startMin: number;
}

function sortItems(items: readonly FocusItem[]): FocusItem[] {
  return [...items].sort((a, b) => a.startMin - b.startMin);
}

function indexOfStart(items: readonly FocusItem[], startMin: number): number {
  if (items.length === 0) return -1;
  const exact = items.findIndex((i) => i.startMin === startMin);
  if (exact !== -1) return exact;
  const after = items.findIndex((i) => i.startMin >= startMin);
  return after === -1 ? items.length - 1 : after;
}

/**
 * Where the single roving tab stop starts.
 *
 * On today that is the first appointment at or after now in the leftmost column
 * that has one, so a keyboard user lands on what is happening rather than on
 * this morning's finished work. On any other day, and when nothing is left
 * today, it is that column's first appointment.
 */
export function initialFocus(
  columns: readonly (readonly FocusItem[])[],
  fromMin: number,
): FocusPos | null {
  for (let ci = 0; ci < columns.length; ci += 1) {
    const items = sortItems(columns[ci] ?? []);
    if (items.length === 0) continue;
    const pick = items.find((i) => i.startMin >= fromMin) ?? items[0];
    return { colIndex: ci, id: pick.id, startMin: pick.startMin };
  }
  return null;
}

/**
 * Where a key press moves the single roving tab stop.
 *
 * Thirteen columns of twenty appointments is 260 tab stops, so the grid body is
 * ONE stop and the arrows move within it. Down and Up walk the column by start
 * time; Right and Left land on the nearest appointment in the adjacent column at
 * or after the current start, falling back to the last one before it. Nothing
 * wraps. An empty adjacent column is stepped over rather than swallowing the
 * focus, so a keyboard user can never get stuck on a clinician with a free day.
 */
export function nextFocus(
  columns: readonly (readonly FocusItem[])[],
  currentColumnIndex: number,
  currentStartMin: number,
  key: FocusKey,
): FocusPos | null {
  const own = sortItems(columns[currentColumnIndex] ?? []);
  const at = (colIndex: number, item: FocusItem | undefined): FocusPos | null =>
    item ? { colIndex, id: item.id, startMin: item.startMin } : null;
  const here = indexOfStart(own, currentStartMin);
  const current = at(currentColumnIndex, own[here]);

  if (key === "ArrowDown") return at(currentColumnIndex, own[Math.min(own.length - 1, here + 1)]) ?? current;
  if (key === "ArrowUp") return at(currentColumnIndex, own[Math.max(0, here - 1)]) ?? current;
  if (key === "Home") return at(currentColumnIndex, own[0]) ?? current;
  if (key === "End") return at(currentColumnIndex, own[own.length - 1]) ?? current;

  const dir = key === "ArrowRight" ? 1 : -1;
  for (let ci = currentColumnIndex + dir; ci >= 0 && ci < columns.length; ci += dir) {
    const target = sortItems(columns[ci] ?? []);
    if (target.length === 0) continue;
    const landing = target.find((i) => i.startMin >= currentStartMin) ?? target[target.length - 1];
    return at(ci, landing);
  }
  return current;
}

// --- ordering -----------------------------------------------------------------

/**
 * Ascending by start INSTANT, never by the lexical ISO string.
 *
 * If live Dentally ever returns a mix of "+01:00" and "Z" forms, a lexical
 * comparison breaks while diary-grid's placement stays right (it goes through
 * londonMinutes), which would give a reading order that contradicts the drawn
 * grid. An unparseable start sorts last rather than to the top of the day.
 */
export function sortByStart<T extends { start: string }>(appts: readonly T[]): T[] {
  return [...appts].sort((a, b) => {
    const av = Date.parse(a.start);
    const bv = Date.parse(b.start);
    const an = Number.isNaN(av) ? Number.POSITIVE_INFINITY : av;
    const bn = Number.isNaN(bv) ? Number.POSITIVE_INFINITY : bv;
    return an - bn;
  });
}
