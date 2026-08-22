// ===========================================================================
// WORKING TIME: the union that makes GREY MEAN OFF.
//
// The grid starts GREY and working time is PAINTED ONTO IT in white. A clinician
// can therefore only ever read as available because something positively said so.
//
// workingSpans = merge( that practitioner's availability windows for the day,
//                       UNION their own booked appointment spans for the day )
//
// Booked appointments count as working time, and it is now PROVEN that they have
// to. Measured against live Dentally on 2026-08-21: the availability endpoint
// returns a practitioner's FREE GAPS inside their sessions, not the sessions
// themselves. A clinician booked 09:30-17:50 against a session ending at 18:00
// returned exactly one row, 17:50-18:00; a clinician booked solid returned NONE.
// Taken alone, availability therefore says a fully booked clinician is not
// working, and carves a hole out of the day wherever somebody is with a patient.
// The union is what puts the day back.
//
// It is also what keeps TODAY honest. Dentally refuses to answer for any instant
// in the past, so this morning's free gaps are unaskable by lunchtime; what the
// union restores is the part of the morning that is actually EVIDENCED -- a
// booked appointment is proof the clinician was in at that time. Nothing is
// extrapolated from other days.
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

/**
 * Whether an appointment in this state CONSUMES the clinician's time.
 *
 * cancelled and did_not_attend do not: nobody was treated, and the slot is
 * recoverable. Everything else does, INCLUDING a state we do not recognise --
 * a state we cannot read is not evidence that a slot is free.
 *
 * It lives here, in the module whose header spends thirty lines arguing which
 * states count as evidence, because the rule was written out by hand in four
 * separate places (day-load, move-service, the diary's capacity filter and the
 * grid's lane layout) and a diary that paints a cancellation as free time while
 * the drop validator treats it as occupied is a booking made into a slot the
 * screen said was empty. One predicate, so the paint and the refusal cannot
 * come to disagree.
 */
