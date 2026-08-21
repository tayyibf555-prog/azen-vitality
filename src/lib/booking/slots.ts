import {
  AVAILABILITY_MIN_SPAN_MS,
  AVAILABILITY_START_BUFFER_MS,
} from "@/lib/calendar/availability";
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

/**
 * Round an instant UP onto the absolute booking grid (multiples of `stepMin`
 * minutes since the epoch, i.e. :00 and :30 on the London wall clock, because
 * every UK offset is a whole number of hours).
 *
 * THE BUG THIS EXISTS TO STOP. Availability for TODAY is queried from "now",
 * because Dentally will not answer for a start_time in the past. Both the local
 * mock and (on the evidence of its own contract) live Dentally CLIP the window
 * they return to that requested start, and the reader then chunks the window
 * from wherever it begins. With a raw `now` that chunk boundary moved every
 * second, so:
 *
 *   - the calendar offered same-day times like 13:02 and 13:32, which is not a
 *     time any practice books at, and
 *   - the slot a patient tapped had ceased to exist by the time they pressed
 *     Book: revalidation re-read availability a few seconds later, the whole grid
 *     had shifted, findExactSlot missed, and the create route answered "that time
 *     has just been taken" for a slot nobody had taken. Every same-day booking in
 *     the first open window was unbookable, permanently.
 *
 * Anchoring to an ABSOLUTE grid (rather than to the query, or to `now` rounded)
 * makes the answer identical for every caller at every instant within the slot,
 * which is what revalidation needs to be able to agree with the offer.
 */
export function ceilToSlotGrid(ms: number, stepMin: number = BOOKING_SLOT_DURATION_MIN): number {
  const step = Math.max(1, Math.round(stepMin)) * MINUTE_MS;
  if (!Number.isFinite(ms)) return ms;
  return Math.ceil(ms / step) * step;
}

/** `YYYY-MM-DD` shifted by whole days. Pure calendar arithmetic on the key
 *  itself (no timezone involved); an unparseable key is returned unchanged. */
function shiftDayKey(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(ms)) return ymd;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

// ===========================================================================
// THE WINDOW DENTALLY WILL ACTUALLY ANSWER (the patient-facing half).
//
// GET /v1/appointments/availability VALIDATES the window before it looks at
// anything, and refuses two shapes outright (400, "The appointment could not be
// processed"):
//
//   start_time  "must be in the future"            -- a start at or before now
//   finish_time "must be greater than 24 hours"    -- a span of 24h or less
//
// MEASURED against live Dentally on 2026-08-21 with a read-only key:
//   today 00:00 -> today 23:59   400, BOTH errors
//   now+1min    -> now+23h       400, finish_time error
//   now+1min    -> now+25h       200
//
// The diary hit this first (src/lib/calendar/availability.ts) and it was here
// too. `?from=X&to=X` on /api/booking/slots -- what the picker sends the moment a
// patient asks about ONE day -- spans at most 24 hours, so it 400d, the route's
// catch turned that into "we could not load available times", and a patient was
// told nothing was free on a day the practice was fully open. The 14-day default
// range never spans under 24 hours, which is why every manual click-through
// looked fine.
//
// So the booking path asks for a window Dentally accepts and then trims the
// answer back to the days it was actually asked about (bookingDaysWithin).
// Nothing about the requested days is inferred or extrapolated.
//
// THE TWO RULES ARE IMPORTED, NOT COPIED. AVAILABILITY_START_BUFFER_MS and
// AVAILABILITY_MIN_SPAN_MS live on the diary's module because they describe ONE
// API contract; forking them is how a future calibration fixes one caller and
// leaves the other 400ing.
//
// WHY NOT diaryAvailabilityRequest ITSELF. That helper clamps the start to
// now + buffer. Booking cannot: its start must land on the ABSOLUTE 30-minute
// grid (see ceilToSlotGrid) or the same-day grid moves under the patient between
// the offer and the write, which is a bug this file has already had once. So the
// clamp is grid-aligned here, and the trim happens one seam later -- on grouped
// London DAYS rather than on raw rows, because by then every window has already
// been chunked into slots.
// ===========================================================================

/** A `YYYY-MM-DD` London day key, as every caller of the reader passes. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface BookingAvailabilityWindow {
  /** ISO start: on the booking grid, and always strictly after now. */
  startTime: string;
  /** ISO finish: always more than 24 hours after `startTime`. */
  finishTime: string;
}

