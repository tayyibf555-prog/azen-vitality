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
