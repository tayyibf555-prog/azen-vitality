// ===========================================================================
// DENTALLY AVAILABILITY -> DIARY WINDOWS.
//
// The honest source for "who is working" is Dentally's own availability, not our
// config. Our config has never been checked against the practice and is already
// contradicted by live windows running to 20:00.
//
// GET /v1/appointments/availability returns WINDOWS, not slots, per practitioner.
// This module parses those rows into the diary's own geometry: a London day key
// plus minutes past midnight on the clock face.
//
// It deliberately does NOT reuse fetchAvailabilityDays (src/lib/booking): that
// clamps the start to `now` and drops everything not strictly in the future, so
// this morning and every past day would silently render as "not working", and it
// pre-chunks windows into 30 minute booking slots at the parse seam. The diary
// needs the RAW window, because the window is what shades a session.
// ===========================================================================

import { londonDayKey } from "@/lib/time/london";

/** One availability window, on one London day, for one practitioner. */
export interface AvailabilityWindow {
  practitionerId: string;
  dayKey: string;
  /** Minutes past London midnight on the clock face. */
  startMin: number;
  endMin: number;
}

/**
 * Above this proportion of untagged rows, the whole read is treated as FAILED.
 *
 * A row with no practitioner_id cannot be attributed to a column, and one such
 * row is a tolerable oddity. A quarter of them means the multi-practitioner
 * batching assumption (asserted only by a commit message, never proven against
 * live Dentally) has broken, and a partly-attributed availability set is worse
 * than none: it shrinks somebody's working day without saying so.
 */
export const UNTAGGED_FAIL_RATIO = 0.25;

const DAY_MINUTES = 1440;
const MAX_SPAN_DAYS = 90;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const LONDON_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** The Europe/London wall clock for an instant, as "HH:MM". */
function londonClock(ms: number): string {
  // en-GB renders midnight as "24:00" in some ICU builds; normalise it.
  const raw = LONDON_CLOCK.format(new Date(ms));
  return raw.startsWith("24:") ? `00:${raw.slice(3)}` : raw;
}

