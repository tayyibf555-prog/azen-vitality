// ===========================================================================
// Mock Dentally fixtures for the practice-manager dashboard's NON-money panels:
// the appointment book (the donut and the appointment list), dated invoices
// (the INVOICED panel and the ACCOUNTS ranking) and patient registration dates
// (the "new patients" count).
//
// The money side already lives in _finance-fixtures.ts (payments and NHS
// claims). This file follows exactly the same rules:
//
//   - Every value comes from a seeded PRNG keyed on the site and the day, so the
//     same calendar day always produces the same rows and two loads of the
//     dashboard never disagree.
//   - The 90 day span is anchored to the CURRENT London day, so the strip and
//     the donut are meaningful whenever this is run, and the built set is cached
//     per London day.
//   - Field shapes copy the live API, not our internal types.
//
// WHY THIS EXISTS AT ALL: the hand-written fixtures in _fixtures.ts are pinned
// to fixed dates in June 2026. They were written to drive the recall, no-show
// and reactivation demos, and they answer "has this patient been seen" rather
// than "what did the practice do last Tuesday". A dashboard whose whole subject
// is a rolling 90 day window needs a rolling 90 day book, so this generates one
// alongside them rather than editing them.
//
// UNVERIFIED FIELDS, flagged so nobody later mistakes them for calibration:
//   - `notes` on an appointment. The practice manager's Dentally shows a free
//     text note under the reason ("aligners received, given to maria"), so the
//     row is built to carry one, but the live field NAME is not confirmed. The
//     dashboard reads it defensively and renders nothing when it is absent.
//   - `practitioner_id` on an appointment IS the live shape (the availability
//     flow already sends practitioner ids), but the hand-written fixtures only
//     carried a display name, so it is added here.
// ===========================================================================

import {
  MOCK_PATIENTS,
  type MockAppointment,
  type MockInvoice,
} from "@/app/api/mock-dentally/_fixtures";
import { MOCK_SITE_IDS } from "@/app/api/mock-dentally/_finance-fixtures";
import { londonDayKey } from "@/lib/time/london";

const DAY_MS = 86_400_000;

/** Matches the practitioners /v1/practitioners returns for every site. */
const PRACTITIONERS = [
  { id: "prac-1", name: "Dana Hale" },
  { id: "prac-2", name: "Femi Osei" },
] as const;

// --- Deterministic pseudo-randomness (same generator as _finance-fixtures) ---

function hash32(input: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

function seeded(seed: string): () => number {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length) % items.length];
}

// --- Day and wall-clock helpers ---------------------------------------------

function todayKey(): string {
  return londonDayKey(new Date());
}

