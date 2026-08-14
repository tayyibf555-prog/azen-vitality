import type { OpeningHours, Weekday } from "@/lib/types";
import { absenceBlocksShift, groupAbsencesByStaff } from "@/lib/absence/rules";
import type { Absence } from "@/lib/absence/types";
import { isLiveShift, type RotaConfig, type RotaShift, type RotaStaff, type RotaSite } from "./types";

// ---------------------------------------------------------------------------
// Pure shift generator.
//
// For each site, each OPEN day in each week, we need `config.rolesNeeded[role]`
// people per role. We assign active staff who (a) have that role and (b) are
// available that weekday, spreading the work round-robin so hours are fair and
// nobody is booked at two sites on the same day.
//
// Fully deterministic: the caller passes the week start dates (Mondays) as input,
// so there is no Date.now / random anywhere. Given the same input the output is
// byte-for-byte identical, which is what makes idempotent re-generation safe.
// ---------------------------------------------------------------------------

const WEEKDAYS: Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export interface GenerateInput {
  staff: RotaStaff[];
  sites: RotaSite[];
  config: RotaConfig;
  /** Monday `YYYY-MM-DD` for each week to generate. Order defines the output order. */
  weekStartDates: string[];
  /**
   * London `YYYY-MM-DD` for "today". When set, days BEFORE it are skipped so a
   * mid-week roster/config change never inserts retroactive 'scheduled' shifts for
   * days already elapsed this week. Today itself is kept (same-day generation works).
   */
  today?: string;
  /**
   * Absence for these staff over the generated window. Passed in as PURE INPUT, like
   * everything else here: the generator never reads the database, so "does holiday
   * take someone off the rota" stays a testable property of a pure function rather
   * than something only observable against a live table.
   *
   * Only APPROVED absence removes anyone (the rule lives in `absenceBlocksShift`);
   * an undecided request must not silently leave a day short-staffed. Omit the field
   * entirely and generation behaves exactly as it did before absence existed.
   */
  absences?: Absence[];
  /**
   * The shifts ALREADY STORED for this window.
   *
   * ---------------------------------------------------------------------------
   * THIS IS THE FIX FOR "GENERATE FIGHTS THE MANAGER", AND IT IS THE WHOLE POINT.
   * ---------------------------------------------------------------------------
   * The generator is deliberately blind to the database, which is what makes it
   * pure and deterministic. That blindness had a cost: it could not tell an empty
   * slot from a slot a HUMAN had emptied, so a manually deleted shift came back on
   * the very next run (the UI generated on every page load, and the sweep does it
   * 24/7), and a manually moved shift got a generated twin dropped on top of it.
   * Neither failure raised anything. The edit simply undid itself.
   *
   * So the stored rows arrive as PURE INPUT, exactly as `absences` did. The
   * generator still reads no database; it is simply no longer pretending the slot
   * is empty when it is not. Omit the field entirely and generation behaves
   * byte-for-byte as it did before manual editing existed.
   *
   * Three rules, and each closes a different half of the bug:
   *  1. a LIVE row (scheduled or notified, generated or manual) means that unit of
   *     coverage is already met, and that person is already committed that day;
   *  2. a `removed` row is a person's decision that the slot should stay empty, so
   *     it BOTH blocks its own slot and consumes the coverage need. Without the
   *     second half, deleting a dentist's Monday just hands Monday to the next
   *     dentist in the rotation, which is the same bug wearing a different name;
   *  3. a `cancelled` row frees the slot for somebody else (a deactivated staff
   *     member) but must never be re-created for the SAME person.
   */
  existing?: RotaShift[];
}

/** `staffId|date|start` — the natural key of a slot, matching the DB's unique key. */
function slotKey(staffId: string, shiftDate: string, startTime: string): string {
  return `${staffId}|${shiftDate}|${startTime}`;
}

/** `siteId|date|role` — one unit of coverage the config asks for. */
function coverageKey(siteId: string, shiftDate: string, role: string): string {
  return `${siteId}|${shiftDate}|${role}`;
}

/** What the stored rows tell the generator, pre-bucketed so the inner loop stays O(1). */
interface ExistingIndex {
  /** Slots that must never be emitted again (already stored, or tombstoned). */
  blockedSlots: Set<string>;
  /** date -> staff already committed that day, so nobody is double-booked. */
  bookedByDay: Map<string, Set<string>>;
  /** coverage key -> how much of that day's need is already accounted for. */
  metCoverage: Map<string, number>;
}

