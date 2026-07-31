// ===========================================================================
// DRAG GEOMETRY: pointer pixels and arrow-key presses -> a move proposal.
//
// PURE and unit-tested, and shared by BOTH input paths. The pointer reducer and
// the keyboard reducer end in the SAME proposeMove / proposeResize call, so a
// drag and an 'm' move cannot produce different proposals for the same move.
// That is not a tidiness point: the confirmation dialog, the validator and the
// server all read the proposal, and two ways of building it is two ways of
// getting a patient's appointment on the wrong clinician.
//
// SNAP IS FIVE MINUTES, APPLIED TO THE DELTA.
//
// Five, because it is a whole number of pixels at every zoom (8 / 12 / 16 px per
// five minutes), so a pixel snap and a minute snap agree exactly and cannot
// accumulate drift. Fifteen would be 24 / 36 / 48px and is wrong anyway: blockTier
// already admits a 13px block, which is an eight minute booking at compact.
//
// The DELTA and not the absolute clock, because snapping the absolute time would
// silently move an appointment whose start is not already on the increment (an
// 09:07 booking nudged down five minutes must land on 09:12, not 09:10), would
// turn a one-pixel twitch into a real reschedule instead of a no-op, and is
// correct whatever live Dentally's start-time granularity turns out to be, which
// is unverified.
// ===========================================================================

import { MAX_DURATION_MIN, MIN_DURATION_MIN, type MoveProposal } from "@/lib/calendar/move-validate";
import type { Span } from "@/lib/calendar/working-spans";
import { pxPerMinute, type Zoom } from "./diary-view";

export const SNAP_MIN = 5;

/** The block being dragged, as it stands BEFORE the gesture. */
export interface DragOrigin {
  appointmentId: string;
  dayKey: string;
  startMin: number;
  endMin: number;
  practitionerId: string | null;
}

/** The column the pointer (or an arrow press) has landed on. */
export interface DragTarget {
  practitionerId: string | null;
  dayKey: string;
}

/** Round a raw minute delta onto the five minute grid. Zero for anything unreadable. */
export function snapDelta(rawMin: number): number {
  if (!Number.isFinite(rawMin)) return 0;
  const snapped = Math.round(rawMin / SNAP_MIN) * SNAP_MIN;
  // Normalise negative zero: a tiny upward twitch would otherwise return -0,
  // which compares equal to 0 arithmetically but not under Object.is, and would
  // put a "-0" into a proposal that is then compared for a no-op.
  return snapped === 0 ? 0 : snapped;
}

/**
 * A pointer's y position, in minutes on the diary's clock face.
 *
 * `bodyCellTop` is the column body cell's own viewport rect top, so this is
 * correct while the grid is scrolled. It is deliberately NOT derived from the
 * grid's own box: one element owns both scroll axes, and the body cell is the
 * only box whose top is the drawn zero of the time axis.
 */
export function pointerToMinutes(
  clientY: number,
  bodyCellTop: number,
  boundsStartMin: number,
  zoom: Zoom,
): number {
  return boundsStartMin + (clientY - bodyCellTop) / pxPerMinute(zoom);
}

/** A length Dentally will accept: 5 to 480 minutes. Length is NOT re-rounded here. */
function clampDuration(minutes: number): number {
  if (!Number.isFinite(minutes)) return MIN_DURATION_MIN;
  return Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, Math.round(minutes)));
}

/**
 * Keep a proposal inside the drawn day WITHOUT changing its length.
 *
 * A move slides the whole block; it never shortens a booking to make it fit,
 * because a booking that quietly became twenty minutes shorter is a clinical
 * change nobody asked for. Only a span longer than the whole drawn day is cut,
 * and that cannot happen in practice: dayBounds already extends to cover
 * everything booked.
 */
