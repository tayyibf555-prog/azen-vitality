// ===========================================================================
// WHITE SPACE, AS A NUMBER.
//
// The practice manager's second complaint, verbatim on 2026-07-27:
//
//   "I can not see anything about my KPIs right now. I can not see any white
//    space. I can not see any emergency slots."
//
// and, on a clinician calling in sick:
//
//   "I need to instantly be able to see what else is going on around the
//    practice with the other clinicians - can I drag an appointment somewhere
//    else? Is there a gap somewhere?"
//
// The gaps were already DRAWN. They were not COUNTED, so answering "who has room
// for a 45 minute filling this afternoon" meant reading four columns of pixels.
// This module turns one column of a day into two numbers a person can scan:
// how much unbooked working time there is, and how long the biggest single piece
// of it is. The second is the one that answers the sick-clinician question,
// because a clinician with three hours free in twelve-minute slivers has no room
// for anything.
//
// NO TARGETS, NO INVENTED KPIs. Nobody has set a utilisation target, so none is
// scored, colour-coded or judged. Everything here is measured off the same
// spans the grid draws, and where the grid cannot make a claim (hours not read,
// clinician off, appointments not loaded) this returns null and the header
// prints nothing rather than a confident zero.
//
// EMERGENCY SLOTS ARE NOT MODELLED, deliberately. Dentally's appointment feed
// carries a reason string and a state; it carries no slot TYPE and no
// "held for emergencies" flag, so there is nothing to read. Inventing one would
// mean picking gaps by size and calling them emergency capacity, which is a
// claim the data does not support. The board says so on screen instead.
//
// PURE, and in .ts, so it is testable. See the header of continuity.ts.
// ===========================================================================

import { mergeSpans, offSpans, type Span } from "./working-spans";

/**
 * The shortest piece of free time worth counting as a piece.
 *
 * Fifteen, matching the gap labels the grid already draws: below that nothing in
 * this practice's book fits, and counting a seven minute sliver as "free" is how
 * a total starts overstating what can actually be booked. Those slivers are
 * still inside `freeMin` — they ARE unbooked time and the arithmetic must add
 * up — but they never become `longestFreeMin` and never appear as a piece.
 */
export const MIN_USEFUL_PIECE_MIN = 15;

export interface ColumnCapacity {
  /** Minutes the clinician is positively known to be here, inside the drawn day. */
  workingMin: number;
  /** Of those, the minutes consumed by appointments and breaks. */
  bookedMin: number;
  /** workingMin - bookedMin. Never negative. */
  freeMin: number;
  /** The free pieces of at least MIN_USEFUL_PIECE_MIN, in time order. */
  pieces: Span[];
  /** The longest such piece, or 0 when there is none. */
  longestFreeMin: number;
  /** Where that longest piece starts, or null when there is none. */
  longestStartMin: number | null;
}

function total(spans: readonly Span[]): number {
  return spans.reduce((sum, s) => sum + Math.max(0, s.endMin - s.startMin), 0);
}

/** `spans` clipped to `bounds`, merged. */
function clip(spans: readonly Span[], bounds: Span): Span[] {
  return mergeSpans(
    spans.map((s) => ({
      startMin: Math.max(s.startMin, bounds.startMin),
      endMin: Math.min(s.endMin, bounds.endMin),
    })),
  );
}

/**
 * One clinician's day, as capacity.
 *
 * `working` is the SAME union the grid paints white: availability windows plus
 * that clinician's own occupying bookings. Deriving from anything else is how a
 * figure and the picture above it come to disagree.
 *
 * `occupied` must already exclude cancelled and did-not-attend, exactly as the
 * drop validator's does. A cancelled slot is free, and the grid already says so
 * by drawing the block white and dashed.
 *
 * Overlapping bookings (a genuine double-booking, which this diary draws as two
 * lanes) are merged before they are subtracted, so an hour double-booked is
 * counted as ONE hour consumed and never as two. Time cannot be spent twice.
 * The merge happens twice over, in `clip` here and again inside `offSpans`; that
 * is belt and braces on the one property this figure must not get wrong, and it
 * is why removing either one alone leaves the arithmetic correct.
 */
