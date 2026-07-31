// ===========================================================================
// WORKING TIME: the union that makes GREY MEAN OFF.
//
// The grid starts GREY and working time is PAINTED ONTO IT in white. A clinician
// can therefore only ever read as available because something positively said so.
//
// workingSpans = merge( that practitioner's availability windows for the day,
//                       UNION their own booked appointment spans for the day )
//
// Booked appointments count as working time for two reasons. A booking is proof
// of a session even when availability says nothing about it. And whether
// Dentally's windows already exclude booked time is UNPROVEN: the union is
// correct under both readings, whereas taking the windows alone would carve a
// hole out of a working day wherever somebody is with a patient.
//
// ONLY OCCUPYING STATES COUNT. An earlier version unioned every state, cancelled
// and did-not-attend included, on the reasoning that the clinician was in the
// building either way. That is a guess, and it was the ONLY way white could
// appear with nothing positive behind it: cancelled and DNA are excluded from
// occupancy (move-validate.ts) but were included here, so a single cancelled
// booking on a Saturday manufactured an hour of white on a day with no
// availability at all, and the drop validator then let a patient be booked into
// it with a clinician who was not there. An appointment that did not happen is
// not evidence that anybody was in. Callers pass occupying spans only.
// ===========================================================================

import type { AvailabilityWindow } from "./availability";

/** Minutes past London midnight, half-open [startMin, endMin). */
export interface Span {
  startMin: number;
  endMin: number;
}

/**
 * One clinician-day whose availability cannot be placed at this practice.
 *
 * Declared HERE rather than in day-load.ts because day-load carries
 * `import "server-only"`, and the client hook that renders this needs the type.
 */
export interface UnconfirmedPresence {
  practitionerId: string;
  dayKey: string;
}

/** Sort, merge and drop empties. Touching spans (end === start) are merged. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const clean = spans
    .filter((s) => Number.isFinite(s.startMin) && Number.isFinite(s.endMin) && s.endMin > s.startMin)
    .map((s) => ({ startMin: s.startMin, endMin: s.endMin }))
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const out: Span[] = [];
  for (const s of clean) {
    const last = out[out.length - 1];
    if (last && s.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, s.endMin);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/**
 * The merged union of availability windows and OCCUPYING booked spans: the WHITE.
 *
 * `apptSpans` must already exclude cancelled and did-not-attend. See the header.
 */
export function workingSpans(
  windows: readonly AvailabilityWindow[],
  apptSpans: readonly Span[],
): Span[] {
  return mergeSpans([
    ...windows.map((w) => ({ startMin: w.startMin, endMin: w.endMin })),
    ...apptSpans,
  ]);
}

/**
 * What a column can honestly claim about a clinician's day.
 *
 *   "working"      we asked, and they are in.        -> white sessions on grey
 *   "off"          we asked, and they are not in.    -> grey all day
 *   "unknown"      we did not get an answer.         -> the hatch, never grey
 *   "unconfirmed"  they work at more than one of these practices and nothing
 *                  site-scoped puts them at THIS one today. -> the hatch, with
 *                  its own words. See site-presence.ts.
 *
 * These four must never collapse. A failed read painted grey is a positive claim
 * that the practice is closed, which on a busy Monday sends a receptionist
 * ringing patients to cancel. And "unconfirmed" painted white is another
 * practice's free time offered as this one's capacity, which is how a patient
 * ends up booked with a clinician who is not in the building.
 */
export type ColumnWorkState = "working" | "off" | "unknown" | "unconfirmed";

export function columnWorkState(args: {
  availabilityFailed: boolean;
  appointmentsFailed: boolean;
  windows: readonly AvailabilityWindow[];
  /** OCCUPYING spans only: cancelled and did-not-attend must already be gone. */
  apptSpans: readonly Span[];
  /**
   * False when this clinician could be at another of the client's practices
   * today and nothing site-scoped says otherwise. Defaults to true, so a caller
   * with no cross-site picture is unchanged.
   */
  presenceConfirmed?: boolean;
}): ColumnWorkState {
  // A failed APPOINTMENT read matters as much as a failed availability read here,
  // because the union includes appointments: a missing appointment set would
  // shrink the white area and make booked time read as off.
  if (args.availabilityFailed || args.appointmentsFailed) return "unknown";
  // Checked BEFORE the emptiness test, so an unconfirmed clinician never reads as
  // "Not working": that is a claim about them, and the truth is a gap in what we
  // can see.
  if (args.presenceConfirmed === false) return "unconfirmed";
  if (workingSpans(args.windows, args.apptSpans).length === 0) return "off";
  return "working";
}

/**
 * The complement of `working` inside `bounds`: the GREY, as explicit spans, so
 * the grey/white boundary can be drawn as a hard rule rather than a fade and so a
 * large off span can carry the word "Off".
 */
export function offSpans(working: readonly Span[], bounds: Span): Span[] {
  if (bounds.endMin <= bounds.startMin) return [];
  const merged = mergeSpans(working);
  const out: Span[] = [];
  let cursor = bounds.startMin;
  for (const w of merged) {
    if (w.endMin <= cursor) continue;
    if (w.startMin >= bounds.endMin) break;
    if (w.startMin > cursor) out.push({ startMin: cursor, endMin: Math.min(w.startMin, bounds.endMin) });
    cursor = Math.max(cursor, w.endMin);
    if (cursor >= bounds.endMin) break;
  }
  if (cursor < bounds.endMin) out.push({ startMin: cursor, endMin: bounds.endMin });
  return out;
}

/** True when the whole of `span` lies inside one of `spans`. */
export function spanContainedIn(span: Span, spans: readonly Span[]): boolean {
  return mergeSpans(spans).some((s) => span.startMin >= s.startMin && span.endMin <= s.endMin);
}

/** The first span in `spans` that overlaps `span`, or null. */
export function firstOverlap(span: Span, spans: readonly Span[]): Span | null {
  for (const s of spans) {
    if (span.startMin < s.endMin && s.startMin < span.endMin) return s;
  }
  return null;
}