/** Minutes past London midnight on the clock face, for an instant. */
export function londonWallMinutes(ms: number): number {
  const [h, m] = londonClock(ms).split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * The UTC instant (ms) whose Europe/London wall clock is `dayKey` at hh:mm.
 *
 * London is UTC+0 or UTC+1, so trying both offsets and keeping the one whose
 * London wall clock actually matches is exact all year, DST changeover days
 * included. NEVER concatenate "T00:00:00Z": that is an hour out through British
 * Summer Time, which passes locally against a Z-emitting mock and is wrong in the
 * practice.
 */
export function londonInstantMs(dayKey: string, hour: number, minute: number): number {
  const wanted = `${pad2(hour)}:${pad2(minute)}`;
  const naive = Date.parse(`${dayKey}T${wanted}:00Z`);
  if (Number.isNaN(naive)) return NaN;
  for (const offsetMinutes of [0, 60]) {
    const ms = naive - offsetMinutes * 60_000;
    if (londonDayKey(new Date(ms)) === dayKey && londonClock(ms) === wanted) return ms;
  }
  // The wall clock does not exist (the hour skipped at the spring changeover).
  // Fall back to the naive instant rather than throwing; callers clamp anyway.
  return naive;
}

/** The instant of London midnight opening `dayKey`, in ISO form. */
export function londonDayStartIso(dayKey: string): string {
  return new Date(londonInstantMs(dayKey, 0, 0)).toISOString();
}

/** The last instant of `dayKey` in London (23:59:59.999), in ISO form. */
export function londonDayEndIso(dayKey: string): string {
  return new Date(londonInstantMs(dayKey, 23, 59) + 59_999).toISOString();
}

/** The next London day key after `dayKey`. */
export function nextDayKey(dayKey: string): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

// ===========================================================================
// THE WINDOW DENTALLY WILL ACTUALLY ANSWER.
//
// GET /v1/appointments/availability VALIDATES the window before it looks at
// anything, and refuses two shapes outright (400, "The appointment could not be
// processed"):
//
//   start_time  "must be in the future"              -- a start at or before now
//   finish_time "must be greater than 24 hours"      -- a span of 24h or less
//
// MEASURED against live Dentally on 2026-08-21 with a read-only key:
//   today 00:00 -> today 23:59   400, BOTH errors        <- what the diary sent
//   now+1min    -> now+23h       400, finish_time error
//   now+1min    -> now+25h       200
//   17:55       -> +25h          200, and the 17:50-18:00 row came back WHOLE
//
// That last line is the one that makes this safe: rows are NOT clipped to
// start_time, so moving the start forward only loses windows that had ENTIRELY
// ended before it. The rest of the requested day comes back intact.
//
// So the diary asks for a window Dentally accepts and then trims the answer back
// to the days it was actually asked about (availabilityRowsWithinDays). Nothing
// about the requested days is inferred, invented or extrapolated: a day that has
// already ended is reported as unanswerable rather than as "nobody was working".
//
// TODAY IS THE AWKWARD ONE, and it is awkward every single afternoon. A day that
// has ENTIRELY ended is unanswerable and says so. A day still to come is answered
// in full. Today, viewed at any hour but midnight, is neither: the clamp moves the
// question forward to now+2min, and every window that had already CLOSED by then
// is missing from the answer -- not because nobody was working, but because
// nobody could ask. A clinician with a morning session and nothing booked reads,
// at two o'clock, as an empty answer, and an empty answer collapses to grey.
//
// That is why the request also reports answerableFromMin: the wall-minute the
// answer begins at, per day. Before it, silence is silence; from it, an empty
// answer really does mean nobody is in. See columnWorkState, which refuses to say
// "off" about a stretch of the day nobody was able to ask about.
// ===========================================================================

/**
 * How far past `now` the start is pushed. Dentally requires STRICTLY future, and
 * "now" as we measure it is not "now" as their clock measures it, so a couple of
 * minutes absorbs ordinary clock skew between the two machines. Because rows are
 * not clipped (see above) the only cost is a window that ends inside the buffer.
 */
export const AVAILABILITY_START_BUFFER_MS = 2 * 60_000;

/**
 * The minimum span asked for: 25 hours, not the 24 the API names.
 *
 * The rule is "greater than 24 hours", so 24h exactly is refused, and a server
 * comparing `finish > start + 1.day` in a zone-aware way measures 23 or 25 wall
 * hours across a DST changeover. An extra hour costs one wider read and is
 * immune to both.
 */
export const AVAILABILITY_MIN_SPAN_MS = 25 * 3_600_000;

export interface DiaryAvailabilityRequest {
  /** ISO start, always strictly after now. */
  startTime: string;
  /** ISO finish, always more than 24 hours after `startTime`. */
  finishTime: string;
  /**
   * Requested days Dentally CANNOT answer for, because they had already ended
   * when the window was built. Not a failure and not "nobody was working": a day
   * whose availability is no longer knowable, which the column says in words.
   */
  unanswerableDayKeys: string[];
  /**
   * Per requested day, the London wall-minute from which the answer is COMPLETE.
   *
   * At most one day is ever named -- the one the clamped start lands in, which in
   * practice is today -- and only when the clamp actually cost something. Every
   * other requested day is answered from its own midnight and is ABSENT here,
   * which readers take as zero. A day named with 902 means: nothing before 15:02
   * was asked about, so nothing before 15:02 may be reported as "not working".
   *
   * A Record and not a single value because the diary asks for up to seven days
   * at once and threads this per column; a bare number would have to be paired
   * with its day key at every use site, and the pairing is exactly what gets lost.
   */
  answerableFromMin: Record<string, number>;
}

/**
 * The request to send for a requested day range, or null when every requested day
 * has already ended and there is nothing worth asking.
 *
 * `nowMs` is a parameter rather than a clock read so this is pure and testable.
 */
export function diaryAvailabilityRequest(args: {
  fromDayKey: string;
  toDayKey: string;
  nowMs: number;
}): DiaryAvailabilityRequest | null {
  const dayKeys = dayKeysBetween(args.fromDayKey, args.toDayKey);
  if (dayKeys.length === 0) return null;

  const requestedStartMs = londonInstantMs(args.fromDayKey, 0, 0);
  const requestedEndMs = londonDayEndMs(args.toDayKey);
  if (!Number.isFinite(requestedStartMs) || !Number.isFinite(requestedEndMs)) return null;

  const earliestMs = args.nowMs + AVAILABILITY_START_BUFFER_MS;
  // The whole range is over. Dentally can never answer it, so no request is made
  // at all: a guaranteed 400 against a shared rate budget, whose only product is
  // an outage message on a day that is simply in the past.
  if (requestedEndMs <= earliestMs) {
    return null;
  }

  const startMs = Math.max(requestedStartMs, earliestMs);
  const finishMs = Math.max(requestedEndMs, startMs + AVAILABILITY_MIN_SPAN_MS);
  const unanswerableDayKeys = dayKeys.filter((k) => londonDayEndMs(k) <= startMs);

  // WHERE THE CLAMP BIT. When the requested start won, this is a requested
  // midnight and the wall-minute is 0, so nothing is named and every day is
  // answered whole. When `now` won, the start lands inside one requested day and
  // eats the part of it that had already gone by.
  //
  // A day already named unanswerable is NOT named again: it is answered for by
  // nothing at all, which is a stronger statement than "answered from 23:59", and
  // two names for one day is how a caller ends up honouring the weaker one.
  const answerableFromMin: Record<string, number> = {};
  const clampedDayKey = londonDayKey(new Date(startMs));
  const clampedMin = londonWallMinutes(startMs);
  if (
    clampedMin > 0 &&
    dayKeys.includes(clampedDayKey) &&
    !unanswerableDayKeys.includes(clampedDayKey)
  ) {
    answerableFromMin[clampedDayKey] = clampedMin;
  }

  return {
    startTime: new Date(startMs).toISOString(),
    finishTime: new Date(finishMs).toISOString(),
    unanswerableDayKeys,
    answerableFromMin,
  };
}

/** The instant the London day `dayKey` ends (23:59:59.999). */
function londonDayEndMs(dayKey: string): number {
  return londonInstantMs(dayKey, 23, 59) + 59_999;
}

/**
 * Trim raw availability rows back to the requested London day range.
 *
 * The window SENT is wider than the days asked for -- it has to be, or Dentally
 * refuses it -- so without this a one-day diary would quietly inherit tomorrow's
 * windows, and the untagged-row ratio would be computed over rows nobody asked
 * for.
 *
 * Only a row PROVEN to lie outside the range is dropped. A row whose times are
 * unparseable is kept and left to parseAvailabilityWindows, which already has a
 * policy for it; silently discarding it here would hide a shape change.
 */
export function availabilityRowsWithinDays(
  rows: readonly unknown[],
  fromDayKey: string,
  toDayKey: string,
): unknown[] {
  const fromMs = londonInstantMs(fromDayKey, 0, 0);
  const toMs = londonDayEndMs(toDayKey);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [...rows];

  return rows.filter((raw) => {
    const r = asRecord(raw);
    const startMs = Date.parse(typeof r.start_time === "string" ? r.start_time : "");
    const finishMs = Date.parse(typeof r.finish_time === "string" ? r.finish_time : "");
    // Starts after the range ends.
    if (!Number.isNaN(startMs) && startMs > toMs) return false;
    // Ended before the range began. `<=` because a window finishing exactly at
    // London midnight belongs to the day before (see splitAcrossLondonDays).
    if (!Number.isNaN(finishMs) && finishMs <= fromMs) return false;
    return true;
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * A practitioner id as a string, or null when it is genuinely absent.
 *
 * Live Dentally sends NUMBERS and the mock sends strings, so any id used as a
 * join key must normalise both. An empty string, null and undefined are all
 * "absent" and must NOT become the string "null" or "undefined": a fabricated
 * key would attribute a window to a column that does not exist.
 */
function practitionerIdOf(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") {
    const s = value.trim();
    return s === "" ? null : s;
  }
  return null;
}

export interface ParsedAvailability {
  windows: AvailabilityWindow[];
  /** Rows refused attribution because they carried no practitioner id. */
  untagged: number;
  /** Rows seen, whether or not they parsed. */
  total: number;
}

/**
 * Parse raw availability rows into day-keyed, minute-based windows.
 *
 * Rules, each of which is a decision rather than a detail:
 *  - Only start_time, finish_time and practitioner_id are read. Nothing else on
 *    the row has proven live provenance.
 *  - A row with NO practitioner_id is REFUSED attribution and counted in
 *    `untagged`. Guessing a clinician for an untagged window is the same class of
 *    error as an appointment against the wrong clinician.
 *  - A window spanning more than one London day is SPLIT at the day boundary,
 *    because the grid is one day per column.
 *  - Unparseable and zero-length rows are dropped.
 *  - Nothing is chunked into slots. The diary shades a session; it does not offer
 *    one.
 */
export function parseAvailabilityWindows(rows: unknown): ParsedAvailability {
  const list = Array.isArray(rows) ? rows : [];
  const windows: AvailabilityWindow[] = [];
  let untagged = 0;

  for (const raw of list) {
    const r = asRecord(raw);
    const practitionerId = practitionerIdOf(r.practitioner_id);
    if (practitionerId === null) {
      untagged += 1;
      continue;
    }
    const startMs = Date.parse(typeof r.start_time === "string" ? r.start_time : "");
    const finishMs = Date.parse(typeof r.finish_time === "string" ? r.finish_time : "");
    if (Number.isNaN(startMs) || Number.isNaN(finishMs) || finishMs <= startMs) continue;

    for (const w of splitAcrossLondonDays(practitionerId, startMs, finishMs)) windows.push(w);
  }

  return { windows, untagged, total: list.length };
}

/** One instant range, cut at every London midnight it crosses. */
function splitAcrossLondonDays(
  practitionerId: string,
  startMs: number,
  finishMs: number,
): AvailabilityWindow[] {
  const startDay = londonDayKey(new Date(startMs));
  const finishDay = londonDayKey(new Date(finishMs));
  const finishMin = londonWallMinutes(finishMs);

  // A finish at exactly midnight belongs to the END of the previous day, not to
  // a zero-length window at the start of the next one.
  const lastDay = finishMin === 0 && finishDay !== startDay ? previousDayKey(finishDay) : finishDay;
  const lastEndMin = finishMin === 0 && finishDay !== startDay ? DAY_MINUTES : finishMin;

  if (lastDay === startDay) {
    const startMin = londonWallMinutes(startMs);
    if (lastEndMin <= startMin) return [];
    return [{ practitionerId, dayKey: startDay, startMin, endMin: lastEndMin }];
  }

  const out: AvailabilityWindow[] = [];
  let cursor = startDay;
  for (let i = 0; i < MAX_SPAN_DAYS; i += 1) {
    const startMin = cursor === startDay ? londonWallMinutes(startMs) : 0;
    const endMin = cursor === lastDay ? lastEndMin : DAY_MINUTES;
    if (endMin > startMin) out.push({ practitionerId, dayKey: cursor, startMin, endMin });
    if (cursor >= lastDay) break;
    cursor = nextDayKey(cursor);
  }
  return out;
}

function previousDayKey(dayKey: string): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** The windows belonging to one practitioner on one day. */
export function windowsFor(
  windows: readonly AvailabilityWindow[],
  practitionerId: string | null,
  dayKey: string,
): AvailabilityWindow[] {
  if (practitionerId === null) return [];
  return windows.filter((w) => w.practitionerId === practitionerId && w.dayKey === dayKey);
}

/** The London day keys covered by a start/end day key pair, inclusive and bounded. */
export function dayKeysBetween(fromDayKey: string, toDayKey: string, maxDays = MAX_SPAN_DAYS): string[] {
  if (toDayKey < fromDayKey) return [];
  const keys: string[] = [];
  let cursor = fromDayKey;
  for (let i = 0; i < maxDays; i += 1) {
    keys.push(cursor);
    if (cursor >= toDayKey) break;
    cursor = nextDayKey(cursor);
  }
  return keys;
}