export function columnCapacity(args: {
  working: readonly Span[];
  occupied: readonly Span[];
  breaks: readonly Span[];
  bounds: Span;
}): ColumnCapacity {
  const empty: ColumnCapacity = {
    workingMin: 0,
    bookedMin: 0,
    freeMin: 0,
    pieces: [],
    longestFreeMin: 0,
    longestStartMin: null,
  };
  if (!Number.isFinite(args.bounds.startMin) || !Number.isFinite(args.bounds.endMin)) return empty;
  if (args.bounds.endMin <= args.bounds.startMin) return empty;

  const working = clip(args.working, args.bounds);
  if (working.length === 0) return empty;

  const busy = clip([...args.occupied, ...args.breaks], args.bounds);

  // The free pieces: for each white session, the parts of it nothing sits on.
  // offSpans returns the complement of `busy` inside a span, which is exactly
  // this, and reusing it keeps the arithmetic and the drawn grey on one
  // implementation.
  const free: Span[] = [];
  for (const w of working) {
    for (const piece of offSpans(busy, w)) free.push(piece);
  }

  const workingMin = total(working);
  const freeMin = total(free);
  const pieces = free
    .filter((p) => p.endMin - p.startMin >= MIN_USEFUL_PIECE_MIN)
    .sort((a, b) => a.startMin - b.startMin);

  let longestFreeMin = 0;
  let longestStartMin: number | null = null;
  for (const p of pieces) {
    const minutes = p.endMin - p.startMin;
    if (minutes > longestFreeMin) {
      longestFreeMin = minutes;
      longestStartMin = p.startMin;
    }
  }

  return {
    workingMin,
    // Derived by SUBTRACTION rather than summed from the bookings, so
    // workingMin, bookedMin and freeMin always add up: a booking that runs past
    // the end of a session cannot make the three disagree.
    bookedMin: Math.max(0, workingMin - freeMin),
    freeMin,
    pieces,
    longestFreeMin,
    longestStartMin,
  };
}

/** "45m", "1h", "2h 45m". Rounded to whole minutes; negative and unreadable give "0m". */
export function shortDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  if (rest === 0) return `${h}h`;
  return `${h}h ${rest}m`;
}

/** "09:05". Minutes past London midnight. */
function hhmm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * The column header's capacity line: "2h 45m free · longest 1h 30m at 14:00".
 *
 * Null when there is nothing to say. "Fully booked" is a real, useful answer and
 * is said in words; a clinician with only slivers left gets the total and no
 * "longest", because there is no piece worth naming.
 *
 * The free TOTAL comes first because it is the number that is scanned down the
 * header row; the longest piece is what decides whether a particular appointment
 * fits, and is read second.
 */
export function capacityLine(cap: ColumnCapacity | null): string | null {
  if (cap === null) return null;
  if (cap.workingMin <= 0) return null;
  if (cap.freeMin <= 0) return "Fully booked";
  const head = `${shortDuration(cap.freeMin)} free`;
  if (cap.longestStartMin === null) return head;
  return `${head} · longest ${shortDuration(cap.longestFreeMin)} at ${hhmm(cap.longestStartMin)}`;
}

/**
 * The same thing as a whole sentence, for the column's accessible label and its
 * hover title, where there is no width limit and truncation is not a risk.
 */
export function capacitySentence(name: string, cap: ColumnCapacity | null): string | null {
  if (cap === null || cap.workingMin <= 0) return null;
  const worked = `${shortDuration(cap.workingMin)} of clinical time`;
  if (cap.freeMin <= 0) return `${name} is fully booked: ${worked}, none of it free.`;
  if (cap.longestStartMin === null) {
    return `${name} has ${shortDuration(cap.freeMin)} free out of ${worked}, none of it in a run of ${MIN_USEFUL_PIECE_MIN} minutes or more.`;
  }
  return `${name} has ${shortDuration(cap.freeMin)} free out of ${worked}. The longest single run is ${shortDuration(
    cap.longestFreeMin,
  )} from ${hhmm(cap.longestStartMin)}.`;
}