export function occupiesTime(state: string): boolean {
  return state !== "cancelled" && state !== "did_not_attend";
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
 *   "past"         the day has ended, and Dentally's availability endpoint
 *                  refuses every question about a time that is not in the
 *                  future. -> the hatch, with its own words again. Nothing
 *                  failed and nothing will change by retrying.
 *   "unreportable" PART of the day -- the part that had already gone by when we
 *                  asked -- could not be asked about, and nothing came back for
 *                  the rest of it. -> the hatch, with words of its own. This is
 *                  today, seen after lunch, for a clinician who worked the
 *                  morning and has nothing booked.
 *
 * These six must never collapse. A failed read painted grey is a positive claim
 * that the practice is closed, which on a busy Monday sends a receptionist
 * ringing patients to cancel. "unconfirmed" painted white is another practice's
 * free time offered as this one's capacity, which is how a patient ends up booked
 * with a clinician who is not in the building. And "past" told as a failure
 * ("could not be read ... try again shortly") is an alarm about a date nobody can
 * do anything about, which is how staff learn to ignore the alarms that matter.
 *
 * "unreportable" IS NOT "past" WITH KINDER WORDING, and that was the tempting
 * shortcut. "Date has passed" is exactly right about last Monday and flatly wrong
 * about today: today is the day the practice is working, the day a receptionist
 * is filling, and a column telling them today has passed teaches them to distrust
 * the other five states too. The elapsed HOURS are unreportable; the DAY is not.
 */
export type ColumnWorkState =
  | "working"
  | "off"
  | "unknown"
  | "unconfirmed"
  | "past"
  | "unreportable";

/** What a column made of one state looks like: the texture, and the words. */
export interface ColumnWorkPresentation {
  /**
   * The HATCH rather than a colour. True for every state that is not a claim we
   * can stand behind about the clinician.
   */
  hatched: boolean;
  /**
   * The column header's second line -- or null for the one state that has
   * something better to say, "working" printing its appointment counts instead.
   */
  label: string | null;
  /**
   * Said INSTEAD of `label` while the availability read is still in flight. The
   * TEXTURE does not change, because a pending read is still no answer; the
   * WORDS do, because a failure sentence flashing on every day change is a false
   * alarm, and an alarm a receptionist learns to ignore is worse than none.
   */
  pendingLabel?: string;
  /**
   * Whether the header's second line is set in the LOUD weight -- the emphasis
   * that says "this one needs you", as against the quiet grey of a line that is
   * merely informative.
   *
   * `"whenHoursSettled"` is the honest third value and not a cleverness: "unknown"
   * is loud once the read has come back and stayed unknown, and quiet while it is
   * still in flight, because a failure shouting on every day change is the false
   * alarm the pendingLabel above exists to avoid. Modelled as a value rather than
   * a callback so this Record stays something you can READ -- all six states'
   * loudness visible in one column, which is the property that makes an omission
   * obvious.
   */
  loud: boolean | "whenHoursSettled";
  /**
   * The hatch drawn at HALF STRENGTH.
   *
   * The texture still says "we do not have an answer", because that is still
   * true; the volume says nobody has to do anything about it. Only the finished
   * day below sets it, and only because the same texture that reads as "look at
   * this" at eleven in the morning reads as noise at seven in the evening.
   */
  quietHatch?: boolean;
}

/**
 * What a column may say once THE DAY IT DESCRIBES HAS RUN OUT.
 *
 * WHY A SECOND RECORD AND NOT A CONDITION AT THE USE SITE. "unreportable" is
 * honest per column and, at half past three, actionable: a receptionist can see
 * that the morning is missing and that the afternoon is still askable. At seven
 * in the evening it is neither. Every clinician's whole day is behind the clamp,
 * so every one of thirteen columns says the same sentence at once, and thirteen
 * copies of a caveat is not thirteen facts -- it is a screen that reads as
 * broken. The owner's word for it, seeing it beside Dentally, was "terrible".
 *
 * So the STATE does not change (nothing new was learned about the clinician, and
 * columnWorkState is untouched); the PRESENTATION does. The header stops
 * repeating a caveat nobody can act on and prints the day's counts instead --
 * which is what every other finished day in the diary prints -- the hatch drops
 * to half strength, and the caveat itself is said ONCE, quietly, under the date.
 *
 * KEYED BY THE UNION, like its sibling above, so a seventh state is a compile
 * error here too. `null` means "this state has nothing different to say when the
 * day is over", which is the honest answer for five of the six:
 *
 *   working       already prints counts. Nothing to collapse.
 *   off           we asked about the whole day and they were not in. Still true
 *                 at midnight, and "Not working" is the fact, not a caveat.
 *   unknown       a read that FAILED does not become fine because time passed.
 *                 It is the one state that must keep shouting.
 *   unconfirmed   a clinician who might have been at another practice is still
 *                 unplaced tomorrow, when somebody has to reconcile the day.
 *   past          "Date has passed" IS the finished-day sentence already.
 */
export const COLUMN_WORK_ELAPSED_DAY: Record<ColumnWorkState, ColumnWorkPresentation | null> = {
  working: null,
  off: null,
  unknown: null,
  unconfirmed: null,
  past: null,
  // The counts, not the caveat. Hatched still, because we genuinely never got an
  // answer about these hours -- but quietly, and with no sentence of its own.
  unreportable: { hatched: true, quietHatch: true, label: null, loud: false },
};

/** What both grids pass in beside the state: the reading, not the claim. */
export interface ColumnWorkContext {
  /** The availability read is still in flight. */
  hoursPending?: boolean;
  /**
   * How many minutes of the practice's own working day still lie AHEAD of the
   * minute Dentally's answer begins at -- the part of today that could still be
   * asked about. Zero means the day has run out.
   *
   * DERIVED, never a new server field: it is the site's closing minute for this
   * day minus `answerableFromMin`, both of which the grids already hold. Left
   * `undefined` by a caller that cannot say, and then nothing changes.
   */
  askableMinutesRemaining?: number;
}

/**
 * THE ONE RESOLVER. Every reader of the two Records above goes through this, so
 * the finished-day collapse cannot be applied to the words and forgotten for the
 * texture, or applied in the day grid and forgotten in the week grid.
 */
export function columnWorkPresentation(
  state: ColumnWorkState,
  ctx: ColumnWorkContext = {},
): ColumnWorkPresentation {
  const elapsed = COLUMN_WORK_ELAPSED_DAY[state];
  // A caller that did not say is a caller that does not know: undefined must
  // behave exactly as it did before this rule existed.
  if (elapsed !== null && ctx.askableMinutesRemaining !== undefined && ctx.askableMinutesRemaining <= 0) {
    return elapsed;
  }
  return COLUMN_WORK_PRESENTATION[state];
}

/**
 * THE ONE MAPPING from a state to what a column shows. Both grids read it.
 *
 * WHY A Record AND NOT AN OR-CHAIN. The hatch rule was `state === "unknown" ||
 * ...` here and the words were two parallel ternary chains in the day grid and
 * the week grid, kept in step by a comment. All three were NON-EXHAUSTIVE: a
 * seventh member added to the union compiled clean in every one of them, fell
 * out of the bottom of each chain, and painted a solid grey column headed "Not
 * working" -- a positive claim that a clinician was off, made by an omission,
 * which is the exact failure this module's header exists to refuse. A Record
 * keyed by the union cannot be incomplete: leave a state out and it is a COMPILE
 * error in this file, before anything reaches a receptionist's screen.
 *
 * WHY THE WORDS LIVE HERE and not beside the markup that prints them. The words
 * ARE the distinction between the states -- "Hours not loaded" says we could not
 * find out, "Not working" says we asked and they are off -- so a grid free to
 * choose its own sentence can collapse two states the union spent six members
 * keeping apart, and the day view and the week view can say different things
 * about the same clinician on the same day.
 *
 * AND WHY `loud` JOINED THEM. It was the one per-state property left outside, as a
 * byte-identical or-chain in each grid:
 *
 *     (state === "unknown" && !hoursPending) || state === "unconfirmed"
 *
 * which is the same non-exhaustive shape this Record was built to end, one property
 * later. A seventh member of the union compiled clean in both chains, fell out of
 * the bottom of each, and rendered QUIET -- so a state that exists precisely because
 * something needs a human's attention would have been added to the union, worded
 * carefully here, and then whispered. Folded in, an omission is a compile error in
 * this file instead.
 */
export const COLUMN_WORK_PRESENTATION: Record<ColumnWorkState, ColumnWorkPresentation> = {
  // We asked, and they are in. The header carries the counts, not a sentence.
  working: { hatched: false, label: null, loud: false },
  // We asked, and they are not. The ONLY state grey may be painted for: a claim
  // about the whole day, made only when the whole day was answerable. Quiet: it is
  // an ordinary fact about a rota, not something anybody has to act on.
  off: { hatched: false, label: "Not working", loud: false },
  // "Hours not loaded" is a DIFFERENT sentence from "Not working": the first says
  // we could not find out, the second says we asked and they are off. Collapsing
  // them is the confident empty this whole design refuses. LOUD once the read has
  // settled -- a column nobody can read is a column nobody should book into -- and
  // quiet while it is still in flight, when there is nothing yet to be alarmed by.
  unknown: {
    hatched: true,
    label: "Hours not loaded",
    pendingLabel: "Reading hours",
    loud: "whenHoursSettled",
  },
  // NOT "Not working". They may well be working, at another of these practices,
  // and their availability carries no site to tell us. LOUD, and the only state
  // that is loud unconditionally: it is the one a receptionist can actually do
  // something about, by finding out where the clinician is today.
  unconfirmed: { hatched: true, label: "Not confirmed here", loud: true },
  // NOT "Hours not loaded" either: nothing failed and nothing will load. Dentally
  // will not answer for a date that has gone by. Quiet, for the same reason it is
  // not worded as a failure: there is nothing to be done about a date in the past,
  // and an alarm about one teaches staff to ignore the alarms that matter.
  past: { hatched: true, label: "Date has passed", loud: false },
  // NOT "Date has passed": the date is TODAY, and today has not passed. NOT "Not
  // working" either: their morning is missing from the answer because Dentally
  // only reports hours from now onwards, and silence about the morning is not
  // evidence. Quiet: the day is working normally from here on, and the gap is in
  // the history rather than in anything ahead of the reader.
  unreportable: { hatched: true, label: "Hours not reportable", loud: false },
};

/**
 * The states that get the HATCH rather than a colour.
 *
 * Derived from the mapping above, so the texture cannot disagree with the words
 * and neither can be forgotten for a new state.
 */
export function columnIsHatched(state: ColumnWorkState, ctx: ColumnWorkContext = {}): boolean {
  return columnWorkPresentation(state, ctx).hatched;
}

/**
 * Whether that hatch is drawn at half strength. See ColumnWorkPresentation's
 * `quietHatch`: same claim, lower volume, for a day nobody can act on.
 */
export function columnHatchIsQuiet(state: ColumnWorkState, ctx: ColumnWorkContext = {}): boolean {
  return columnWorkPresentation(state, ctx).quietHatch === true;
}

/**
 * The column header's second line for this state, or null when the column should
 * print its appointment counts instead.
 *
 * Both grids call THIS rather than restating the words, so a state can only ever
 * be worded once. `hoursPending` is the availability read still being in flight.
 */
export function columnWorkSummary(
  state: ColumnWorkState,
  opts: ColumnWorkContext = {},
): string | null {
  const shown = columnWorkPresentation(state, opts);
  return opts.hoursPending === true && shown.pendingLabel !== undefined
    ? shown.pendingLabel
    : shown.label;
}

/**
 * Whether this state's header line is set in the LOUD weight. Both grids call
 * THIS rather than restating the rule, for the same reason they both call
 * `columnWorkSummary`: two copies of a rule about six states is two chances to
 * word a seventh one silently.
 *
 * NOT the whole story on either screen. A grid ORs in its own failure -- the
 * counts it could not load, which is that screen's read failing rather than
 * anything about the clinician -- and that stays where it belongs, beside the
 * screen that failed.
 */
export function columnIsLoud(
  state: ColumnWorkState,
  opts: ColumnWorkContext = {},
): boolean {
  const loud = columnWorkPresentation(state, opts).loud;
  return loud === "whenHoursSettled" ? opts.hoursPending !== true : loud;
}

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
  /**
   * True when this day had already ended when availability was read, so Dentally
   * could not be asked about it at all. See day-load's unanswerableDayKeys.
   */
  availabilityUnanswerable?: boolean;
  /**
   * The London wall-minute this day's availability answer BEGINS at. 0 (the
   * default) means the whole day was asked about; anything higher means the
   * request had to be clamped into the future and the hours before it were never
   * asked about at all. See diaryAvailabilityRequest's answerableFromMin.
   */
  answerableFromMin?: number;
}): ColumnWorkState {
  // A failed APPOINTMENT read matters as much as a failed availability read here,
  // because the union includes appointments: a missing appointment set would
  // shrink the white area and make booked time read as off.
  //
  // CHECKED FIRST, ahead of "past". A read that failed for reasons we do not
  // understand must not be explained away by the calendar: if the appointments
  // are missing too, the honest word is still "we do not know".
  if (args.availabilityFailed || args.appointmentsFailed) return "unknown";
  // The day is over and the question is unaskable. Distinguished from "off"
  // because grey would claim the practice was shut on a day we never got to ask
  // about, and from "unknown" because nothing is wrong and retrying cannot help.
  if (args.availabilityUnanswerable === true) return "past";
  // Checked BEFORE the emptiness test, so an unconfirmed clinician never reads as
  // "Not working": that is a claim about them, and the truth is a gap in what we
  // can see.
  if (args.presenceConfirmed === false) return "unconfirmed";
  if (workingSpans(args.windows, args.apptSpans).length === 0) {
    // NOTHING CAME BACK -- but for part of this day nothing was ASKED. Dentally
    // omits a window that had already closed when the question was put, so a
    // clinician who worked 09:00-13:00 and has nothing booked returns an empty
    // answer from lunchtime onwards, every single day. "Off" is a claim about the
    // WHOLE day, and it may only be made when the whole day was answerable.
    if ((args.answerableFromMin ?? 0) > 0) return "unreportable";
    return "off";
  }
  // A single booked appointment is enough to rescue the column: it is positive
  // evidence the clinician was in, so the union is non-empty and this reads as
  // "working" exactly as it did before. The hours we could not ask about are then
  // a matter for the paint, not for the state.
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
