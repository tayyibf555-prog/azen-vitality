import { dentallySiteId } from "@/lib/mock/clients";
import { londonDayKey } from "@/lib/time/london";

// ---------------------------------------------------------------------------
// Public online-booking: availability slot parsing and day grouping.
//
// The raw rows come from Dentally's GET /v1/appointments/availability. The REAL
// live shape (validated by scripts/dentally-find-slot.mjs against live Dentally)
// is `{ start_time, finish_time, ... }` per row; the local mock
// (src/app/api/mock-dentally/.../availability/route.ts) mirrors it and adds
// `practitioner_id`. Parsing is deliberately defensive: a malformed row is
// dropped, never thrown on, because this feeds a PUBLIC page.
//
// IMPORTANT: a row is an availability WINDOW, not a bookable slot. Even when we
// ask for `duration: 30`, Dentally answers with the free windows themselves, so
// a row can be several hours long (measured against live data: 85 of 102 rows
// were longer than 30 minutes, the longest a single 390 minute window). Every
// window is therefore chunked here into consecutive BOOKING_SLOT_DURATION_MIN
// slots before anything else sees it, which is what stops a patient booking a
// multi hour appointment into a clinician's diary and what lets the calendar
// offer a time every 30 minutes instead of one per window.
//
// Pure functions except fetchAvailabilityDays (which takes the client as an
// argument so it stays unit-testable without module mocks).
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Duration (minutes) every public booking slot is quoted and booked at. */
export const BOOKING_SLOT_DURATION_MIN = 30;

/** Public bookings may be made at most this far ahead. */
export const BOOKING_HORIZON_DAYS = 60;

/** Hard bound on the slots one window may yield (a 24 hour window at 30 min), so
 *  an upstream row with a nonsense finish time can never spin out a huge list. */
const MAX_SLOTS_PER_WINDOW = 48;

export interface BookingSlot {
  /** Slot start, ISO. */
  start: string;
  /** Slot finish, ISO: always start + BOOKING_SLOT_DURATION_MIN. */
  finish: string;
  /** Dentally practitioner id for the slot, or null when the row carried none. */
  practitionerId: string | null;
}

export interface BookingDay {
  /** Europe/London calendar day, YYYY-MM-DD. */
  date: string;
  /** Slots on that London day, sorted by start time. */
  slots: BookingSlot[];
}

/** Minimal structural view of DentallyClient so tests can pass a plain stub.
 *  Live Dentally availability is PER PRACTITIONER (start_time/finish_time ISO
 *  datetimes + practitioner_ids[]), so the reader also lists the site's
 *  practitioners; calibrated against the live API 2026-07-11. */
export interface AvailabilityReader {
  listPractitioners(siteId: string): Promise<{ practitioners: unknown[] }>;
  getAvailability(a: {
    practitionerIds: Array<string | number>;
    startTime: string;
    finishTime: string;
    duration?: number;
  }): Promise<{ availability: unknown[] }>;
}

/** Active practitioner ids for a Dentally site UUID (live row shape:
 *  {id, active, site_id, ...}). Defensive: malformed rows are dropped. */
export function parsePractitionerIds(rows: unknown[], dentallySiteUuid: string): string[] {
  const ids: string[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.active !== true) continue;
    if (typeof r.site_id === "string" && r.site_id !== dentallySiteUuid) continue;
    const id = r.id;
    if (typeof id === "string" || typeof id === "number") ids.push(String(id));
  }
  return ids;
}

/**
 * Chunk ONE availability window into consecutive bookable slots of exactly
 * `durationMin` minutes, keeping the window's practitioner. A remainder shorter
 * than one slot is discarded (a 45 minute window yields a single 30 minute slot
 * and the 15 minute tail is dropped, because we cannot book a 15 minute
 * appointment at the public duration).
 *
 * Works on instants, so a window spanning a BST change chunks correctly.
 * Unparseable ends yield nothing rather than throwing: this feeds a PUBLIC page.
 */