function indexExisting(existing: RotaShift[]): ExistingIndex {
  const blockedSlots = new Set<string>();
  const bookedByDay = new Map<string, Set<string>>();
  const metCoverage = new Map<string, number>();

  for (const shift of existing) {
    const status = shift.status ?? "scheduled";
    // A cancelled row keeps its slot blocked (re-emitting it would be a no-op
    // against the unique key anyway, and a misleading one in the returned set) but
    // does NOT count as coverage: cancelling exists precisely to free the slot.
    if (status === "cancelled") {
      blockedSlots.add(slotKey(shift.staffId, shift.shiftDate, shift.startTime));
      continue;
    }

    blockedSlots.add(slotKey(shift.staffId, shift.shiftDate, shift.startTime));

    const key = coverageKey(shift.siteId, shift.shiftDate, shift.role);
    metCoverage.set(key, (metCoverage.get(key) ?? 0) + 1);

    // A tombstone commits nobody: the person is explicitly NOT working. It consumes
    // the coverage need above so no replacement is invented, and that is all.
    if (status === "removed") continue;

    if (isLiveShift(shift)) {
      const booked = bookedByDay.get(shift.shiftDate);
      if (booked) booked.add(shift.staffId);
      else bookedByDay.set(shift.shiftDate, new Set([shift.staffId]));
    }
  }

  return { blockedSlots, bookedByDay, metCoverage };
}

/** Parse an "HH:MM-HH:MM" opening window; null/blank/malformed = closed that day. */
function parseWindow(window: string | null | undefined): { start: string; end: string } | null {
  if (!window) return null;
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(window.trim());
  if (!m) return null;
  return { start: m[1], end: m[2] };
}

