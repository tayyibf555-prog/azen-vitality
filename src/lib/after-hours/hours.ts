// Pure opening-hours logic for the after-hours capture module.
//
// A site carries a `timezone` (an IANA zone such as "Europe/London") and an
// optional `openingHours` map. We derive the site-local weekday + HH:MM for a
// given instant with Intl.DateTimeFormat so the comparison is correct across
// DST and wherever the server runs. No clock is read here: callers pass `now`,
// which keeps this deterministic and easy to test.

import type { OpeningHours, Site, Weekday } from "@/lib/types";
import { getSite } from "@/lib/mock/clients";

/** Convenience lookup so callers can resolve a site without importing the mock module directly. */
export function getSiteById(id: string): Site | undefined {
  return getSite(id);
}

// Intl weekday "long" names map onto our lower-case Weekday union.
const WEEKDAY_BY_NAME: Record<string, Weekday> = {
  Monday: "monday",
  Tuesday: "tuesday",
  Wednesday: "wednesday",
  Thursday: "thursday",
  Friday: "friday",
  Saturday: "saturday",
  Sunday: "sunday",
};

interface LocalParts {
  weekday: Weekday;
  minutes: number; // minutes since local midnight
}

/** Derive the site-local weekday and minutes-since-midnight for an instant. */
function localParts(timezone: string, now: Date): LocalParts | null {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  let weekdayName = "";
  let hour = "";
  let minute = "";
  for (const p of parts) {
    if (p.type === "weekday") weekdayName = p.value;
    else if (p.type === "hour") hour = p.value;
    else if (p.type === "minute") minute = p.value;
  }
  const weekday = WEEKDAY_BY_NAME[weekdayName];
  if (!weekday) return null;
  // Intl can emit "24" for midnight in some runtimes; normalise to 0.
  const h = Number(hour) % 24;
  const m = Number(minute);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return { weekday, minutes: h * 60 + m };
}

/** Parse "HH:MM" to minutes since midnight, or null if malformed. */
function toMinutes(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (Number.isNaN(h) || Number.isNaN(m) || h > 23 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Whether `now` falls OUTSIDE the site's opening window.
 *
 * Outside hours (returns true) when:
 *  - the site has no `openingHours` config, or
 *  - that weekday is closed (null), or a malformed window, or
 *  - the local time is before open or at/after close.
 *
 * The closing minute is treated as closed (e.g. a 17:30 close means 17:30 is
 * already after hours), which is the safe default for capture.
 */
export function isOutsideHours(site: Site | undefined, now: Date): boolean {
  if (!site || !site.openingHours) return true;
  const parts = localParts(site.timezone, now);
  if (!parts) return true;

  const hours: OpeningHours = site.openingHours;
  const window = hours[parts.weekday];
  if (!window) return true; // closed day

  const [openRaw, closeRaw] = window.split("-");
  if (!openRaw || !closeRaw) return true;
  const open = toMinutes(openRaw);
  const close = toMinutes(closeRaw);
  if (open === null || close === null || close <= open) return true;

  return parts.minutes < open || parts.minutes >= close;
}
