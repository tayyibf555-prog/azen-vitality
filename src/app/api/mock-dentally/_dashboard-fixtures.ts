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
import { ROSTER, hasEmptyBook, sessionFor } from "@/app/api/mock-dentally/_rota";
import { londonDayKey } from "@/lib/time/london";

const DAY_MS = 86_400_000;

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
 * A weighted pick from cumulative thresholds, consuming EXACTLY ONE rand().
 *
 * One draw per decision matters: the generator's PRNG is a single walking
 * sequence shared with the slot times, the durations, the patient and the note,
 * so a branch that drew twice where another drew once would shift every
 * subsequent field and rewrite the whole book.
 *
 * The last entry is returned for anything at or above the final threshold, so
 * the table can never fall off the end and return undefined.
 */
function rollState(rand: () => number, table: readonly (readonly [number, string])[]): string {
  const roll = rand();
  for (const [ceiling, state] of table) if (roll < ceiling) return state;
  return table[table.length - 1][1];
}

/**
 * The state of a booking, which depends on where the day sits relative to today.
 *
 * REAL DENTALLY'S WHOLE VOCABULARY, in its own Title Case wire spelling:
 * Pending, Confirmed, Arrived, In surgery, Completed, Cancelled, Did not attend.
 * The generator used to emit four of those plus "booked", the mock's legacy word
 * for confirmed (see appointment-state.ts: it does NOT exist on live Dentally and
 * survives only as the normaliser's fallback for a row whose state is missing).
 * Pending, Arrived and In surgery could therefore never appear on screen, so
 * three of the diary's seven state treatments — the P, the clock and the S,
 * exactly the notation this practice was trained on — were unreachable and
 * unreviewable. A mock tidier than the practice hides defects rather than
 * exposing them.
 *
 * A past day is SETTLED: mostly completed, with the cancellations and missed
 * appointments a real book carries, plus a small tail nobody ever closed off.
 * A future day has NOT HAPPENED: nothing on it can be completed, sat in or
 * missed, but a patient can certainly have cancelled it already.
 * TODAY is read against the clock, hour by hour, because "Arrived" and
 * "In surgery" are claims about right now and inventing them on a settled day
 * would be a lie about the book rather than a richer demo.
 */
export function stateFor(
  rand: () => number,
  daysBack: number,
  slotHour: number,
  nowHourLondon: number,
): string {
  // A FUTURE day (daysBack < 0) has not happened yet. Without this branch the
  // slot-hour comparison below would file tomorrow's 09:00 as "Completed"
  // whenever the fixture is built after 09:00 today.
  if (daysBack < 0) {
    return rollState(rand, [
      [0.6, "Confirmed"],
      [0.92, "Pending"],
      [1, "Cancelled"],
    ]);
  }
  if (daysBack > 0) {
    return rollState(rand, [
      [0.76, "Completed"],
      [0.86, "Cancelled"],
      [0.93, "Did not attend"],
      // The tail the practice never closed off. Real books have these — a
      // clinician who never clicked through from Arrived, a confirmation left
      // standing — and the dashboard must not silently file them under a donut
      // slice. They are the only place the clock-independent reader can see a
      // P, a clock or an S, which is why the tail is real states and not "booked".
      [0.96, "Confirmed"],
      [0.98, "Pending"],
      [0.99, "Arrived"],
      [1, "In surgery"],
    ]);
  }

  // TODAY, hour by hour against the London wall clock.
  const delta = slotHour - nowHourLondon;
  if (delta <= -2) {
    // Long done.
    return rollState(rand, [
      [0.86, "Completed"],
      [0.93, "Cancelled"],
      [1, "Did not attend"],
    ]);
  }
  if (delta === -1) {
    // Just finished, or overrunning into this hour.
    return rollState(rand, [
      [0.55, "Completed"],
      [0.8, "In surgery"],
      [0.88, "Arrived"],
      [1, "Did not attend"],
    ]);
  }
  if (delta === 0) {
    // Happening now: the one hour of the day where the saturated in-surgery
    // block and the arrived clock belong.
    return rollState(rand, [
      [0.45, "In surgery"],
      [0.83, "Arrived"],
      [0.93, "Completed"],
      [1, "Did not attend"],
    ]);
  }
  if (delta === 1) {
    // Next up. Some of them are already sitting in the waiting room.
    return rollState(rand, [
      [0.45, "Confirmed"],
      [0.65, "Pending"],
      [0.93, "Arrived"],
      [1, "Cancelled"],
    ]);
  }
  // Later today.
  return rollState(rand, [
    [0.58, "Confirmed"],
    [0.92, "Pending"],
    [1, "Cancelled"],
  ]);
}

