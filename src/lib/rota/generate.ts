import type { OpeningHours, Weekday } from "@/lib/types";
import type { RotaConfig, RotaShift, RotaStaff, RotaSite } from "./types";

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
 * - If not enough eligible staff exist for a role on a day, the remaining coverage
 *   slots are simply left unfilled (no crash, no placeholder rows).
 */
export function generateShifts(input: GenerateInput): RotaShift[] {
  const { config, weekStartDates } = input;
  const sites = [...input.sites].sort((a, b) => a.id.localeCompare(b.id));

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
      // across sites/roles on the same day.
      const bookedToday = new Set<string>();

      for (const site of sites) {
        const window = parseWindow((site.openingHours as OpeningHours)[weekday]);
        if (!window) continue; // site closed this day: no shifts.

        for (const role of Object.keys(config.rolesNeeded)) {
          const need = config.rolesNeeded[role];
          if (need <= 0) continue;
          const pool = byRole.get(role) ?? [];
          if (pool.length === 0) continue;

          let filled = 0;
          // Seed the offset from the absolute calendar day, not a carried cursor, so
          // the assignment for this (role, date) is reproducible across runs.
          const cur = dayNumber % pool.length;
          // Walk the pool once starting from that offset; take eligible,
          // not-yet-booked-today people until the role's need is met or we run out.
          for (let step = 0; step < pool.length && filled < need; step += 1) {
            const person = pool[(cur + step) % pool.length];
            if (bookedToday.has(person.id)) continue;
            if (!isAvailable(person, weekday)) continue;

            shifts.push({
              clientId: person.clientId,
              siteId: site.id,
              staffId: person.id,
              shiftDate,
              startTime: window.start,
              endTime: window.end,
              role,
              status: "scheduled",
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