export function clampToBounds(p: MoveProposal, bounds: Span): MoveProposal {
  const duration = clampDuration(p.endMin - p.startMin);
  const width = bounds.endMin - bounds.startMin;
  if (!Number.isFinite(width) || width <= 0) return p;
  if (duration >= width) return { ...p, startMin: bounds.startMin, endMin: bounds.endMin };
  let start = p.startMin;
  if (start < bounds.startMin) start = bounds.startMin;
  if (start + duration > bounds.endMin) start = bounds.endMin - duration;
  return { ...p, startMin: start, endMin: start + duration };
}

/**
 * Move: shift the start by a snapped delta, and take the clinician and the day
 * from whichever column the gesture ended over.
 *
 * THE LENGTH IS PRESERVED EXACTLY, not re-rounded onto the five minute grid. A
 * booking Dentally recorded as 37 minutes stays 37 minutes: a move is a change of
 * WHEN, and silently making it 35 would be a change of what was booked. The
 * server refuses a length it cannot write rather than adjusting one, so an odd
 * length surfaces as a plain refusal instead of an invisible edit.
 */
export function proposeMove(
  origin: DragOrigin,
  deltaMin: number,
  target: DragTarget,
  bounds: Span,
): MoveProposal {
  const delta = snapDelta(deltaMin);
  const duration = clampDuration(origin.endMin - origin.startMin);
  const start = origin.startMin + delta;
  return clampToBounds(
    {
      appointmentId: origin.appointmentId,
      startMin: start,
      endMin: start + duration,
      practitionerId: target.practitionerId,
      dayKey: target.dayKey,
    },
    bounds,
  );
}

/**
 * Resize: change the FINISH only. The start, the clinician and the day are
 * untouched.
 *
 * Unlike a move, a resize DOES round the length onto the five minute grid,
 * because here the length is what the reader is deliberately changing, and a
 * length the server would refuse is a worse outcome than one rounded to the grid
 * the whole diary is drawn on. Never shorter than five minutes.
 */
export function proposeResize(origin: DragOrigin, deltaMin: number, bounds: Span): MoveProposal {
  const delta = snapDelta(deltaMin);
  const wanted = Math.round((origin.endMin + delta - origin.startMin) / SNAP_MIN) * SNAP_MIN;
  let duration = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, wanted));

  // Past the bottom of the drawn day, take the largest whole five minutes that
  // fits rather than hanging the block off the grid. Never below the five minute
  // floor, so an unusable bounds cannot produce a zero length booking.
  if (origin.startMin + duration > bounds.endMin) {
    const fits = Math.floor((bounds.endMin - origin.startMin) / SNAP_MIN) * SNAP_MIN;
    duration = Math.max(MIN_DURATION_MIN, fits);
  }

  return {
    appointmentId: origin.appointmentId,
    startMin: origin.startMin,
    endMin: origin.startMin + duration,
    practitionerId: origin.practitionerId,
    dayKey: origin.dayKey,
  };
}

/** True when a proposal changes nothing at all, so nothing is written and nothing is asked. */
export function isNoopProposal(p: MoveProposal, origin: DragOrigin): boolean {
  return (
    p.startMin === origin.startMin &&
    p.endMin === origin.endMin &&
    p.practitionerId === origin.practitionerId &&
    p.dayKey === origin.dayKey
  );
}

/** The pointer must travel this far before a gesture becomes a drag, so a click still opens the panel. */
export const DRAG_THRESHOLD_PX = 4;

/** The grab strip along a block's bottom edge. Not drawn at all under this height. */
export const RESIZE_HANDLE_PX = 8;
export const RESIZE_HANDLE_MIN_BLOCK_PX = 20;

/** Which gesture a pointerdown at this offset inside a block starts. */
export function gestureFor(offsetYFromBlockTop: number, blockHeightPx: number): "move" | "resize" {
  if (blockHeightPx < RESIZE_HANDLE_MIN_BLOCK_PX) return "move";
  return offsetYFromBlockTop >= blockHeightPx - RESIZE_HANDLE_PX ? "resize" : "move";
}