/**
 * One site's bookings for one day, placed INSIDE the rota sessions.
 *
 * Appointments used to be spread 09:00 to 17:30 across two invented
 * practitioners regardless of who was actually at the site. That makes
 * grey-means-off incoherent: the diary derives working time as the union of
 * availability and BOOKINGS, so a booking outside every session forces white
 * onto a column that ought to read "Not working", and a booking against a
 * clinician who is at another site that day is simply wrong.
 *
 * So: only clinicians rostered at THIS site on THIS day get bookings, only
 * inside their own session, on a five minute grid, and never overlapping
 * themselves.
 *
 * AND SPREAD ACROSS THE SESSION, not packed against its start. The walking
 * cursor used to advance by the appointment's own length plus an occasional
 * quarter hour, so a site's nine bookings landed back-to-back from the moment
 * each clinician's session opened and every column was empty from about 10:15
 * onward: a practice whose entire working day happened before mid-morning. Two
 * things fell out of that, neither of them a rendering fault:
 *   - every capacity line read the same ("6h free · longest 6h at 10:00"),
 *     because the longest free run was always "the rest of the day",
 *   - "Arrived" and "In surgery" are claims about the hour containing NOW, so
 *     they were unreachable on screen at any hour a practice manager is likely
 *     to be looking at the diary.
 * The stride below spaces the SAME number of bookings over the whole session,
 * which is what a real book looks like and what makes the marks reviewable.
 */
function appointmentsForSiteDay(
  siteId: string,
  day: string,
  daysBack: number,
  nowHourLondon: number,
): MockAppointment[] {
  const dow = weekday(day);
  if (dow === 0) return []; // Closed on Sundays.

  // Who is genuinely at this site today, with their session, minus the
  // clinician-days deliberately left with an empty book (_rota.ts EMPTY_BOOK).
  const working = (ROSTER[siteId] ?? [])
    .filter((p) => p.active && !hasEmptyBook(p.id, day))
    .map((p) => ({ id: p.id, name: `${p.first} ${p.last}`, session: sessionFor(p.id, day) }))
    .filter((p): p is { id: string; name: string; session: { siteId: string; startMin: number; endMin: number } } =>
      p.session !== null && p.session.siteId === siteId,
    );
  if (working.length === 0) return [];

  const rand = seeded(`diary|${siteId}|${day}`);
  const base = DAILY_SLOTS[siteId] ?? 8;
  const target = dow === 6 ? Math.max(2, Math.round(base * 0.4)) : base + Math.floor(rand() * 5) - 2;
  const patients = patientsForSiteId(siteId);

  // A walking cursor per clinician, so one clinician never double-books.
  const cursor = new Map(working.map((p) => [p.id, p.session.startMin]));

  // The gap each clinician leaves between bookings, so their share of the day's
  // rows covers their whole session instead of stacking against its opening.
  //
  // Derived from the MEAN duration (35 minutes across [15,30,30,30,45,60])
  // rather than the actual draws, because the durations come off the shared PRNG
  // inside the loop below and are not knowable here. It only has to be close:
  // the overflow guard in the loop is the hard boundary, and the jitter moves
  // each start by up to a quarter hour either way so the day is not a metronome.
  const MEAN_DURATION_MIN = 35;
  const strideGap = new Map(
    working.map((p, index) => {
      // Round-robin, so this clinician gets every working.length'th row.
      const mine = Math.max(1, Math.ceil(Math.max(0, target - index) / working.length));
      const sessionMin = Math.max(0, p.session.endMin - p.session.startMin);
      const spare = sessionMin - mine * MEAN_DURATION_MIN;
      // Divided by (mine - 0.5), not by `mine`: dividing by the count leaves a
      // whole stride of dead time hanging off the end of every session, which is
      // the same "the practice stops at lunch" artefact one notch later. Half a
      // stride of tail is deliberate headroom, so the +15 jitter on the last
      // booking can never push it past the session end and get it dropped by the
      // overflow guard, which would silently change the day's count.
      return [p.id, Math.max(0, Math.floor(spare / Math.max(1, mine - 0.5) / 5) * 5)];
    }),
  );

  const rows: MockAppointment[] = [];
  for (let i = 0; i < Math.max(0, target); i += 1) {
    const clinician = working[i % working.length];
    const startMin = cursor.get(clinician.id) ?? clinician.session.startMin;
    const duration = pick(rand, [15, 30, 30, 30, 45, 60]);
    if (startMin + duration > clinician.session.endMin) continue; // their day is full
    const patient = pick(rand, patients);
    rows.push({
      id: `appt-gen-${siteId}-${day}-${i}`,
      patient_id: patient.id,
      patient_name: patient.name,
      site_id: siteId,
      start_time: londonInstant(day, Math.floor(startMin / 60), startMin % 60),
      duration,
      state: stateFor(rand, daysBack, Math.floor(startMin / 60), nowHourLondon),
      reason: pick(rand, REASONS),
      practitioner: clinician.name,
      practitioner_id: clinician.id,
      // Roughly a third of bookings carry a note, as in the real diary.
      notes: rand() < 0.34 ? pick(rand, NOTES) : undefined,
    });
    // Advance by this clinician's stride, jittered by up to a quarter hour
    // either way so their day is not a metronome. ONE rand() call, as before.
    // The stride, the jitter, the duration and every session boundary are all
    // multiples of five, so every start time lands on the diary's own grid.
    const jitter = Math.round((rand() - 0.5) * 6) * 5; // -15..+15
    const gap = Math.max(0, (strideGap.get(clinician.id) ?? 0) + jitter);
    cursor.set(clinician.id, startMin + duration + gap);
  }
  return rows;
}

