import { getSites } from "@/lib/mock/clients";
import type { Weekday } from "@/lib/rota/types";

// Small presentation helpers shared across the rota tabs. Pure, no I/O, so both the
// staff panel and the "this week" view can reuse the same weekday labels, role list
// and site-name lookup without duplicating constants.

/** The working week, Monday to Saturday. Sunday is dropped (sites are closed). */
export const ROTA_WEEKDAYS: Weekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** Short chip label for a weekday, e.g. "Mon". */
export const WEEKDAY_SHORT: Record<Weekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

/** Long weekday label for the day headers, e.g. "Monday". */
export const WEEKDAY_LONG: Record<Weekday, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

/** The roles an owner can pick for a staff member and configure coverage for. */
export const ROTA_ROLES = ["dentist", "hygienist", "nurse", "reception", "manager"] as const;
export type RotaRole = (typeof ROTA_ROLES)[number];

/** The roles the Settings tab lets an owner set a coverage count for. */
export const COVERAGE_ROLES = ["dentist", "nurse", "reception", "hygienist"] as const;

/**
 * The colour each role wears on the grid.
 *
 * COLOUR BY ROLE, NOT BY STATUS, and that is a change of mind on the record. The
 * grid used to tint every card by notified-vs-scheduled, which meant the whole week
 * was one of two colours and the question a manager actually asks -- "is there a
 * nurse on Thursday" -- could not be answered by looking. Role is the thing you scan
 * for; notified state is a dot and a border, because it matters once and then never
 * again.
 *
 * Keyed off ROTA_ROLES so a role added there without a colour here is visibly plain
 * rather than invisibly mis-tinted.
 */
export const ROLE_STYLES: Record<string, { card: string; dot: string; text: string }> = {
  dentist: { card: "border-blue/30 bg-blue/[0.07]", dot: "bg-blue", text: "text-blue" },
  hygienist: { card: "border-teal-600/30 bg-teal-500/[0.09]", dot: "bg-teal-600", text: "text-teal-700" },
  nurse: { card: "border-violet-500/30 bg-violet-500/[0.08]", dot: "bg-violet-500", text: "text-violet-700" },
  reception: { card: "border-amber-500/35 bg-amber-400/[0.12]", dot: "bg-amber-500", text: "text-amber-700" },
  manager: { card: "border-slate-400/40 bg-slate-400/[0.10]", dot: "bg-slate-500", text: "text-slate-700" },
};

/** The style for a role, falling back to a plain neutral card for an unknown one. */
export function roleStyle(role: string): { card: string; dot: string; text: string } {
  return ROLE_STYLES[role] ?? { card: "border-line bg-card-muted/40", dot: "bg-line-strong", text: "text-muted" };
}

/** The first Monday on or before the 1st of the month a `YYYY-MM-DD` day falls in. */
export function monthGridStart(dayKey: string): string {
  const first = `${dayKey.slice(0, 7)}-01`;
  return mondayOf(first);
}

/**
 * The 42 days (six Mon..Sun rows) that cover a month, so the month grid never
 * changes height as the user pages and rows never reflow mid-scan.
 */
export function monthGridDays(dayKey: string): string[] {
  const start = monthGridStart(dayKey);
  return Array.from({ length: 42 }, (_, i) => addDaysKey(start, i));
}

/** Shift a `YYYY-MM-DD` key by whole months, clamping to the 1st (grids start there). */
export function addMonths(dayKey: string, months: number): string {
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7)) - 1 + months;
  const y = year + Math.floor(month / 12);
  const m = ((month % 12) + 12) % 12;
  return `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-01`;
}

/** "July 2026" for a month header. */
export function monthLabel(dayKey: string): string {
  const ms = Date.parse(`${dayKey.slice(0, 7)}-01T12:00:00Z`);
  if (Number.isNaN(ms)) return dayKey;
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    month: "long",
    year: "numeric",
  });
}

/** Whether a `YYYY-MM-DD` key is in the same calendar month as `anchor`. */
export function sameMonth(dayKey: string, anchor: string): boolean {
  return dayKey.slice(0, 7) === anchor.slice(0, 7);
}

/** Title-case a role for display, e.g. "dentist" -> "Dentist". */
export function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** Map a site id to its human name; falls back to a "floats across sites" label or the id. */
export function siteName(clientSlug: string, siteId: string | null): string {
  if (!siteId) return "Any site";
  const site = getSites(clientSlug).find((s) => s.id === siteId);
  return site?.name ?? siteId;
}

/** The Europe/London weekday key for a `YYYY-MM-DD` day, so shifts group under the right day. */
export function weekdayOf(shiftDate: string): Weekday | null {
  const ms = Date.parse(`${shiftDate}T12:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const name = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
  }).format(new Date(ms));
  const map: Record<string, Weekday> = {
    Mon: "monday",
    Tue: "tuesday",
    Wed: "wednesday",
    Thu: "thursday",
    Fri: "friday",
    Sat: "saturday",
    Sun: "sunday",
  };
  return map[name] ?? null;
}

/** A friendly "Mon 6 Jul" style date label for a `YYYY-MM-DD` day. */
export function dayLabel(shiftDate: string): string {
  const ms = Date.parse(`${shiftDate}T12:00:00Z`);
  if (Number.isNaN(ms)) return shiftDate;
  return new Date(ms).toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Trim seconds off an "HH:MM[:SS]" wall-clock time for display. */
export function timeLabel(t: string): string {
  return t.length >= 5 ? t.slice(0, 5) : t;
}

/** Zero-based Monday..Sunday index for a weekday, so we can find a week's Monday. */
const WEEKDAY_INDEX: Record<Weekday, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

/** Add (or subtract) whole days to a `YYYY-MM-DD` key. Uses noon UTC so a ±1h DST
 *  shift can never roll the date across a boundary. */
export function addDaysKey(dayKey: string, days: number): string {
  const ms = Date.parse(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(ms)) return dayKey;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** The Monday (week start) of the week a `YYYY-MM-DD` day falls in. */
export function mondayOf(dayKey: string): string {
  const wd = weekdayOf(dayKey);
  if (!wd) return dayKey;
  return addDaysKey(dayKey, -WEEKDAY_INDEX[wd]);
}

/** The day-of-month number for a `YYYY-MM-DD` key, e.g. "6". */
export function dayOfMonth(dayKey: string): string {
  const ms = Date.parse(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric" });
}

/** A week's span label, e.g. "30 Jun to 5 Jul" (Monday to Saturday, no dash in copy). */
export function weekRangeLabel(mondayKey: string): string {
  const fmt = (k: string) =>
    new Date(Date.parse(`${k}T12:00:00Z`)).toLocaleDateString("en-GB", {
      timeZone: "Europe/London",
      day: "numeric",
      month: "short",
    });
  return `${fmt(mondayKey)} to ${fmt(addDaysKey(mondayKey, 5))}`;
}

/** Today's `YYYY-MM-DD` in Europe/London, for highlighting the current day. */
export function londonTodayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