/**
 * The availability window to SEND for a requested London day range, or null when
 * the whole range has already ended and there is nothing worth asking.
 *
 * `nowMs` is a parameter rather than a clock read, so this is pure and testable.
 */
export function bookingAvailabilityWindow(
  fromDate: string,
  toDate: string,
  nowMs: number,
): BookingAvailabilityWindow | null {
  // The earliest start Dentally will accept, snapped UP onto the booking grid.
  //
  // The buffer absorbs clock skew between our machine and theirs, and the one
  // instant per slot where `now` sits exactly ON the grid -- ceilToSlotGrid
  // rightly leaves that alone, and Dentally would refuse it as not being in the
  // future. Rounding AFTER adding the buffer keeps the grid property that
  // ceilToSlotGrid exists for; adding it after rounding would not.
  const earliestMs = ceilToSlotGrid(nowMs + AVAILABILITY_START_BUFFER_MS);

  const fromMs = londonDayStartMs(fromDate);
  const toMs = londonDayStartMs(shiftDayKey(toDate, 1)) - 1; // last instant of the London day
  // An unreadable `to` falls back to the booking horizon rather than refusing to
  // read at all, exactly as it did before this window existed.
  const requestedEndMs = Number.isNaN(toMs) ? nowMs + BOOKING_HORIZON_DAYS * DAY_MS : toMs;

  // The whole range is over. Dentally can never answer for it, so nothing is
  // asked: the alternative is a guaranteed 400 against the practice's shared
  // 3,600/hour budget whose only product is an outage message about a past day.
  if (requestedEndMs <= earliestMs) return null;

  const startMs = Math.max(Number.isNaN(fromMs) ? earliestMs : fromMs, earliestMs);
  const finishMs = Math.max(requestedEndMs, startMs + AVAILABILITY_MIN_SPAN_MS);
  return {
    startTime: new Date(startMs).toISOString(),
    finishTime: new Date(finishMs).toISOString(),
  };
}

/**
 * Trim grouped days back to the London day range the caller actually asked for.
 *
 * The window SENT is wider than those days -- it has to be, or Dentally refuses
 * it -- so without this a patient who tapped Tuesday would be shown Wednesday's
 * times as well, and the create route would revalidate against days nobody asked
 * about.
 *
 * A range that cannot be read (an unparseable key, or a reversed pair) is NOT
 * trimmed. A caller passing a bad range seeing too many days is a caller bug;
 * a patient shown an empty calendar is an outage.
 */
export function bookingDaysWithin(days: BookingDay[], fromDate: string, toDate: string): BookingDay[] {
  if (!DAY_KEY.test(fromDate) || !DAY_KEY.test(toDate) || toDate < fromDate) return days;
  return days.filter((d) => d.date >= fromDate && d.date <= toDate);
}

/**
 * Fetch live availability for one of OUR internal sites over a date range and
 * return it as future-only London days. Maps the internal site id to the real
 * Dentally site UUID; always queries at the public booking duration (30 min).
 * The range spans whole EUROPE/LONDON days, so the practice's own day is what
 * gets queried whether or not the clocks are on BST.
 *
 * The window actually SENT is decided by bookingAvailabilityWindow -- wider than
 * the days asked for, because Dentally refuses anything narrower -- and the
 * answer is trimmed back by bookingDaysWithin, so a caller only ever sees the
 * days it asked about.
 *
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
  // 1. The window is settled BEFORE a single request is issued, so a range that
  //    has entirely ended costs nothing and is answered here: no slots, no error.
  const queryWindow = bookingAvailabilityWindow(fromDate, toDate, now.getTime());
  if (queryWindow === null) return [];

  const siteUuid = dentallySiteId(internalSiteId);
  // 2. The site's active practitioners: availability is queried per practitioner.
  const pr = await dentally.listPractitioners(siteUuid);
  const practitionerIds = parsePractitionerIds(Array.isArray(pr.practitioners) ? pr.practitioners : [], siteUuid);
  if (practitionerIds.length === 0) return [];

  // 3. One availability call covering every practitioner, then back down to the
  //    days the caller asked for.
  const res = await dentally.getAvailability({
    practitionerIds,
    startTime: queryWindow.startTime,
    finishTime: queryWindow.finishTime,
    duration: BOOKING_SLOT_DURATION_MIN,
  });
  const rows = Array.isArray(res.availability) ? res.availability : [];
  return bookingDaysWithin(groupSlotsIntoLondonDays(parseAvailabilityRows(rows), now), fromDate, toDate);
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
