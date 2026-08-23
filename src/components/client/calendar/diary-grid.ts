// Pure geometry for the diary: turning appointments into positions on a grid of
// time (down) against clinician (across). Kept out of the .tsx because the board
// is a client component and vitest collects only src/**/*.test.ts.
//
// Nothing here knows what the diary LOOKS like. It answers three questions that
// any column-and-time diary has to answer however it is styled:
//   - where does an appointment sit vertically, and how tall is it,
//   - when two appointments overlap, how do they share the column's width,
//   - how far does the day extend, top and bottom.

import { londonDayKey } from "@/lib/time/london";
import { occupiesTime } from "@/lib/calendar/working-spans";

/** Minutes past midnight, Europe/London, for an ISO instant. NaN if unparseable.
 *
 *  MUST be London, not UTC: through BST every appointment would otherwise be
 *  drawn an hour too high on the grid, which on a diary is not a cosmetic error
 *  but a clinical one. */
export function londonMinutes(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return Number.NaN;
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23", // never "24:00" for midnight, which h12/h24 can produce
    timeZone: "Europe/London",
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.NaN;
  return h * 60 + m;
}

/**
 * An appointment's true length in minutes.
 *
 * `finish` is preferred when Dentally supplies a sane one, because that is the
 * booked end; `durationMin` is the fallback. A finish that is missing, before
 * the start, or on a different London day (an overnight value, which a dental
 * diary never legitimately has) is rejected rather than trusted, since it would
 * otherwise draw a block running off the bottom of the grid.
 */
export function effectiveMinutes(appt: {
  start: string;
  finish: string | null;
  durationMin: number;
}): number {
  const fallback = appt.durationMin > 0 ? appt.durationMin : 30;
  if (!appt.finish) return fallback;
  const startMs = Date.parse(appt.start);
  const finishMs = Date.parse(appt.finish);
  if (Number.isNaN(startMs) || Number.isNaN(finishMs)) return fallback;
  if (finishMs <= startMs) return fallback;
  if (londonDayKey(new Date(appt.start)) !== londonDayKey(new Date(appt.finish))) return fallback;
  return Math.round((finishMs - startMs) / 60_000);
}

export interface Placed<T> {
  item: T;
  /** Minutes past London midnight at which the block starts. */
  startMin: number;
  /** Minutes past London midnight at which it ends. */
  endMin: number;
  /** 0-based horizontal slot within the overlapping cluster. */
  lane: number;
  /** How many slots that cluster is DRAWN in, so one slot is 1/lanes wide. */
  lanes: number;
  /**
   * How many consecutive slots this block actually fills, starting at `lane`.
   *
   * Almost always equal to `lanes - lane` on a quiet column and 1 on a genuine
   * clash. See `layoutColumn`: it is what stops a chain of appointments that
   * merely touch a clash from all being drawn at the clash's width.
   */
  span: number;
  /**
   * How far past the drawn lane cap this block sits. 0 for every ordinary
   * block; 1, 2, ... for the fourth, fifth, ... simultaneous booking, which is
   * drawn in the last slot, stepped right and stacked in front rather than made
   * narrower. Nothing is ever hidden. See MAX_DRAWN_LANES.
   */
  depth: number;
  /**
   * A RECOVERABLE row -- cancelled or did-not-attend -- that shares its time
   * with a real booking and is therefore drawn as a slim tab down the column's
   * right edge instead of taking half the width off a patient who is coming in.
   * See `layoutColumn`.
   */
  strip: boolean;
  /**
   * True when a recoverable tab overlaps this block's own hour, so the block
   * must give up RECOVERABLE_STRIP_PX at its right edge for it.
   *
   * Without the reservation the tab is painted OVER the card and takes its state
   * mark and the end of the patient's name with it -- which would have swapped
   * one unreadable block for another.
   */
  edgeInset: boolean;
  /**
   * The COALESCED RUN this edge tab belongs to, or null for every block that is
   * not an edge tab. See `recoverableRuns`.
   */
  stripRun: RecoverableRun<T> | null;
}

