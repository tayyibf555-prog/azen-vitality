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
  /** How many slots that cluster needs, so width is 1/lanes. */
  lanes: number;
}

/**
 * Lay a single clinician's appointments out within their column, resolving
 * overlaps side by side.
 *
 * Lanes are counted PER CLUSTER of mutually overlapping appointments, not per
 * column. A practice that double-books once at 09:00 should get two half-width
 * blocks at 09:00 and full-width blocks for the rest of the day; counting lanes
 * across the whole column instead would halve every appointment from 08:00 to
 * 19:00 because of that single clash, which is how a diary becomes unreadable.
 *
 * Appointments that cannot be positioned (unparseable start) are dropped and
 * reported separately by `layoutColumn`'s caller, never silently placed at
 * midnight where they would look like a real 00:00 booking.
 */
export function layoutColumn<T extends { start: string; finish: string | null; durationMin: number }>(
  appointments: readonly T[],
): Placed<T>[] {
  const spans = appointments
    .map((item) => {
      const startMin = londonMinutes(item.start);
      return { item, startMin, endMin: startMin + effectiveMinutes(item) };
    })
    .filter((s) => Number.isFinite(s.startMin))
    // Earliest first; on a tie the longer block leads, so the wide one takes
    // lane 0 and the short one tucks beside it rather than the reverse.
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const placed: Placed<T>[] = [];
  let cluster: { item: T; startMin: number; endMin: number; lane: number }[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  // The end time of the last appointment in each lane of the current cluster.
  let laneEnds: number[] = [];

  const flush = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const c of cluster) placed.push({ ...c, lanes });
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

  return placed;
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
