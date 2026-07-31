// ===========================================================================
// The mock practice's OPENING HOURS and CLINICIAN ROTA.
//
// WHY THIS EXISTS. The diary derives "who is working" from Dentally's own
// availability windows, not from our config. The previous mock made the
// safest-LOOKING wrong answer for the diary's actual query: a single-day
// availability window returned [], so every column would have read "not
// working", nothing would have crashed and no test would have failed while the
// feature was completely untested. It also fabricated availability for any id
// you sent, including ids that do not exist, which makes "this clinician is not
// working" unfalsifiable.
//
// So the mock now models the two real things availability is derived from:
//   SITE_HOURS  when a SITE is open. Genuinely different per site, because the
//               practice confirmed the sites do not share opening hours.
//   ROTA        which SITE a clinician is at on a given weekday, and their own
//               session within it. Clinicians move between sites.
//
// The site is implied ENTIRELY by which practitioner ids you ask for:
// /v1/appointments/availability takes no site parameter, so a rota entry has to
// name the site itself. That is the honest model of the live contract.
//
// NOT CALIBRATED AGAINST LIVE DENTALLY: these hours and rotas are invented
// fixtures. What IS calibrated is the response SHAPE (rows of
// {start_time, finish_time, practitioner_id} carrying a London offset) and one
// window length: site-ng on Tuesday and Thursday runs 13:30 to 20:00, which is
// 390 minutes, the exact live window length that already contradicts our own
// 17:30 config close (see booking-duration.test.ts).
// ===========================================================================

import { londonDayKey } from "@/lib/time/london";

/** Minutes past London midnight. */
export interface MinuteWindow {
  startMin: number;
  endMin: number;
}

/** A clinician's rota entry for one weekday: which site, and their session there. */
export interface RotaEntry extends MinuteWindow {
  siteId: string;
}

const H = (hour: number, minute = 0): number => hour * 60 + minute;

/**
 * When each site is open, by weekday index (0 = Sunday). null = closed.
 *
 * Three genuinely different sets, so "different opening hours per site" is
 * visible on the grid rather than asserted in a comment.
 */
export const SITE_HOURS: Record<string, Record<number, MinuteWindow | null>> = {
  "site-cc": {
    0: null,
    1: { startMin: H(8), endMin: H(20) },
    2: { startMin: H(9), endMin: H(17, 30) },
    3: { startMin: H(9), endMin: H(17, 30) },
    4: { startMin: H(8), endMin: H(20) },
    5: { startMin: H(9), endMin: H(17) },
    6: { startMin: H(9), endMin: H(13) },
  },
  "site-rv": {
    0: null,
    1: { startMin: H(9), endMin: H(17) },
    2: { startMin: H(9), endMin: H(17) },
    3: null,
    4: { startMin: H(9), endMin: H(19) },
    5: { startMin: H(9), endMin: H(16) },
    6: null,
  },
  "site-ng": {
    0: null,
    1: { startMin: H(10), endMin: H(18) },
    // 13:30 to 20:00 is 390 minutes: the live window length.
    2: { startMin: H(13, 30), endMin: H(20) },
    3: { startMin: H(10), endMin: H(18) },
    4: { startMin: H(13, 30), endMin: H(20) },
    5: { startMin: H(10), endMin: H(16) },
    6: { startMin: H(10), endMin: H(14) },
  },
};

export interface RosterMember {
  id: string;
  first: string;
  last: string;
  active: boolean;
}

/**
 * Which practitioners /v1/practitioners returns for each site.
 *
 * prac-1 and prac-2 keep their existing ids and names so the hand-written
 * fixtures still resolve. prac-2 and prac-4 appear in TWO rosters, which is what
 * a clinician moving between sites looks like to /v1/practitioners, an endpoint
 * that is not per-day. One inactive row is kept so callers must filter on `active`.
 */
export const ROSTER: Record<string, RosterMember[]> = {
  "site-cc": [
    { id: "prac-1", first: "Dana", last: "Hale", active: true },
    { id: "prac-2", first: "Femi", last: "Osei", active: true },
    { id: "prac-3", first: "Jin", last: "Kim", active: true },
    { id: "prac-4", first: "Priya", last: "Raman", active: true },
    { id: "prac-9", first: "Old", last: "Locum", active: false },
  ],
  "site-rv": [
    { id: "prac-2", first: "Femi", last: "Osei", active: true },
    { id: "prac-11", first: "Sam", last: "Achebe", active: true },
    { id: "prac-12", first: "Nadia", last: "Farouk", active: true },
  ],
  "site-ng": [
    { id: "prac-4", first: "Priya", last: "Raman", active: true },
    { id: "prac-21", first: "Marcus", last: "Bell", active: true },
    { id: "prac-22", first: "Helen", last: "Okafor", active: true },
  ],
};