/**
 * A contiguous run of recoverable rows sharing ONE edge tab.
 *
 * ROUND 2's CORRECTION. Round 1 gave every shadowed cancellation its own 14px
 * tab, and the practice's Saturday had four of them touching inside one hour:
 * what the owner saw at 12:00 was a picket fence of thin bars carrying X, X, DNA,
 * X, two of them drawn over each other where the times overlapped. Four tabs are
 * not four facts. The fact is "this hour holds four rows that did not happen", so
 * contiguous recoverables now share one tab carrying the COUNT.
 *
 * CONTIGUOUS MEANS OVERLAPPING OR TOUCHING. Two cancellations at 12:00-12:15 and
 * 12:15-12:30 already drew as one unbroken 14px bar with two marks on it; giving
 * them one mark and the number 2 is the whole of the fix. A recoverable row that
 * touches nothing is a run of one and is drawn exactly as round 1 drew it.
 *
 * NOTHING IS DROPPED. Every row keeps its own `Placed` entry, its own DOM block,
 * its own id, its own click target, its own place in the keyboard order and its
 * own announced sentence -- the board's focus path resolves a block by id, so a
 * row collapsed out of the DOM would be a tab stop that focuses nothing. Only the
 * PAINT is shared: `index === 0` draws the tab over the whole run's extent, and
 * the rest are transparent hit targets at their own true times. An appointment is
 * never drawn at a time that is not its own, tab or no tab.
 *
 * WHY THE MEMBER ORDER IS start ASC THEN end DESC. Later members are drawn over
 * earlier ones, so a row wholly covered by the row after it would keep its
 * keyboard place but lose its pointer target. Longest-first on a tie means a row
 * nested inside another always leaves the outer one exposed below it.
 */
export interface RecoverableRun<T> {
  /** The merged extent of the whole run: what the ONE tab is drawn over. */
  startMin: number;
  endMin: number;
  /** How many recoverable rows this tab stands for. Always at least 1. */
  count: number;
  /** This row's place in the run, earliest first. Only 0 paints the tab. */
  index: number;
  /** Every row in the run, in that same order, so the tab can name them all. */
  rows: readonly T[];
}

/**
 * The most slots a cluster is ever DIVIDED into.
 *
 * Three, because a 112px column in thirds is 37px, which still carries a state
 * mark and a short name, and a quarter of it does not carry anything at all. A
 * fourth simultaneous booking against one clinician is not a layout problem to
 * be solved by making every block thinner -- it is a diary emergency -- so it is
 * drawn in the last slot, stepped 5px right and stacked in front of the one
 * behind it. It keeps its full height, its colour, its click target, its place
 * in the keyboard order and its accessible sentence, which already counts the
 * clash ("double booked with 3 others"). The step IS the overflow indicator.
 */
export const MAX_DRAWN_LANES = 3;

/** How far each block past the cap is stepped right, in px. */
export const LANE_CASCADE_PX = 5;

/**
 * The width of the tab a cancelled or missed appointment is drawn as when it
 * shares its time with a real booking.
 *
 * 14px: wide enough to carry a state mark and be a full-height click target,
 * narrow enough that the patient who IS coming in keeps the column. Dentally
 * takes cancellations out of the diary altogether; this keeps a trace of one,
 * because a receptionist looking at a full-looking Tuesday needs to know which
 * of those hours are actually recoverable.
 *
 * It lives HERE rather than beside the markup because the layout has to reserve
 * it: a tab painted over the right edge of a full-width card hides that card's
 * state mark and eats the end of the patient's name.
 */
export const RECOVERABLE_STRIP_PX = 14;

interface RawSpan<T> {
  item: T;
  startMin: number;
  endMin: number;
}

const overlaps = (a: { startMin: number; endMin: number }, b: { startMin: number; endMin: number }) =>
  a.startMin < b.endMin && b.startMin < a.endMin;

