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
