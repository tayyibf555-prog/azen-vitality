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
// Pure functions except fetchAvailabilityDays (which takes the client as an
// argument so it stays unit-testable without module mocks).
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Duration (minutes) every public booking slot is quoted and booked at. */
export const BOOKING_SLOT_DURATION_MIN = 30;

/** Public bookings may be made at most this far ahead. */
export const BOOKING_HORIZON_DAYS = 60;

export interface BookingSlot {
  /** Slot start, ISO, exactly as Dentally returned it. */
  start: string;
  /** Slot finish, ISO, exactly as Dentally returned it. */
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
 * Parse raw availability rows into BookingSlots using the live field names
 * (start_time / finish_time / practitioner_id). Rows without a parseable start
 * and finish are dropped. Practitioner ids arrive as numbers from real Dentally
 * and strings from the mock; both normalise to string. Some availability shapes
 * carry `available_practitioner_ids` instead of a single id; the first entry is
 * used then, so the slot stays bookable (a booking needs a practitioner).
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
    out.push({ start, finish, practitionerId });
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

/**
 * Fetch live availability for one of OUR internal sites over a date range and
 * return it as future-only London days. Maps the internal site id to the real
 * Dentally site UUID; always queries at the public booking duration (30 min).
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
  //    real datetime and must not sit in the past, so clamp to now.
  const fromMs = Date.parse(`${fromDate}T00:00:00.000Z`);
  const startIso = new Date(Math.max(Number.isNaN(fromMs) ? now.getTime() : fromMs, now.getTime())).toISOString();
  const finishIso = new Date(`${toDate}T23:59:59.999Z`).toISOString();
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