/**
 * Lay a single clinician's appointments out within their column, resolving
 * overlaps side by side.
 *
 * THREE RULES, and the diary was unreadable on a busy column because it had only
 * the first of them.
 *
 * 1. LANES ARE COUNTED PER CLUSTER of mutually overlapping appointments, not per
 *    column. A practice that double-books once at 09:00 gets two half-width
 *    blocks at 09:00 and full-width blocks for the rest of the day. A block
 *    starting exactly when the one before it ends does NOT overlap it: back to
 *    back is the normal case and must never read as a clash.
 *
 * 2. A BLOCK EXPANDS INTO THE SLOTS BESIDE IT THAT NOTHING OCCUPIES. This is the
 *    rule that was missing, and it is what turned a busy Saturday into a picket
 *    fence. A cluster is a CHAIN, not a crowd: A 09:00-09:30 clashing with B,
 *    then C 09:15-11:00, then D 10:00-10:30 are one cluster of three lanes, but
 *    at 10:00 there are only two appointments in the room. Without expansion D
 *    was drawn at a third of a 112px column -- 37px, of which 22 was padding --
 *    and the practice saw hair-thin bars with no text on them. With it, D fills
 *    its own slot and the empty one beside it. Width is `span / lanes`, and a
 *    block with nothing to its right for its whole length is full width however
 *    busy the rest of its cluster is.
 *
 * 3. A CANCELLED OR MISSED APPOINTMENT NEVER TAKES WIDTH OFF A REAL ONE. Every
 *    other rule in this codebase already agrees that those two states do not
 *    consume the clinician's time -- the capacity figure, the drop validator,
 *    the white/grey paint, all through `occupiesTime` -- and the diary's own
 *    lane layout was the last place still counting them. On the day this was
 *    written the practice's busiest column carried 13 cancellations and 6
 *    no-shows beside 16 real bookings, and a cancelled row was holding a quarter
 *    of the column's width away from patients who were actually coming in. So
 *    lanes are competed for by OCCUPYING rows; a recoverable row that shares its
 *    time with one is drawn as a slim tab down the right edge (`strip`), and one
 *    that shares its time with nothing is drawn full width exactly as before,
 *    because there a dashed white block genuinely does mean "this hour is free".
 *
 * Appointments that cannot be positioned (unparseable start) are dropped and
 * reported separately by `layoutColumn`'s caller, never silently placed at
 * midnight where they would look like a real 00:00 booking.
 */
export function layoutColumn<
  T extends { start: string; finish: string | null; durationMin: number; state?: string },
>(appointments: readonly T[]): Placed<T>[] {
  const spans: RawSpan<T>[] = appointments
    .map((item) => {
      const startMin = londonMinutes(item.start);
      return { item, startMin, endMin: startMin + effectiveMinutes(item) };
    })
    .filter((s) => Number.isFinite(s.startMin))
    // Earliest first; on a tie the longer block leads, so the wide one takes
    // lane 0 and the short one tucks beside it rather than the reverse.
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // An appointment whose state we cannot read counts as occupying: a state we do
  // not recognise is not evidence that a slot is free. occupiesTime says so.
  const live = spans.filter((s) => occupiesTime(s.item.state ?? ""));
  const recoverable = spans.filter((s) => !occupiesTime(s.item.state ?? ""));

  // A cancellation sitting in an hour nothing else uses is still the clearest
  // possible statement that the hour is recoverable, so it keeps the full width
  // it has always had -- laid out among the OTHER free-standing recoverable rows,
  // so two cancellations at the same time still sit side by side.
  const shadowed = recoverable.filter((r) => live.some((l) => overlaps(l, r)));
  const freeStanding = recoverable.filter((r) => !live.some((l) => overlaps(l, r)));

  const placed: Placed<T>[] = [
    // Every block whose hour a tab lands in gives up the tab's width, so the tab
    // is drawn BESIDE the card rather than over the end of the patient's name.
    ...layoutLanes(live).map((p) => ({
      ...p,
      edgeInset: p.lane + p.span >= p.lanes && shadowed.some((s) => overlaps(s, p)),
      stripRun: null,
    })),
    ...layoutLanes(freeStanding).map((p) => ({ ...p, stripRun: null })),
    ...recoverableRuns(shadowed).map((s) => ({
      ...s,
      lane: 0,
      lanes: 1,
      span: 1,
      depth: 0,
      strip: true,
      edgeInset: false,
    })),
  ];

  // Reading order, so the DOM order matches the eye's: down the column, then
  // left to right across a clash, with the edge tabs last. Within one coalesced
  // run the tab that PAINTS it sorts first, so the transparent hit targets for
  // the rest of the run sit over it rather than under it.
  return placed.sort(
    (a, b) =>
      Number(a.strip) - Number(b.strip) ||
      a.startMin - b.startMin ||
      (a.stripRun?.index ?? 0) - (b.stripRun?.index ?? 0) ||
      a.lane - b.lane ||
      a.depth - b.depth,
  );
}