export function chunkWindowIntoSlots(
  availabilityWindow: BookingSlot,
  durationMin: number = BOOKING_SLOT_DURATION_MIN,
): BookingSlot[] {
  const startMs = Date.parse(availabilityWindow.start);
  const finishMs = Date.parse(availabilityWindow.finish);
  const stepMs = durationMin * MINUTE_MS;
  if (Number.isNaN(startMs) || Number.isNaN(finishMs) || stepMs <= 0) return [];
  const out: BookingSlot[] = [];
  for (let t = startMs; t + stepMs <= finishMs && out.length < MAX_SLOTS_PER_WINDOW; t += stepMs) {
    out.push({
      start: new Date(t).toISOString(),
      finish: new Date(t + stepMs).toISOString(),
      practitionerId: availabilityWindow.practitionerId,
    });
  }
  return out;
}

/**
 * Parse raw availability rows using the live field names (start_time /
 * finish_time / practitioner_id) and chunk each row into bookable slots of the
 * public booking duration. Rows without a parseable start and finish are
 * dropped, as is any row shorter than one slot. Practitioner ids arrive as
 * numbers from real Dentally and strings from the mock; both normalise to
 * string. Some availability shapes carry `available_practitioner_ids` instead of
 * a single id; the first entry is used then, so the slot stays bookable (a
 * booking needs a practitioner).
 *
 * Chunking lives HERE, at the single seam every caller goes through, so neither
 * the calendar nor the create route can ever see a raw window.
 */
export function parseAvailabilityRows(rows: unknown): BookingSlot[] {
  if (!Array.isArray(rows)) return [];
  const out: BookingSlot[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const start = typeof row.start_time === "string" ? row.start_time : "";
    const finish = typeof row.finish_time === "string" ? row.finish_time : "";
    if (!start || !finish) continue;
    if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(finish))) continue;
    let practitionerId: string | null = null;
    const pid = row.practitioner_id;
    if ((typeof pid === "string" && pid !== "") || typeof pid === "number") {
      practitionerId = String(pid);
    } else if (Array.isArray(row.available_practitioner_ids) && row.available_practitioner_ids.length > 0) {
      const first = row.available_practitioner_ids[0];
      if ((typeof first === "string" && first !== "") || typeof first === "number") {
        practitionerId = String(first);
      }
    }
    out.push(...chunkWindowIntoSlots({ start, finish, practitionerId }));
  }
  return out;
}

/**
 * Group slots into Europe/London calendar days, keeping only slots strictly in
 * the future and within the booking horizon. Days and slots are sorted.
 */