/** Every practitioner id the mock knows, whatever site they sit at. */
export const ALL_PRACTITIONER_IDS: string[] = [
  ...new Set(Object.values(ROSTER).flatMap((r) => r.map((p) => p.id))),
];

/** Display name for a practitioner id, or null when the id is unknown. */
export function practitionerName(id: string): string | null {
  for (const roster of Object.values(ROSTER)) {
    const hit = roster.find((p) => p.id === id);
    if (hit) return `${hit.first} ${hit.last}`;
  }
  return null;
}

/**
 * The rota: practitioner id -> weekday index -> where they are and when.
 *
 * Load-bearing fixture facts, each of which a later test or probe depends on:
 *   - prac-3 Jin Kim has NO Thursday entry and generates no Thursday
 *     appointments: the "not working" column.
 *   - prac-22 Helen Okafor is rostered on Thursday but generates no appointments
 *     either: a clinician who is IN with an empty book, which is what produces an
 *     uninterrupted 390 minute availability window.
 *   - prac-4 Priya Raman is at site-cc Mon/Tue/Wed and site-ng Thu/Fri: the rota
 *     case, one clinician across two sites in one week.
 *   - prac-2 Femi Osei is at site-cc Mon/Tue/Thu/Fri and site-rv Wed. site-rv is
 *     CLOSED on Wednesdays, so the intersection is empty and he reads as not
 *     working: a rostered clinician at a shut site, deliberately reachable.
 *   - prac-21 Marcus Bell works but has NO treatment_capability seed rows, so the
 *     "we do not have a record of who can do this" case is reachable.
 */
export const ROTA: Record<string, Record<number, RotaEntry>> = {
  "prac-1": {
    1: { siteId: "site-cc", startMin: H(8), endMin: H(16) },
    2: { siteId: "site-cc", startMin: H(9), endMin: H(17, 30) },
    3: { siteId: "site-cc", startMin: H(9), endMin: H(17, 30) },
    4: { siteId: "site-cc", startMin: H(12), endMin: H(20) },
    5: { siteId: "site-cc", startMin: H(9), endMin: H(17) },
    6: { siteId: "site-cc", startMin: H(9), endMin: H(13) },
  },
  "prac-2": {
    1: { siteId: "site-cc", startMin: H(9), endMin: H(17) },
    2: { siteId: "site-cc", startMin: H(9), endMin: H(17, 30) },
    // site-rv is closed on Wednesdays: this intersects to nothing on purpose.
    3: { siteId: "site-rv", startMin: H(9), endMin: H(17) },
    4: { siteId: "site-cc", startMin: H(8), endMin: H(16) },
    5: { siteId: "site-cc", startMin: H(9), endMin: H(17) },
  },
  "prac-3": {
    1: { siteId: "site-cc", startMin: H(9), endMin: H(17) },
    2: { siteId: "site-cc", startMin: H(9), endMin: H(17, 30) },
    3: { siteId: "site-cc", startMin: H(9), endMin: H(17, 30) },
    // No Thursday entry at all.
    5: { siteId: "site-cc", startMin: H(9), endMin: H(17) },
    6: { siteId: "site-cc", startMin: H(9), endMin: H(13) },
  },
  "prac-4": {
    1: { siteId: "site-cc", startMin: H(9), endMin: H(17) },
    2: { siteId: "site-cc", startMin: H(9), endMin: H(17, 30) },
    3: { siteId: "site-cc", startMin: H(9), endMin: H(17, 30) },
    4: { siteId: "site-ng", startMin: H(13, 30), endMin: H(20) },
    5: { siteId: "site-ng", startMin: H(10), endMin: H(16) },
  },
  "prac-11": {
    1: { siteId: "site-rv", startMin: H(9), endMin: H(17) },
    2: { siteId: "site-rv", startMin: H(9), endMin: H(17) },
    4: { siteId: "site-rv", startMin: H(9), endMin: H(19) },
    5: { siteId: "site-rv", startMin: H(9), endMin: H(16) },
  },
  "prac-12": {
    1: { siteId: "site-rv", startMin: H(9), endMin: H(13) },
    4: { siteId: "site-rv", startMin: H(11), endMin: H(19) },
    5: { siteId: "site-rv", startMin: H(9), endMin: H(16) },
  },
  "prac-21": {
    1: { siteId: "site-ng", startMin: H(10), endMin: H(18) },
    2: { siteId: "site-ng", startMin: H(13, 30), endMin: H(20) },
    3: { siteId: "site-ng", startMin: H(10), endMin: H(18) },
    4: { siteId: "site-ng", startMin: H(13, 30), endMin: H(20) },
    5: { siteId: "site-ng", startMin: H(10), endMin: H(16) },
    6: { siteId: "site-ng", startMin: H(10), endMin: H(14) },
  },
  "prac-22": {
    2: { siteId: "site-ng", startMin: H(13, 30), endMin: H(20) },
    4: { siteId: "site-ng", startMin: H(13, 30), endMin: H(20) },
    5: { siteId: "site-ng", startMin: H(10), endMin: H(16) },
  },
};