/**
 * Group shadowed recoverable rows into contiguous runs, one drawn tab each.
 *
 * Sorted earliest first (longest first on a tie: see RecoverableRun), then
 * walked: a row starting at or before the running end joins the run, and anything
 * later starts a fresh one. TOUCHING JOINS, because two cancellations that meet
 * at 12:15 already drew as one unbroken bar and the reader gained nothing from
 * the seam between them.
 *
 * Every input row comes back out, carrying the run it belongs to and its place in
 * it. This decides the PAINT and never what exists.
 */
function recoverableRuns<T>(
  spans: readonly RawSpan<T>[],
): (RawSpan<T> & { stripRun: RecoverableRun<T> })[] {
  const sorted = [...spans].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const runs: RawSpan<T>[][] = [];
  let endMin = Number.NEGATIVE_INFINITY;
  for (const s of sorted) {
    // Strictly AFTER the running end starts a new run; at or before it joins.
    if (runs.length === 0 || s.startMin > endMin) {
      runs.push([s]);
      endMin = s.endMin;
      continue;
    }
    runs[runs.length - 1].push(s);
    endMin = Math.max(endMin, s.endMin);
  }

  return runs.flatMap((members) => {
    const startMin = Math.min(...members.map((m) => m.startMin));
    const runEnd = Math.max(...members.map((m) => m.endMin));
    const rows = members.map((m) => m.item);
    return members.map((m, index) => ({
      ...m,
      stripRun: { startMin, endMin: runEnd, count: members.length, index, rows },
    }));
  });
}

