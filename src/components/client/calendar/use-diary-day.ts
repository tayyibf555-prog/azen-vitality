"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AvailabilityWindow } from "@/lib/calendar/availability";
import type { UnconfirmedPresence } from "@/lib/calendar/working-spans";
import type { DiaryEntryRecord } from "@/lib/calendar/entries";
import type { FundingCode } from "@/lib/calendar/funding";

// ---------------------------------------------------------------------------
// The diary's per-day availability, funding and breaks.
//
// Scoped to the DAYS ON SCREEN and never to the diary's loaded sixty-day window.
// Availability is one call per site and range, but funding is a fan-out over the
// day's distinct PATIENTS, so resolving the whole window would be hundreds to
// thousands of patient reads per page load on live Dentally and would compete
// with the sync jobs for the rate budget.
//
// The first day is SEEDED from the server, so the first paint is already correct
// with no flash and no client round trip. Only a change of site, day, view or
// span costs a fetch.
// ---------------------------------------------------------------------------

export interface DiaryDayState {
  windows: AvailabilityWindow[];
  /** Dentally patient id -> code. An absent id is unresolvable and draws nothing. */
  funding: Record<string, FundingCode>;
  entries: DiaryEntryRecord[];
  /**
   * Clinician-days whose availability cannot be placed at THIS practice: they
   * work across more than one of the client's sites and nothing is booked here
   * that day. Their windows are already stripped server side; this list is what
   * lets the column say so in words instead of claiming "Not working".
   */
  unconfirmed: UnconfirmedPresence[];
  availabilityFailed: boolean;
  /**
   * Days on screen that Dentally cannot report hours for, because they have
   * already ended. NOT a failure and NOT an empty answer: the columns hatch and
   * say the date has passed. See day-load.ts.
   */
  unanswerableDayKeys: string[];
  fundingFailed: boolean;
  entriesFailed: boolean;
  /** True while a fetch for the current key is in flight. */
  loading: boolean;
}

/**
 * The honest answer when we have not asked, or when asking failed.
 *
 * ALL THREE flags go true together on a network failure rather than the previous
 * day's data being quietly kept: stale availability under a new date would paint
 * yesterday's sessions white on today's grid, which is a positive claim that a
 * named person is in when we do not know that at all.
 */
const UNKNOWN: Omit<DiaryDayState, "loading"> = {
  windows: [],
  funding: {},
  entries: [],
  unconfirmed: [],
  availabilityFailed: true,
  // EMPTY under "we did not get an answer". A day we could not read is "unknown",
  // and claiming it was unanswerable would explain away an outage as a calendar
  // fact.
  unanswerableDayKeys: [],
  fundingFailed: true,
  entriesFailed: true,
};

export interface DiaryDaySeed extends Omit<DiaryDayState, "loading"> {
  siteId: string;
  dayKeys: string[];
}

interface DayResponse {
  ok?: boolean;
  windows?: AvailabilityWindow[];
  funding?: Record<string, FundingCode>;
  entries?: DiaryEntryRecord[];
  unconfirmed?: UnconfirmedPresence[];
  availabilityFailed?: boolean;
  unanswerableDayKeys?: string[];
  fundingFailed?: boolean;
  entriesFailed?: boolean;
}

function keyOf(siteId: string, dayKeys: readonly string[]): string {
  return `${siteId}|${[...dayKeys].sort().join(",")}`;
}

/**
 * @param nonce bump it to force a refetch of the same days, which is what a
 *   saved break or note needs. It is part of the request key, so a refetch
 *   triggered by a write is subject to the same stale-response guard as a
 *   navigation, and the server seed is retired the moment it is bumped.
 */
export function useDiaryDay(
  siteId: string,
  dayKeys: readonly string[],
  seed: DiaryDaySeed | null,
  nonce = 0,
): DiaryDayState {
  const key = useMemo(() => `${nonce}:${keyOf(siteId, dayKeys)}`, [nonce, siteId, dayKeys]);
  const seedKey = useMemo(
    () => (seed && nonce === 0 ? `0:${keyOf(seed.siteId, seed.dayKeys)}` : null),
    [seed, nonce],
  );

  // Nothing to ask for is NOT "loading": with no site or no days on screen the
  // three flags stay at their honest default of "we did not get an answer".
  const canAsk = siteId !== "" && dayKeys.length > 0;
  const initial = (): DiaryDayState =>
    seed && seedKey === key ? { ...seed, loading: false } : { ...UNKNOWN, loading: canAsk };

  const [state, setState] = useState<DiaryDayState>(initial);

  // The state is reset DURING RENDER when the key changes, not in an effect. That
  // is what stops a stale day's windows being painted for one frame under the new
  // date, which on this screen would be a positive claim that a named person is
  // working when we have not asked yet.
  const [lastKey, setLastKey] = useState(key);
  if (lastKey !== key) {
    setLastKey(key);
    setState(initial());
  }

  // The key of the request whose answer we are still willing to accept. A reader
  // clicking through four days quickly must never have day two's windows painted
  // under day four's date.
  const wanted = useRef(key);

  useEffect(() => {
    wanted.current = key;

    // Already answered by the server seed, so no request is worth making.
    if (seed && seedKey === key) return;
    if (dayKeys.length === 0 || siteId === "") return;

    let cancelled = false;

    const params = new URLSearchParams({ site: siteId, days: [...dayKeys].join(",") });
    fetch(`/api/calendar/day?${params.toString()}`, { headers: { accept: "application/json" } })
      .then(async (res) => {
        const body = (await res.json()) as DayResponse;
        if (!res.ok || body.ok !== true) throw new Error("diary day read failed");
        return body;
      })
      .then((body) => {
        if (cancelled || wanted.current !== key) return;
        setState({
          windows: body.windows ?? [],
          funding: body.funding ?? {},
          entries: body.entries ?? [],
          unconfirmed: body.unconfirmed ?? [],
          // The route never 500s on a partial failure; each read carries its own
          // flag and each is honoured separately here. A missing flag is treated
          // as FAILED, never as success.
          availabilityFailed: body.availabilityFailed !== false,
          // A missing list is EMPTY, never assumed: this one only ever softens
          // what a column claims, so the safe default is not to soften it.
          unanswerableDayKeys: Array.isArray(body.unanswerableDayKeys) ? body.unanswerableDayKeys : [],
          fundingFailed: body.fundingFailed !== false,
          entriesFailed: body.entriesFailed !== false,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled || wanted.current !== key) return;
        setState({ ...UNKNOWN, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [key, siteId, dayKeys, seed, seedKey]);

  return state;
}