/**
 * The clinician-days deliberately left with an EMPTY BOOK, so the diary's
 * "rostered but nothing booked" case and the uninterrupted 390 minute window are
 * both reachable without depending on where the seeded PRNG happens to land.
 */
const EMPTY_BOOK: Record<string, number[]> = {
  // Not rostered on Thursday either; belt and braces, since a booking would
  // otherwise force white time onto a column that must read "Not working".
  "prac-3": [4],
  "prac-22": [4],
};

/** 0 = Sunday. Safe on a bare day key: UTC midnight is the same London date. */
export function weekdayOf(dayKey: string): number {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

/** Where this practitioner is on this day, or null when they are not working. */
export function rotaEntry(practitionerId: string, dayKey: string): RotaEntry | null {
  return ROTA[practitionerId]?.[weekdayOf(dayKey)] ?? null;
}

/** A site's opening window on this day, or null when it is closed. */
export function siteHours(siteId: string, dayKey: string): MinuteWindow | null {
  return SITE_HOURS[siteId]?.[weekdayOf(dayKey)] ?? null;
}

/** True when this clinician-day is deliberately left with no generated bookings. */
export function hasEmptyBook(practitionerId: string, dayKey: string): boolean {
  return (EMPTY_BOOK[practitionerId] ?? []).includes(weekdayOf(dayKey));
}

/**
 * The clinician's actual session at a site on a day: their rota entry intersected
 * with the site's opening hours. Null when they are not rostered, the site is
 * shut, or the two do not overlap.
 */
export function sessionFor(practitionerId: string, dayKey: string): RotaEntry | null {
  const entry = rotaEntry(practitionerId, dayKey);
  if (!entry) return null;
  const hours = siteHours(entry.siteId, dayKey);
  if (!hours) return null;
  const startMin = Math.max(entry.startMin, hours.startMin);
  const endMin = Math.min(entry.endMin, hours.endMin);
  if (endMin <= startMin) return null;
  return { siteId: entry.siteId, startMin, endMin };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function londonHourMinute(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * The UTC instant (ms) whose Europe/London wall clock is `dayKey` at hh:mm.
 *
 * London is UTC+0 or UTC+1, so trying both offsets and keeping the one whose
 * London wall clock matches is exact all year, DST changeover included. NEVER
 * concatenate "T09:00:00Z": that sits an hour out through British Summer Time.
 */
export function londonInstantMs(dayKey: string, hour: number, minute: number): number {
  const wanted = `${pad2(hour)}:${pad2(minute)}`;
  const naive = Date.parse(`${dayKey}T${wanted}:00Z`);
  for (const offsetMinutes of [0, 60]) {
    const ms = naive - offsetMinutes * 60_000;
    const d = new Date(ms);
    if (londonDayKey(d) === dayKey && londonHourMinute(d) === wanted) return ms;
  }
  return naive;
}

/** Minutes past London midnight, from minutes-past-midnight, as an instant. */
export function londonMinuteInstantMs(dayKey: string, minutes: number): number {
  return londonInstantMs(dayKey, Math.floor(minutes / 60), minutes % 60);
}

/** The Europe/London UTC offset in minutes for an instant (0 in GMT, 60 in BST). */
export function londonOffsetMinutes(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const hour = get("hour") % 24; // en-CA can render midnight as 24
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * An instant rendered the way LIVE Dentally renders one: London wall clock with
 * an explicit "+01:00" / "+00:00" offset, NOT a Z-suffixed UTC instant.
 *
 * This matters more than it looks. The old mock emitted Z, so any caller that
 * string-sliced a time out of the response passed locally and was an hour wrong
 * against live Dentally through British Summer Time. Emitting the live form here
 * is what makes that class of bug fail in dev instead of in the practice.
 */
export function londonOffsetIso(ms: number): string {
  const offset = londonOffsetMinutes(ms);
  const shifted = new Date(ms + offset * 60_000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}` +
    `T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** The London day keys covered by an instant range, inclusive, bounded. */
export function londonDayKeysBetween(startMs: number, finishMs: number, maxDays = 90): string[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) return [];
  const last = londonDayKey(new Date(finishMs));
  const keys: string[] = [];
  let cursor = londonDayKey(new Date(startMs));
  for (let i = 0; i < maxDays; i += 1) {
    keys.push(cursor);
    if (cursor >= last) break;
    cursor = new Date(Date.parse(`${cursor}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return keys;
}