/** How far back the generated book runs. Matches the longest strip period. */
const DIARY_HISTORY_DAYS = 90;
/**
 * How far FORWARD it runs. The diary loads today-14 to today+45, and a book that
 * stopped at today would leave drag-and-drop with almost nothing to drag and make
 * free capacity read as roughly 100% on every future day.
 */
const DIARY_FUTURE_DAYS = 45;

function buildAppointments(today: string): MockAppointment[] {
  const nowHourLondon = Number(londonHourMinute(new Date()).slice(0, 2));
  const rows: MockAppointment[] = [];
  for (let back = -DIARY_FUTURE_DAYS; back < DIARY_HISTORY_DAYS; back += 1) {
    const day = shift(today, -back);
    for (const siteId of MOCK_SITE_IDS) {
      rows.push(...appointmentsForSiteDay(siteId, day, back, nowHourLondon));
    }
  }
  return rows;
}

/**
 * The cache stamp: the London day AND the London hour.
 *
 * It used to be the day alone. Today's states are read against the clock, so on
 * a dev server left running since breakfast the now-line crawled down a book
 * whose states were frozen at the hour it booted: at 16:00 the "in surgery"
 * block still sat at 09:00, three hours of the afternoon were still "Confirmed"
 * with the now-line below them, and the one hour of the day that shows an
 * arrived clock was in the past. Re-seeding costs nothing (the PRNG is keyed on
 * site and day, so every other day rebuilds byte-identical) and the ids are
 * deterministic, so in-session edits survive the rebuild.
 */
function bookStamp(): string {
  return `${todayKey()}|${londonHourMinute(new Date()).slice(0, 2)}`;
}

let appointmentCache: { day: string; rows: MockAppointment[] } | null = null;

/**
 * In-session edits to generated rows, applied on read.
 *
 * The generated book is rebuilt from a seeded PRNG, so a PUT cannot simply mutate
 * it: the next rebuild would discard the change. Overrides live beside it and are
 * layered on top. They live HERE rather than in _fixtures.ts because _fixtures.ts
 * is imported BY this file and the reverse would be circular.
 */
const generatedOverrides = new Map<string, Partial<MockAppointment>>();

/**
 * The generated rolling appointment book, newest day last (the route sorts and
 * filters). Rebuilt once per London HOUR, so a long-lived dev server neither
 * keeps serving yesterday's "today" nor freezes today's states at the hour it
 * happened to start. See bookStamp.
 */