/** Add whole days to a `YYYY-MM-DD` key, returning a `YYYY-MM-DD` key (UTC-safe). */
function addDays(dayKey: string, days: number): string {
  const base = Date.parse(`${dayKey}T00:00:00Z`);
  const d = new Date(base + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Whole days from the Unix epoch for a `YYYY-MM-DD` key (UTC). This is stable per
 * calendar date regardless of the generation window: it does NOT depend on how many
 * weeks precede this date in `weekStartDates`. We seed the round-robin offset from
 * this so a given (site, role, date) slot assigns the SAME person on every run —
 * which is what lets the idempotent upsert on (client, staff, date, start_time)
 * actually dedupe. A window-relative cursor would pick a different person each run
 * (the same slot, a new staff_id), and the upsert would stack a second shift onto
 * the slot instead of skipping it: duplicate coverage every regeneration.
 */
function daysSinceEpoch(dayKey: string): number {
  return Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / 86_400_000);
}

function isAvailable(staff: RotaStaff, weekday: Weekday): boolean {
  return staff.availability[weekday] === true;
}

/** The Europe/London weekday index (0 = Monday .. 6 = Sunday) for an instant. */
function londonWeekdayIndex(d: Date): number {
  // en-GB short weekday in the London zone, mapped to a Monday-first index.
  const name = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(d);
  const order: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return order[name] ?? 0;
}

/** The Europe/London calendar day for an instant, as `YYYY-MM-DD`. */
function londonDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * The Monday `YYYY-MM-DD` (London) of the week containing `now`, plus the next
 * `weeks - 1` Mondays. Pure: `now` is passed in, so generation is deterministic
 * and testable. The current week is included so shifts later today/this week still
 * generate; the sweep + generator skip closed/past days via opening hours anyway.
 */
export function upcomingWeekStarts(now: Date, weeks: number): string[] {
  const count = Math.max(0, Math.trunc(weeks));
  if (count === 0) return [];
  const thisMonday = addDays(londonDay(now), -londonWeekdayIndex(now));
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(addDays(thisMonday, i * 7));
  return out;
}

/**
 * Generate shifts for every open day in every requested week.
 *
 * Assignment rules:
 * - Only active staff with a matching role and availability for that weekday are
 *   eligible.
 * - We pick round-robin from a per-role rotating cursor so, over many days, the
 *   work is spread evenly rather than always landing on the first person.
 * - Nobody is booked twice on the same date (across all sites and roles), so a
 *   person available at two sites on Monday only gets one Monday shift.
 * - Anyone on APPROVED absence that day is skipped, and the round-robin simply moves
 *   on to the next eligible person, so the slot is covered by somebody else rather
 *   than left empty.
 * - Coverage a stored shift already provides is NOT re-provided, and a slot a person
 *   deliberately emptied stays empty. See `GenerateInput.existing`.
 * - If not enough eligible staff exist for a role on a day, the remaining coverage
 *   slots are simply left unfilled (no crash, no placeholder rows).
 *
 * The return value is what is MISSING, not the whole week: with `existing` supplied
 * it is the set of shifts that still need creating. Callers that want the week
 * itself read it from the database (`GET /api/rota/shifts`) rather than generating
 * it, which is the pattern that replaced "POST the generator to read the rota".
 */
export function generateShifts(input: GenerateInput): RotaShift[] {
  const { config, weekStartDates } = input;
  const sites = [...input.sites].sort((a, b) => a.id.localeCompare(b.id));

  // Bucket absence per person once, so the per-slot check is a small array scan of
  // one person's absences rather than a full scan of the practice's.
  const absencesByStaff = groupAbsencesByStaff(input.absences ?? []);

  // What is already stored for this window: manual decisions, tombstones, and the
  // rows a previous run wrote. Empty when the caller passes nothing, which is why
  // every pre-existing caller and test behaves exactly as before.
  const stored = indexExisting(input.existing ?? []);

  // Eligible pool per role: active + has the role. Sorted by id for determinism.
  const byRole = new Map<string, RotaStaff[]>();
  for (const role of Object.keys(config.rolesNeeded)) {
    const pool = input.staff
      .filter((s) => s.active && s.role === role)
      .sort((a, b) => a.id.localeCompare(b.id));
    byRole.set(role, pool);
  }

  const shifts: RotaShift[] = [];

  for (const weekStart of weekStartDates) {
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const weekday = WEEKDAYS[dayIndex];
      const shiftDate = addDays(weekStart, dayIndex);
      // Skip days already elapsed this week so a mid-week change never back-fills
      // retroactive 'scheduled' shifts. Today itself is kept.
      if (input.today && shiftDate < input.today) continue;
      // Absolute day number -> a per-day round-robin offset that is identical no
      // matter where this date falls in the input window. Advancing by one calendar
      // day still rotates the starting person (fair spread), but re-running with a
      // shifted week window reproduces the same assignment (idempotent).
      const dayNumber = daysSinceEpoch(shiftDate);

      // Track who is already booked on THIS date, so a person is never double-booked
      // across sites/roles on the same day. Seeded from the stored rows, so somebody
      // a manager has already placed manually is not placed again somewhere else.
      const bookedToday = new Set<string>(stored.bookedByDay.get(shiftDate) ?? []);

      for (const site of sites) {
        const window = parseWindow((site.openingHours as OpeningHours)[weekday]);
        if (!window) continue; // site closed this day: no shifts.

        for (const role of Object.keys(config.rolesNeeded)) {
          const need = config.rolesNeeded[role];
          if (need <= 0) continue;
          const pool = byRole.get(role) ?? [];
          if (pool.length === 0) continue;

          // Coverage the stored rows already account for: a live shift (someone is
          // in) or a tombstone (a person decided nobody should be). Both mean this
          // generator has no business writing into the slot.
          let filled = stored.metCoverage.get(coverageKey(site.id, shiftDate, role)) ?? 0;
          if (filled >= need) continue;
          // Seed the offset from the absolute calendar day, not a carried cursor, so
          // the assignment for this (role, date) is reproducible across runs.
          const cur = dayNumber % pool.length;
          // Walk the pool once starting from that offset; take eligible,
          // not-yet-booked-today people until the role's need is met or we run out.
          for (let step = 0; step < pool.length && filled < need; step += 1) {
            const person = pool[(cur + step) % pool.length];
            if (bookedToday.has(person.id)) continue;
            if (!isAvailable(person, weekday)) continue;
            // Approved holiday, sickness, training or unpaid leave: they are not in
            // that day, so they cannot be rostered. Checked here rather than by
            // pre-filtering the pool because absence is per DAY, not per person.
            if (absenceBlocksShift({ staffId: person.id, shiftDate }, absencesByStaff.get(person.id) ?? [])) {
              continue;
            }
            // Never re-emit a slot that already exists in any form. A tombstoned
            // slot in particular must not come back: that is the manager's deletion,
            // and re-creating it is the bug.
            if (stored.blockedSlots.has(slotKey(person.id, shiftDate, window.start))) continue;

            shifts.push({
              clientId: person.clientId,
              siteId: site.id,
              staffId: person.id,
              shiftDate,
              startTime: window.start,
              endTime: window.end,
              role,
              status: "scheduled",
              // Stated rather than defaulted: this row was decided by the machine,
              // and that is exactly the fact a later run needs in order to know it
              // may overwrite this one and not the manager's.
              origin: "generated",
            });
            bookedToday.add(person.id);
            filled += 1;
          }
        }
      }
    }
  }

  return shifts;
}