export function groupSlotsIntoLondonDays(
  slots: BookingSlot[],
  now: Date,
  horizonDays: number = BOOKING_HORIZON_DAYS,
): BookingDay[] {
  const nowMs = now.getTime();
  const horizonMs = nowMs + horizonDays * DAY_MS;
  const byDay = new Map<string, BookingSlot[]>();
  for (const slot of slots) {
    const startMs = Date.parse(slot.start);
    if (!(startMs > nowMs) || startMs > horizonMs) continue;
    const key = londonDayKey(new Date(startMs));
    const bucket = byDay.get(key);
    if (bucket) bucket.push(slot);
    else byDay.set(key, [slot]);
  }
  return [...byDay.entries()]
    .map(([date, daySlots]) => ({
      date,
      slots: [...daySlots].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** London wall-clock hour (0 to 23) for an instant. */
function londonHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(d),
  );
}

/**
 * The UTC instant of Europe/London midnight starting a `YYYY-MM-DD` day.
 * DST-correct: it tries both UK offsets and keeps the candidate that really
 * renders as 00:00 on that London date. Mirrors reactivation's
 * settings.londonDayStartIso (which does the same for "today"), so every day
 * boundary in the app agrees through BST. NaN for an unparseable day key.
 *
 * Without this the range was built from UTC midnight, which in BST is 01:00
 * London: the first hour of the day fell outside the query, so an early or late
 * slot could be missing from the calendar and, worse, fail revalidation on the
 * create route even though Dentally was still offering it.
 */
function londonDayStartMs(ymd: string): number {
  for (const offset of ["+01:00", "+00:00"]) {
    const candidate = new Date(`${ymd}T00:00:00${offset}`);
    if (Number.isNaN(candidate.getTime())) return Number.NaN;
    if (londonDayKey(candidate) === ymd && londonHour(candidate) === 0) return candidate.getTime();
  }
  // Unreachable for the UK, but never throw over a date computation.
  return Date.parse(`${ymd}T00:00:00Z`);
}

/** `YYYY-MM-DD` shifted by whole days. Pure calendar arithmetic on the key
 *  itself (no timezone involved); an unparseable key is returned unchanged. */
function shiftDayKey(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(ms)) return ymd;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Fetch live availability for one of OUR internal sites over a date range and
 * return it as future-only London days. Maps the internal site id to the real
 * Dentally site UUID; always queries at the public booking duration (30 min).
 * The range spans whole EUROPE/LONDON days, so the practice's own day is what
 * gets queried whether or not the clocks are on BST.
 * No caching here: the create route relies on this being a LIVE read for slot
 * revalidation (the GET route layers its own short cache on top).
 */
export async function fetchAvailabilityDays(
  dentally: AvailabilityReader,
  internalSiteId: string,
  fromDate: string,
  toDate: string,
  now: Date = new Date(),
): Promise<BookingDay[]> {
  const siteUuid = dentallySiteId(internalSiteId);
  // 1. The site's active practitioners: availability is queried per practitioner.
  const pr = await dentally.listPractitioners(siteUuid);
  const practitionerIds = parsePractitionerIds(Array.isArray(pr.practitioners) ? pr.practitioners : [], siteUuid);
  if (practitionerIds.length === 0) return [];

  // 2. One availability call covering every practitioner. start_time must be a
  //    real datetime and must not sit in the past, so clamp to now. Both ends
  //    are London day boundaries (see londonDayStartMs).
  const fromMs = londonDayStartMs(fromDate);
  const startIso = new Date(Math.max(Number.isNaN(fromMs) ? now.getTime() : fromMs, now.getTime())).toISOString();
  const toMs = londonDayStartMs(shiftDayKey(toDate, 1)) - 1; // last instant of the London day
  const finishIso = new Date(
    Number.isNaN(toMs) ? now.getTime() + BOOKING_HORIZON_DAYS * DAY_MS : toMs,
  ).toISOString();
  const res = await dentally.getAvailability({
    practitionerIds,
    startTime: startIso,
    finishTime: finishIso,
    duration: BOOKING_SLOT_DURATION_MIN,
  });
  const rows = Array.isArray(res.availability) ? res.availability : [];
  return groupSlotsIntoLondonDays(parseAvailabilityRows(rows), now);
}

/**
 * The earliest N bookable slots across already-grouped days, soonest first. This
 * is what powers the "next available" quick-pick chips: Dentally deliberately
 * surfaces the soonest times, so a patient can book the first free slot in one
 * tap instead of hunting the calendar.
 *
 * `days` is expected to already be day-sorted with each day's slots start-sorted
 * (as groupSlotsIntoLondonDays returns), but this re-sorts defensively so a
 * caller passing merged/unsorted ranges still gets a correct earliest-first list.
 * Pure: no clock read, no I/O.
 */
export function earliestSlots(days: BookingDay[], limit: number): Array<BookingSlot & { date: string }> {
  const flat: Array<BookingSlot & { date: string }> = [];
  for (const day of days) {
    for (const slot of day.slots) flat.push({ ...slot, date: day.date });
  }
  flat.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return limit > 0 ? flat.slice(0, limit) : [];
}

/**
 * Find the live slot exactly matching a patient's selection: same start and
 * finish instants, and the same practitioner when the caller pinned one. The
 * MATCHED slot (with its own practitionerId/finish) is what gets booked; the
 * client's copy is only a selection identity, never trusted for the write.
 */
export function findExactSlot(
  days: BookingDay[],
  slotStart: string,
  finish: string,
  practitionerId?: string | null,
): BookingSlot | null {
  const startMs = Date.parse(slotStart);
  const finishMs = Date.parse(finish);
  if (Number.isNaN(startMs) || Number.isNaN(finishMs)) return null;
  for (const day of days) {
    for (const slot of day.slots) {
      if (Date.parse(slot.start) !== startMs) continue;
      if (Date.parse(slot.finish) !== finishMs) continue;
      if (practitionerId && slot.practitionerId !== practitionerId) continue;
      return slot;
    }
  }
  return null;
}