export function generatedAppointments(): MockAppointment[] {
  const stamp = bookStamp();
  if (appointmentCache?.day !== stamp) {
    appointmentCache = { day: stamp, rows: buildAppointments(todayKey()) };
  }
  const rows = appointmentCache.rows;
  if (generatedOverrides.size === 0) return rows;
  return rows.map((r) => {
    const patch = generatedOverrides.get(r.id);
    return patch ? { ...r, ...patch } : r;
  });
}

/** One generated appointment by id, with any in-session edit applied. */
export function findGeneratedAppointment(id: string): MockAppointment | undefined {
  return generatedAppointments().find((a) => a.id === id);
}

/**
 * Edit a generated appointment (reschedule, resize, reassign, cancel). Returns the
 * updated row, or undefined when the id is not a generated one. Every row the
 * diary renders comes from generatedAppointments(), so without this a PUT against
 * anything visible in the diary 404s.
 */
export function updateGeneratedAppointment(
  id: string,
  patch: Partial<MockAppointment>,
): MockAppointment | undefined {
  const current = findGeneratedAppointment(id);
  if (!current) return undefined;
  generatedOverrides.set(id, { ...(generatedOverrides.get(id) ?? {}), ...patch });
  return { ...current, ...patch };
}

// --- Dated invoices ---------------------------------------------------------

/**
 * Invoices carrying a DATE THE ROUTE ACTUALLY FILTERS ON, so the INVOICED panel can
 * total a window.
 *
 * The hand-written invoices in _fixtures.ts have no date at all: they exist to
 * give a handful of patients a balance for the Payments page. A gross-invoiced
 * figure for "last 30 days" cannot be built from undated rows, and the dashboard
 * would (correctly) report it unavailable, so a dated set is generated here.
 *
 * THESE ROWS CARRIED ONLY `date`, AND THAT MADE THE PANEL LIE IN DEV. Live
 * /v1/invoices filters on `created_at` (created_after / created_before) and has no
 * `date` field at all, and the mock route matches it — dropping every row without a
 * `created_at` from a date-filtered request. So the dashboard's windowed invoice scan
 * asked for the last 90 days, got ZERO rows back, read that as a COMPLETE read of an
 * empty window, and rendered INVOICED as a confident £0.00 for every period. A blank
 * would have been questioned; a zero on a billing panel reads as a fact about the
 * practice. Every generated row now carries `created_at` on its own day, so dev
 * exercises the same filter, the same paging and the same bucketing that live does.
 *
 * `dated_on` is set too, because live index rows carry it (it is the billed date, and
 * on live it agreed with created_at's London day on all 300 rows probed), and `date`
 * is KEPT only because the mock's own /v1/invoices/[id] route reads it to answer
 * `dated_on` on the detail shape. Nothing in the platform buckets on `date` any more.
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

/**
 * A generated invoice, with the two date fields live actually publishes. Declared
 * here rather than on MockInvoice so the hand-written rows stay deliberately undated
 * — they are what keeps the dashboard's "undated invoices" disclosure exercised.
 */
type DatedMockInvoice = MockInvoice & { created_at: string; dated_on: string };

/** Mid-morning on the invoice's own day. Far enough inside it that neither the BST
 *  offset nor a day-boundary pad can move the row into a neighbouring day. */
function invoiceCreatedAt(day: string): string {
  return `${day}T10:00:00+01:00`;
}

function invoicesForSiteDay(siteId: string, day: string): DatedMockInvoice[] {
  const dow = weekday(day);
  if (dow === 0) return [];
  const rand = seeded(`invoices|${siteId}|${day}`);
  const patients = patientsForSiteId(siteId);
  const rows: DatedMockInvoice[] = [];
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
      created_at: invoiceCreatedAt(day),
      dated_on: day,
    });
  }
  return rows;
}

function buildInvoices(today: string): DatedMockInvoice[] {
  const rows: DatedMockInvoice[] = [];
  for (let back = 0; back < INVOICE_HISTORY_DAYS; back += 1) {
    const day = shift(today, -back);
    for (const siteId of MOCK_SITE_IDS) rows.push(...invoicesForSiteDay(siteId, day));
  }
  return rows;
}

let invoiceCache: { day: string; rows: DatedMockInvoice[] } | null = null;

/** The generated dated invoices, rebuilt once per London day. */
export function generatedInvoices(): DatedMockInvoice[] {
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