function shift(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday. Safe on a bare day key: UTC midnight is the same London date. */
function weekday(dayKey: string): number {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
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
 * The UTC instant whose Europe/London wall clock is `day` at `hour:minute`.
 *
 * Appointments are stored as instants and read back through the London calendar,
 * so a fixture that naively wrote `${day}T09:00:00Z` would sit at 10:00 in
 * British Summer Time and, for an early slot near midnight, on the wrong day.
 * London is UTC+0 or UTC+1, so trying both offsets and keeping the one whose
 * London wall clock matches is exact all year, DST changeover included.
 */
function londonInstant(day: string, hour: number, minute: number): string {
  const wanted = `${pad2(hour)}:${pad2(minute)}`;
  const naive = Date.parse(`${day}T${wanted}:00Z`);
  for (const offsetMinutes of [0, 60]) {
    const d = new Date(naive - offsetMinutes * 60_000);
    if (londonDayKey(d) === day && londonHourMinute(d) === wanted) return d.toISOString();
  }
  return new Date(naive).toISOString();
}

// --- The appointment book ---------------------------------------------------

/**
 * Appointment reasons, as a practice actually books them. The dashboard colours
 * a bar per reason, so the set is deliberately small and stable: a practice's
 * appointment types are a short configured list, not free text.
 */
const REASONS = [
  "Examination",
  "Hygiene",
  "Continuing Treatment",
  "New patient exam",
  "Emergency",
  "Implant consult",
  "Invisalign review",
  "Extraction",
] as const;

/** Free text a receptionist types onto the booking. Sparse, as in real life. */
const NOTES = [
  "aligners received, given to maria",
  "needs pre med, check with dentist",
  "wants to discuss finance options",
  "phoned ahead, running ten minutes late",
  "interpreter booked",
  "x-rays due at this visit",
  "nervous patient, allow extra time",
  "balance to settle at the desk",
] as const;

/** Typical booked slots per site per weekday. Busiest site first, as with takings. */
const DAILY_SLOTS: Record<string, number> = {
  "site-cc": 11,
  "site-rv": 9,
  "site-ng": 7,
};

function patientsForSiteId(siteId: string): { id: string; name: string }[] {
  const scoped = MOCK_PATIENTS.filter((p) => p.site_id === siteId);
  const rows = scoped.length > 0 ? scoped : MOCK_PATIENTS;
  return rows.map((p) => ({ id: p.id, name: `${p.first_name} ${p.last_name}` }));
}

/**
 * The state of a booking, which depends on where the day sits relative to today.
 *
 * A past day is settled: mostly completed, with the cancellations and missed
 * appointments a real book carries. Today is half done: slots before now are
 * completed, slots after it are still to happen, which is exactly what the
 * "appointments remaining to be completed" filter is for.
 */
function stateFor(rand: () => number, daysBack: number, slotHour: number, nowHourLondon: number): string {
  if (daysBack > 0) {
    const roll = rand();
    if (roll < 0.78) return "Completed";
    if (roll < 0.89) return "Cancelled";
    if (roll < 0.96) return "Did not attend";
    // A small tail the practice never closed off. Real books have these, and the
    // dashboard must not silently file them under a donut slice.
    return "booked";
  }
  if (slotHour < nowHourLondon) {
    const roll = rand();
    if (roll < 0.86) return "Completed";
    if (roll < 0.94) return "Cancelled";
    return "Did not attend";
  }
  return rand() < 0.6 ? "Confirmed" : "booked";
}

function appointmentsForSiteDay(
  siteId: string,
  day: string,
  daysBack: number,
  nowHourLondon: number,
): MockAppointment[] {
  const dow = weekday(day);
  if (dow === 0) return []; // Closed on Sundays.
  const rand = seeded(`diary|${siteId}|${day}`);
  const base = DAILY_SLOTS[siteId] ?? 8;
  const target = dow === 6 ? Math.max(2, Math.round(base * 0.4)) : base + Math.floor(rand() * 5) - 2;
  const patients = patientsForSiteId(siteId);

  const rows: MockAppointment[] = [];
  // Slots run 09:00 to 17:30 on a fifteen minute grid, walking forward so two
  // appointments at one site never overlap.
  let minutesFromNine = 0;
  for (let i = 0; i < Math.max(0, target); i += 1) {
    if (minutesFromNine >= 8.5 * 60) break;
    const hour = 9 + Math.floor(minutesFromNine / 60);
    const minute = minutesFromNine % 60;
    const duration = pick(rand, [15, 30, 30, 30, 45, 60]);
    const patient = pick(rand, patients);
    const practitioner = pick(rand, PRACTITIONERS);
    rows.push({
      id: `appt-gen-${siteId}-${day}-${i}`,
      patient_id: patient.id,
      patient_name: patient.name,
      site_id: siteId,
      start_time: londonInstant(day, hour, minute),
      duration,
      state: stateFor(rand, daysBack, hour, nowHourLondon),
      reason: pick(rand, REASONS),
      practitioner: practitioner.name,
      practitioner_id: practitioner.id,
      // Roughly a third of bookings carry a note, as in the real diary.
      notes: rand() < 0.34 ? pick(rand, NOTES) : undefined,
    });
    // Leave a gap sometimes, so the day is not a solid unbroken block.
    minutesFromNine += duration + (rand() < 0.25 ? 15 : 0);
  }
  return rows;
}

/** How far back the generated book runs. Matches the longest strip period. */
const DIARY_HISTORY_DAYS = 90;

function buildAppointments(today: string): MockAppointment[] {
  const nowHourLondon = Number(londonHourMinute(new Date()).slice(0, 2));
  const rows: MockAppointment[] = [];
  for (let back = 0; back < DIARY_HISTORY_DAYS; back += 1) {
    const day = shift(today, -back);
    for (const siteId of MOCK_SITE_IDS) {
      rows.push(...appointmentsForSiteDay(siteId, day, back, nowHourLondon));
    }
  }
  return rows;
}

let appointmentCache: { day: string; rows: MockAppointment[] } | null = null;

/**
 * The generated rolling appointment book, newest day last (the route sorts and
 * filters). Rebuilt once per London day, so a long-lived dev server does not
 * keep serving yesterday's "today".
 */
export function generatedAppointments(): MockAppointment[] {
  const day = todayKey();
  if (appointmentCache?.day !== day) appointmentCache = { day, rows: buildAppointments(day) };
  return appointmentCache.rows;
}

// --- Dated invoices ---------------------------------------------------------

/**
 * Invoices carrying a `date`, so the INVOICED panel can total a window.
 *
 * The hand-written invoices in _fixtures.ts have no date at all: they exist to
 * give a handful of patients a balance for the Payments page. A gross-invoiced
 * figure for "last 30 days" cannot be built from undated rows, and the dashboard
 * would (correctly) report it unavailable, so a dated set is generated here.
 *
 * Roughly one invoice in seven is left part paid or unpaid, which is what feeds
 * the ACCOUNTS ranking of the ten patients who owe most.
 */
const INVOICE_HISTORY_DAYS = 90;
const INVOICES_PER_SITE_DAY = 5;

function invoiceGrossPence(rand: () => number): number {
  const roll = rand();
  if (roll < 0.3) return pick(rand, [2790, 2650, 7010, 9060, 3120]);
  if (roll < 0.75) return 4500 + Math.floor(rand() * 24_000);
  if (roll < 0.95) return 30_000 + Math.floor(rand() * 70_000);
  return 100_000 + Math.floor(rand() * 250_000);
}

function invoicesForSiteDay(siteId: string, day: string): MockInvoice[] {
  const dow = weekday(day);
  if (dow === 0) return [];
  const rand = seeded(`invoices|${siteId}|${day}`);
  const patients = patientsForSiteId(siteId);
  const rows: MockInvoice[] = [];
  for (let i = 0; i < INVOICES_PER_SITE_DAY; i += 1) {
    const grossPence = invoiceGrossPence(rand);
    const roll = rand();
    // Whole pounds, matching the hand-written rows and the live numeric shape.
    const amount = Math.round(grossPence / 100);
    const outstanding =
      roll < 0.86 ? 0 : roll < 0.94 ? amount : Math.max(1, Math.round(amount * (0.3 + rand() * 0.5)));
    rows.push({
      id: `inv-gen-${siteId}-${day}-${i}`,
      patient_id: pick(rand, patients).id,
      amount,
      amount_outstanding: outstanding,
      paid: outstanding === 0,
      status: outstanding === 0 ? "paid" : "new",
      date: day,
    });
  }
  return rows;
}

function buildInvoices(today: string): MockInvoice[] {
  const rows: MockInvoice[] = [];
  for (let back = 0; back < INVOICE_HISTORY_DAYS; back += 1) {
    const day = shift(today, -back);
    for (const siteId of MOCK_SITE_IDS) rows.push(...invoicesForSiteDay(siteId, day));
  }
  return rows;
}

let invoiceCache: { day: string; rows: MockInvoice[] } | null = null;

/** The generated dated invoices, rebuilt once per London day. */
export function generatedInvoices(): MockInvoice[] {
  const day = todayKey();
  if (invoiceCache?.day !== day) invoiceCache = { day, rows: buildInvoices(day) };
  return invoiceCache.rows;
}

// --- Patient registration dates ---------------------------------------------

/**
 * A deterministic `created_at` for a patient, spread over the last three years.
 *
 * The dashboard's "new patients" count is registrations inside the selected
 * window. Without a registration date on the record the count is genuinely
 * unsourceable and the panel says so, which is correct but leaves the panel
 * permanently blank in dev. Real Dentally patients do carry `created_at`.
 */
const REGISTRATION_SPREAD_DAYS = 1095;

export function patientCreatedAt(patientId: string): string {
  const back = hash32(`registered|${patientId}`) % REGISTRATION_SPREAD_DAYS;
  const day = shift(todayKey(), -back);
  return `${day}T09:00:00Z`;
}
