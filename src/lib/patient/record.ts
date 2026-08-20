import { DentallyBudgetExceededError } from "@/lib/dentally/client";
import {
  cachedRead,
  getPatientById,
  getPatientDetailUncached,
  unavailablePatientDetail,
  type PatientDetail,
  type PatientRecord,
  type ReadHealth,
} from "@/lib/dentally/read";
import { clientIdForSites } from "@/lib/mock/clients";
import { derivePatient, type PatientDerived } from "./record-derive";

/**
 * ONE SOURCE for the patient record, so its two surfaces can never disagree.
 *
 * The record is reachable two ways: the full page at /c/[client]/patients/[id],
 * server-rendered, and the quick-view drawer opened in place from the diary, the
 * dashboard, the command palette and every list that names a patient, which fetches
 * /api/dentally/patients/[id]. BOTH read through this function, and every figure they
 * show comes off `derived`. No component computes a figure.
 *
 * WHY IT IS ITS OWN CACHE ENTRY. Before this, the drawer computed lastSeen, nextAppt
 * and visits client-side while lifetimeSpend and outstanding came from the server,
 * and the three underlying reads were cached at 30s, 60s and not at all. Two surfaces
 * on that split diverge immediately. Here the by-id read and the detail read are BOTH
 * uncached and both sit inside ONE 30s entry, so within a warm instance the page and
 * the quick view are handed byte-identical objects from a single moment in time.
 *
 * WHAT IS STILL POSSIBLE, stated rather than hidden: across two Fluid Compute
 * instances the two surfaces can be up to 30 seconds apart. That is a staleness
 * window, not a disagreement about a moment, and it is the same trade every other
 * display read in this app already makes.
 *
 * SECURITY. This resolves a patient by id with NO site check of its own, exactly as
 * getPatientById does. The caller MUST check `record.patient.siteId` against the
 * caller's scope, and both callers do: the layout notFound()s a patient outside the
 * site-switcher selection, and the API route 404s a patient whose site does not match
 * the siteId it was given. Nothing here may be relaxed on the assumption that the
 * other end checked.
 */

export interface PatientRecordView {
  patient: PatientRecord;
  detail: PatientDetail;
  derived: PatientDerived;
  /** Which of the four Dentally reads actually succeeded, so a panel can say "we
   *  could not read this" rather than rendering an outage as an empty list. */
  reads: ReadHealth;
}

const RECORD_TTL_MS = 30_000;

/**
 * The whole record for one patient, or null when the patient cannot be resolved.
 *
 * `siteId` is used for the cache key and is passed to the detail read (which needs it
 * to scope treatment plans and to attribute appointments). It is NOT a permission
 * check: see the note above.
 */
export function getPatientRecord(patientId: string, siteId: string): Promise<PatientRecordView | null> {
  return cachedRead(
    clientIdForSites([siteId]),
    `patientrecord:${siteId}:${patientId}`,
    () => resolve(patientId, siteId),
    RECORD_TTL_MS,
  ).catch(async (err: unknown) => {
    // A BUDGET REFUSAL MUST NOT BECOME THE CACHED RECORD. The detail read propagates
    // it (dentally/read.ts, _getPatientDetailUncached) precisely so this cache entry
    // never promotes an all-"failed" record over the good one it is already serving —
    // the stale-while-revalidate refresh behind a reader is BACKGROUND work, refused
    // at 60% of the hour, so this is the ordinary busy-afternoon case, not an edge.
    //
    // Rebuilt here, OUTSIDE the cache, so the surfaces still render exactly what they
    // rendered before: the patient named, and every panel saying it could not be
    // read. getPatientById swallows, and inside a refused scope it short-circuits
    // without touching the budget store, so this costs nothing to answer.
    if (!(err instanceof DentallyBudgetExceededError)) throw err;
    console.warn(
      `[patient-record] the shared Dentally budget refused the record read for ${patientId}; ` +
        `serving the unavailable record WITHOUT caching it.`,
    );
    const patient = await getPatientById(patientId);
    if (!patient) return null;
    const detail = unavailablePatientDetail();
    return { patient, detail, derived: derivePatient(patient, detail, new Date()), reads: detail.reads };
  });
}

/**
 * The record, but ONLY when the patient belongs to one of `siteIds`.
 *
 * The site-switcher selection can be a single site or the whole group, and the record
 * read needs one site id, so the patient is resolved by id FIRST (a cheap direct
 * `GET /v1/patients/:id`) purely to learn which site they are in. That site is then
 * checked against the selection before any of the expensive per-patient reads happen.
 *
 * The alternative, trying each site in turn until one matches, would run the full
 * detail read once per site and throw most of it away.
 *
 * Returns null both for "does not exist" and for "exists, but outside your scope".
 * Callers must render the SAME 404 for both: distinguishing them would confirm that a
 * patient exists to someone who may not see them.
 */
export async function getPatientRecordInScope(
  patientId: string,
  siteIds: string[],
): Promise<PatientRecordView | null> {
  if (siteIds.length === 0) return null;
  const patient = await getPatientById(patientId);
  if (!patient || !siteIds.includes(patient.siteId)) return null;
  return getPatientRecord(patientId, patient.siteId);
}

async function resolve(patientId: string, siteId: string): Promise<PatientRecordView | null> {
  // Both reads are uncached and run concurrently, so the whole record is one round
  // trip's worth of latency and one moment in time.
  const [patient, detail] = await Promise.all([
    getPatientById(patientId),
    getPatientDetailUncached(patientId, siteId),
  ]);
  if (!patient) return null;
  // `now` is captured once, here, so ages and "next appointment" are consistent
  // across everything the two surfaces render from this object.
  const derived = derivePatient(patient, detail, new Date());
  return { patient, detail, derived, reads: detail.reads };
}
