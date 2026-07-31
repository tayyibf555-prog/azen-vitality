import "server-only";

// ===========================================================================
// RESOLVING A DAY'S FUNDING.
//
// Funding is a PATIENT-level fact and an appointment payload carries no payment
// plan, so the diary resolves the day's DISTINCT patients and reads the plan from
// each patient record.
//
// It deliberately does NOT use getPatientById. That helper swallows every error
// into `null`, which would make a Dentally outage indistinguishable from "this
// patient has no plan on file" - and the whole point of the funding read is that a
// missing rail means "not on file" while a failed read says so in words. This
// module calls the client directly so it can tell a 404 from a throw.
// ===========================================================================

import { DentallyError } from "@/lib/dentally/client";
import { dentallyFromEnv, type AppointmentRecord } from "@/lib/dentally/read";
import { mapWithConcurrency } from "@/lib/async/pool";
import { fundingFromPlanId, readPlanId, type FundingCode } from "./funding";

/** The house fan-out figure (sync/coordinator, sync/reactivation both use 8). */
const FUNDING_CONCURRENCY = 8;

/**
 * Five minutes, not the readCache's sixty seconds: a patient's funding changes
 * roughly once a year, so a short TTL buys nothing and costs a fan-out of up to
 * fifty patient reads on every navigation.
 */
const FUNDING_TTL_MS = 300_000;

/**
 * A DEDICATED cache, one entry per (siteId, dayKey) holding the whole day's map.
 *
 * NOT the shared readCache, and never one entry per patient. readCache is a single
 * 300-entry map shared with the appointment and practitioner reads; roughly fifty
 * entries per viewed day would evict the diary's own core reads in about six
 * navigations, so the feature that colours the blocks would slow down the feature
 * that draws them.
 */
const FUNDING_CACHE_MAX = 60;
const FUNDING_CACHE_DROP = 15;
const fundingCache = new Map<string, { at: number; value: DayFunding }>();

export interface DayFunding {
  /** Dentally patient id -> code. A patient absent from the map is unresolvable. */
  byPatientId: Map<string, FundingCode>;
  /**
   * True when at least one patient read failed for a reason that is NOT a 404.
   * The caller must then draw no rail anywhere at that site and say in words that
   * funding could not be read, because "no rail" and "not on file" look identical.
   */
  failed: boolean;
}

/**
 * Resolve every distinct patient on a day to a funding code.
 *
 * Bounded, batched, cached and scoped to the VISIBLE day only - never to the
 * diary's loaded sixty-day window, which would turn one navigation into thousands
 * of patient reads.
 *
 * A 404 for one patient is NOT a failure: that patient simply resolves to
 * "unknown" and draws nothing. Any other throw (a 5xx, a network error, the
 * client's 15s timeout) fails the WHOLE read, because a partially resolved day
 * would silently show a rail on some blocks and nothing on others with no way for
 * the reader to tell which absences were facts.
 */
export async function resolveDayFunding(
  siteId: string,
  dayKey: string,
  appointments: readonly AppointmentRecord[],
): Promise<DayFunding> {
  const patientIds = [...new Set(appointments.map((a) => a.patientId).filter((id) => id !== ""))];
  if (patientIds.length === 0) return { byPatientId: new Map(), failed: false };

  const cacheKey = `${siteId}:${dayKey}`;
  const byPatientId = new Map<string, FundingCode>();
  let failed = false;

  // A CACHE HIT IS ONLY A HIT IF IT COVERS THE PATIENTS BEING ASKED ABOUT.
  //
  // The entry was built from the day's appointment set as it stood up to five
  // minutes ago. A patient booked, or dragged in from another day, since then is
  // simply absent from it, and an absent patient is indistinguishable from an
  // unresolvable one: the block draws no rail and the panel states "Not on file"
  // for somebody whose plan is perfectly well known. So the cached map is used
  // for the patients it covers and the REST are resolved, rather than the whole
  // entry being returned on the strength of its key.
  let toResolve = patientIds;
  // The entry's ORIGINAL age is carried forward when it is topped up. Stamping it
  // with "now" on every merge would let a busy day hold one patient's plan alive
  // indefinitely, so a plan changed in Dentally directly would never age out.
  let cachedAt: number | null = null;
  if (!process.env.VITEST) {
    const hit = fundingCache.get(cacheKey);
    if (hit && Date.now() - hit.at < FUNDING_TTL_MS) {
      for (const [id, code] of hit.value.byPatientId) byPatientId.set(id, code);
      toResolve = patientIds.filter((id) => !hit.value.byPatientId.has(id));
      cachedAt = hit.at;
      if (toResolve.length === 0) return { byPatientId, failed: false };
    }
  }

  const client = dentallyFromEnv();

  await mapWithConcurrency(toResolve, FUNDING_CONCURRENCY, async (patientId) => {
    try {
      const res = await client.getPatient(patientId);
      const p = res.patient;
      if (!p || typeof p !== "object") {
        // A 200 carrying no patient is the same evidential value as a 404: we
        // asked, and there is nobody to read a plan from.
        byPatientId.set(patientId, "unknown");
        return;
      }
      byPatientId.set(patientId, fundingFromPlanId(readPlanId(p)));
    } catch (err) {
      if (err instanceof DentallyError && err.status === 404) {
        byPatientId.set(patientId, "unknown");
        return;
      }
      console.error(`[diary] funding read failed for patient ${patientId}`, err);
      failed = true;
    }
  });

  const value: DayFunding = { byPatientId, failed };
  // A FAILED read is never cached: caching it would serve "no funding anywhere"
  // back to every reader for the next five minutes.
  if (!process.env.VITEST && !failed) {
    fundingCache.set(cacheKey, { at: cachedAt ?? Date.now(), value });
    if (fundingCache.size > FUNDING_CACHE_MAX) {
      for (const [k] of [...fundingCache.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, FUNDING_CACHE_DROP)) {
        fundingCache.delete(k);
      }
    }
  }
  return value;
}

/**
 * Drop cached funding, for one patient or for everything.
 *
 * The platform's own patient editor writes payment_plan_id, and without this a
 * patient switched from Private to NHS would keep an orange rail and the word
 * "Private" on the diary for up to five minutes after the edit. The cache is
 * keyed per day, not per patient, so a patient-scoped drop clears every entry
 * that mentions them; that is a handful of maps, and correctness outranks the
 * scan.
 */
export function invalidateFundingCache(patientId?: string): void {
  if (patientId === undefined) {
    fundingCache.clear();
    return;
  }
  for (const [key, entry] of [...fundingCache.entries()]) {
    if (entry.value.byPatientId.has(patientId)) fundingCache.delete(key);
  }
}
