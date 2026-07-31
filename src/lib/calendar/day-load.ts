import "server-only";

// ===========================================================================
// THE DIARY'S PER-DAY READ.
//
// Three reads, three INDEPENDENT failure flags. They are never collapsed into one
// "something went wrong", because each absence looks different on the grid and
// each needs its own words:
//
//   availabilityFailed  the columns hatch and say "Hours not loaded". They must
//                       NEVER go grey: grey is a positive claim that a clinician is
//                       off, and a failed read turning the whole practice grey on a
//                       busy Monday would send a receptionist ringing patients to
//                       cancel a fully staffed day.
//   fundingFailed       no rail is drawn anywhere, which looks IDENTICAL to "not on
//                       file", which is precisely why it needs saying in words.
//   entriesFailed       no break or note is drawn, and moves are refused, because a
//                       drop cannot be validated against breaks we could not read.
// ===========================================================================

import type { AppointmentRecord } from "@/lib/dentally/read";
import { listDiaryAvailabilitySafe } from "@/lib/dentally/read";
import { londonDayKey } from "@/lib/time/london";
import {
  dayKeysBetween,
  parseAvailabilityWindows,
  UNTAGGED_FAIL_RATIO,
  type AvailabilityWindow,
} from "./availability";
import { resolveDayFunding } from "./funding-source";
import { listEntries } from "./repository";
import { availabilityTrustedHere, readSharedPractitionerIds } from "./site-presence";
import type { UnconfirmedPresence } from "./working-spans";
import type { FundingCode } from "./funding";
import type { DiaryEntryRecord } from "./entries";

/**
 * Availability is scoped to the VIEWED range and never to the diary's loaded
 * sixty-day window. Week is 7 and multiday tops out at 7, so this is the real
 * ceiling; sizing it to the loaded window would collapse the cost model.
 */
export const MAX_DIARY_DAYS = 7;

export type { UnconfirmedPresence } from "./working-spans";

export interface DiaryDayPayload {
  siteId: string;
  dayKeys: string[];
  windows: AvailabilityWindow[];
  /** Dentally patient id -> code. An absent patient is unresolvable and draws nothing. */
  funding: Record<string, FundingCode>;
  entries: DiaryEntryRecord[];
  /**
   * Clinician-days that work across more than one of this client's practices and
   * have nothing booked HERE that day, so their availability could belong to
   * another practice. Their windows are stripped from `windows` above and the
   * column says so in words rather than painting white or claiming "off".
   * See site-presence.ts.
   */
  unconfirmed: UnconfirmedPresence[];
  availabilityFailed: boolean;
  fundingFailed: boolean;
  entriesFailed: boolean;
}

export interface LoadDiaryDayArgs {
  clientId: string;
  siteId: string;
  dayKeys: string[];
  practitionerIds: readonly string[];
  /** A failed practitioner read IMPLIES a failed availability read. See below. */
  practitionersFailed: boolean;
  appointments: readonly AppointmentRecord[];
}

export async function loadDiaryDay(args: LoadDiaryDayArgs): Promise<DiaryDayPayload> {
  const dayKeys = [...args.dayKeys].sort().slice(0, MAX_DIARY_DAYS);
  const empty: DiaryDayPayload = {
    siteId: args.siteId,
    dayKeys,
    windows: [],
    funding: {},
    entries: [],
    unconfirmed: [],
    availabilityFailed: true,
    fundingFailed: true,
    entriesFailed: true,
  };
  if (dayKeys.length === 0) return { ...empty, availabilityFailed: false, fundingFailed: false, entriesFailed: false };

  const fromDayKey = dayKeys[0];
  const toDayKey = dayKeys[dayKeys.length - 1];

  const [availability, funding, entries] = await Promise.all([
    readAvailability(args, fromDayKey, toDayKey),
    readFunding(args, dayKeys),
    listEntries(args.siteId, dayKeys),
  ]);

  return {
    siteId: args.siteId,
    dayKeys,
    windows: availability.windows,
    funding: funding.funding,
    entries: entries.entries,
    unconfirmed: availability.unconfirmed,
    availabilityFailed: availability.failed,
    fundingFailed: funding.failed,
    entriesFailed: entries.failed,
  };
}

/** cancelled and did_not_attend do NOT prove anybody was in the building. */
function occupies(state: string): boolean {
  return state !== "cancelled" && state !== "did_not_attend";
}