/** Rules 1 and 2, over one set of rows that genuinely compete for the width. */
function layoutLanes<T>(spans: readonly RawSpan<T>[]): Omit<Placed<T>, "stripRun">[] {
  const placed: Omit<Placed<T>, "strip" | "edgeInset" | "stripRun">[] = [];
  let cluster: (RawSpan<T> & { lane: number })[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  // The end time of the last appointment in each lane of the current cluster.
  let laneEnds: number[] = [];

  const flush = () => {
    const rawLanes = Math.max(1, laneEnds.length);
    // The DRAWN denominator: never more than a few, however many the cluster
    // needed. See MAX_DRAWN_LANES.
    const lanes = Math.min(rawLanes, MAX_DRAWN_LANES);
    for (const c of cluster) {
      const depth = Math.max(0, c.lane - (lanes - 1));
      const lane = Math.min(c.lane, lanes - 1);
      // How far right this block may reach before it meets something that is on
      // at the same time. A block past the cap is stacked, not stretched.
      let span = 1;
      if (depth === 0) {
        for (let l = c.lane + 1; l < rawLanes; l += 1) {
          if (cluster.some((o) => o.lane === l && overlaps(o, c))) break;
          span += 1;
        }
        span = Math.min(span, lanes - lane);
      }
      placed.push({ item: c.item, startMin: c.startMin, endMin: c.endMin, lane, lanes, span, depth });
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const span of spans) {
    // A block starting exactly when the cluster ends does not overlap it, so it
    // begins a fresh cluster and gets the full width. Back-to-back appointments
    // are the normal case and must not be treated as a clash.
    if (span.startMin >= clusterEnd) flush();

    let lane = laneEnds.findIndex((end) => end <= span.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(span.endMin);
    } else {
      laneEnds[lane] = span.endMin;
    }
    cluster.push({ ...span, lane });
    clusterEnd = Math.max(clusterEnd, span.endMin);
  }
  flush();

  return placed.map((p) => ({ ...p, strip: false, edgeInset: false }));
}

/**
 * The vertical extent of the grid, in minutes past midnight, snapped out to
 * whole hours.
 *
 * The practice's normal opening hours are always shown even on a quiet day, so
 * the diary does not shrink to a single appointment and mislead about how much
 * of the day is free. Anything booked outside those hours extends the grid
 * rather than being clipped: an early emergency at 07:15 must be visible, and a
 * block scrolled out of sight is a missed patient.
 */
export function dayBounds(
  spans: readonly { startMin: number; endMin: number }[],
  openMin = 8 * 60,
  closeMin = 19 * 60,
): { startMin: number; endMin: number } {
  let lo = openMin;
  let hi = closeMin;
  for (const s of spans) {
    if (!Number.isFinite(s.startMin) || !Number.isFinite(s.endMin)) continue;
    lo = Math.min(lo, s.startMin);
    hi = Math.max(hi, s.endMin);
  }
  const startMin = Math.max(0, Math.floor(lo / 60) * 60);
  const endMin = Math.min(24 * 60, Math.ceil(hi / 60) * 60);
  // A degenerate window (everything at one instant) still needs height to draw.
  return endMin > startMin ? { startMin, endMin } : { startMin, endMin: startMin + 60 };
}

/**
 * Where the "now" marker sits as a 0..1 fraction of the grid's height, or null
 * when the current time is outside the drawn day or the diary is not showing
 * today. Returning null rather than clamping matters: a line pinned to the top
 * of the grid on a day that is not today reads as "it is 08:00", which is worse
 * than no line at all.
 */
export function nowFraction(
  now: Date,
  viewedDayKey: string,
  bounds: { startMin: number; endMin: number },
): number | null {
  if (londonDayKey(now) !== viewedDayKey) return null;
  const min = londonMinutes(now.toISOString());
  if (!Number.isFinite(min)) return null;
  if (min < bounds.startMin || min > bounds.endMin) return null;
  const span = bounds.endMin - bounds.startMin;
  if (span <= 0) return null;
  return (min - bounds.startMin) / span;
}

/** The hour marks to rule across the grid, inclusive of both ends. */
export function hourMarks(bounds: { startMin: number; endMin: number }): number[] {
  const marks: number[] = [];
  for (let m = Math.ceil(bounds.startMin / 60) * 60; m <= bounds.endMin; m += 60) marks.push(m);
  return marks;
}

/** "09:00" for minutes past midnight. */
export function labelMinutes(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface DiaryColumn {
  /** Dentally practitioner id, or null for the unassigned column. */
  id: string | null;
  name: string;
}

/**
 * The columns for a day: every active clinician at the site, in a stable order,
 * plus an "Unassigned" column at the end IF and only if something that day has
 * no practitioner.
 *
 * Clinicians with nothing booked still get a column: an empty column is the
 * information that they are free, and dropping it would make a quiet day look
 * fully staffed. The unassigned column is conditional because it is an
 * exception: showing it permanently would imply a queue that usually is not
 * there, but hiding it when it has contents would lose appointments entirely.
 */
export function diaryColumns(
  practitioners: readonly { id: string; name: string }[],
  appointments: readonly { practitionerId: string | null; practitioner: string | null }[],
): DiaryColumn[] {
  const columns: DiaryColumn[] = practitioners.map((p) => ({ id: p.id, name: p.name }));
  const known = new Set(columns.map((c) => c.id));

  // A clinician who appears in the day's appointments but not in the active
  // practitioner list (a locum, or someone deactivated since the booking) still
  // needs a column, or their patients vanish from the diary.
  const extras = new Map<string, string>();
  let anyUnassigned = false;
  for (const appt of appointments) {
    if (appt.practitionerId === null) {
      anyUnassigned = true;
      continue;
    }
    if (!known.has(appt.practitionerId) && !extras.has(appt.practitionerId)) {
      extras.set(appt.practitionerId, appt.practitioner ?? "Other clinician");
    }
  }
  for (const [id, name] of extras) columns.push({ id, name });
  if (anyUnassigned) columns.push({ id: null, name: "Unassigned" });
  return columns;
}