async function readAvailability(
  args: LoadDiaryDayArgs,
  fromDayKey: string,
  toDayKey: string,
): Promise<{ windows: AvailabilityWindow[]; unconfirmed: UnconfirmedPresence[]; failed: boolean }> {
  // PRACTITIONERS FAILED IMPLIES AVAILABILITY FAILED, set EXPLICITLY here at the
  // source rather than inferred at each use site. Availability takes no site
  // parameter: the practitioner id set is the only thing scoping it to this site,
  // so a partial or wrong set could return another practice's windows with nothing
  // in the response to catch it. No call is issued at all.
  if (args.practitionersFailed) return { windows: [], unconfirmed: [], failed: true };

  // The practitioner id set is NOT on its own enough to scope availability to a
  // site: a clinician on two of this client's lists is asked about by both, and
  // the answer carries no site. readSharedPractitionerIds says who that is, so a
  // window can be refused rather than painted as this practice's capacity.
  const [read, sharedRead] = await Promise.all([
    listDiaryAvailabilitySafe({
      siteId: args.siteId,
      practitionerIds: args.practitionerIds,
      fromDayKey,
      toDayKey,
    }),
    readSharedPractitionerIds(args.clientId, args.siteId),
  ]);
  if (read.failed) return { windows: [], unconfirmed: [], failed: true };

  const parsed = parseAvailabilityWindows(read.rows);

  // A row carrying no practitioner id was refused attribution rather than guessed.
  // One is a tolerable oddity; a quarter of them means the multi-practitioner
  // batching assumption has broken, and a partly-attributed set silently shrinks
  // somebody's working day. Fail the whole read instead.
  if (parsed.total > 0 && parsed.untagged / parsed.total > UNTAGGED_FAIL_RATIO) {
    console.error(
      `[diary] ${parsed.untagged} of ${parsed.total} availability rows carried no practitioner id at site ${args.siteId}; treating the read as failed`,
    );
    return { windows: [], unconfirmed: [], failed: true };
  }
  if (parsed.untagged > 0) {
    console.warn(
      `[diary] dropped ${parsed.untagged} availability row(s) with no practitioner id at site ${args.siteId}`,
    );
  }

  // Who is demonstrably HERE: at least one appointment at this site, on this day,
  // in a state that consumes their time. Appointments are read per site, so they
  // are the one site-scoped signal available.
  const bookedHere = new Set<string>();
  for (const a of args.appointments) {
    if (a.siteId !== args.siteId) continue;
    if (!occupies(a.state)) continue;
    if (a.practitionerId === null || a.practitionerId === "") continue;
    bookedHere.add(`${a.practitionerId}|${londonDayKey(new Date(a.start))}`);
  }

  const dayKeys = dayKeysBetween(fromDayKey, toDayKey);
  const unconfirmed: UnconfirmedPresence[] = [];
  const blocked = new Set<string>();
  for (const practitionerId of args.practitionerIds) {
    for (const dayKey of dayKeys) {
      const trusted = availabilityTrustedHere({
        sharedWithAnotherSite: sharedRead.shared.has(practitionerId),
        rosterUnknown: sharedRead.rosterUnknown,
        bookedHere: bookedHere.has(`${practitionerId}|${dayKey}`),
      });
      if (trusted) continue;
      unconfirmed.push({ practitionerId, dayKey });
      blocked.add(`${practitionerId}|${dayKey}`);
    }
  }

  // The windows themselves are STRIPPED, not merely flagged. A flag can be
  // ignored by one caller out of five; an absent window cannot be painted.
  const windows =
    blocked.size === 0
      ? parsed.windows
      : parsed.windows.filter((w) => !blocked.has(`${w.practitionerId}|${w.dayKey}`));

  return { windows, unconfirmed, failed: false };
}

async function readFunding(
  args: LoadDiaryDayArgs,
  dayKeys: string[],
): Promise<{ funding: Record<string, FundingCode>; failed: boolean }> {
  const funding: Record<string, FundingCode> = {};
  let failed = false;

  // Per day, because the cache is keyed per (siteId, dayKey) and a day is the unit
  // the reader is actually looking at.
  for (const dayKey of dayKeys) {
    const forDay = args.appointments.filter((a) => a.siteId === args.siteId && londonDayKey(new Date(a.start)) === dayKey);
    if (forDay.length === 0) continue;
    const resolved = await resolveDayFunding(args.siteId, dayKey, forDay);
    if (resolved.failed) failed = true;
    for (const [patientId, code] of resolved.byPatientId) funding[patientId] = code;
  }

  // A partial resolution is reported as failed for the whole site: the reader
  // cannot tell which missing rails were facts and which were the outage.
  return { funding, failed };
}
