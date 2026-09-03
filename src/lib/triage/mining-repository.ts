import { serviceClient } from "@/lib/supabase/server";
import type { MiningCandidate, MiningCoverage } from "./mining";

// Persistence for the implant-interest mining list (migration 0097:
// previsit_mining_scan, previsit_mining_candidate). Service-role only, RLS on
// with no anon / authenticated grants, matching the post-0012 posture.
//
// TWO TABLES BECAUSE THEY ARE TWO DIFFERENT FACTS. `previsit_mining_candidate`
// is who the scan found; `previsit_mining_scan` is HOW MUCH OF THE PAST WAS
// READ. A candidate list without its coverage is a number wearing a complete
// number's clothes, which is the one thing this platform's honesty rule forbids —
// so the coverage row is not metadata, it is half the answer, and every read
// below returns them together or not at all.

interface CoverageRow {
  site_id: string;
  covered_from: string;
  covered_to: string;
  examined: number;
  candidates: number;
  excluded_no_dob: number;
  excluded_under_age: number;
  last_run_at: string;
  more_to_read: boolean;
}

const COVERAGE_COLUMNS =
  "site_id, covered_from, covered_to, examined, candidates, excluded_no_dob, excluded_under_age, last_run_at, more_to_read";

function rowToCoverage(r: CoverageRow): MiningCoverage {
  return {
    siteId: r.site_id,
    coveredFrom: r.covered_from,
    coveredTo: r.covered_to,
    examined: Number(r.examined ?? 0),
    candidates: Number(r.candidates ?? 0),
    excludedNoDob: Number(r.excluded_no_dob ?? 0),
    excludedUnderAge: Number(r.excluded_under_age ?? 0),
    lastRunAt: r.last_run_at,
    moreToRead: Boolean(r.more_to_read),
  };
}

export async function getCoverage(siteId: string): Promise<MiningCoverage | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_mining_scan")
    .select(COVERAGE_COLUMNS)
    .eq("site_id", siteId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToCoverage(data as CoverageRow) : null;
}

export async function listCoverage(siteIds: string[]): Promise<MiningCoverage[]> {
  if (siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_mining_scan")
    .select(COVERAGE_COLUMNS)
    .in("site_id", siteIds);
  if (error) throw error;
  return ((data ?? []) as CoverageRow[]).map(rowToCoverage);
}

/**
 * Record one run's progress.
 *
 * `coveredFrom` only ever moves BACKWARDS and `coveredTo` only ever moves
 * FORWARDS, both enforced here rather than trusted from the caller. A run that
 * failed part way and reported a narrower window must not shrink a coverage claim
 * the practice has already been shown: the window is a statement about what has
 * been read, and reading cannot be undone.
 *
 * The counters ADD rather than replace, for the same reason.
 */
export async function recordScanRun(input: {
  siteId: string;
  coveredFrom: string;
  coveredTo: string;
  examined: number;
  candidates: number;
  excludedNoDob: number;
  excludedUnderAge: number;
  moreToRead: boolean;
  now: string;
}): Promise<void> {
  const db = serviceClient();
  const existing = await getCoverage(input.siteId);
  const coveredFrom =
    existing && existing.coveredFrom < input.coveredFrom ? existing.coveredFrom : input.coveredFrom;
  const coveredTo =
    existing && existing.coveredTo > input.coveredTo ? existing.coveredTo : input.coveredTo;
  const { error } = await db.from("previsit_mining_scan").upsert(
    {
      site_id: input.siteId,
      covered_from: coveredFrom,
      covered_to: coveredTo,
      examined: (existing?.examined ?? 0) + input.examined,
      candidates: (existing?.candidates ?? 0) + input.candidates,
      excluded_no_dob: (existing?.excludedNoDob ?? 0) + input.excludedNoDob,
      excluded_under_age: (existing?.excludedUnderAge ?? 0) + input.excludedUnderAge,
      last_run_at: input.now,
      more_to_read: input.moreToRead,
    },
    { onConflict: "site_id" },
  );
  if (error) throw error;
}

interface CandidateRow {
  id: string;
  site_id: string;
  dentally_patient_id: string;
  patient_name: string;
  age: number;
  last_extraction_at: string;
  matched_text: string;
  created_at: string;
  updated_at: string;
}

const CANDIDATE_COLUMNS =
  "id, site_id, dentally_patient_id, patient_name, age, last_extraction_at, matched_text, created_at, updated_at";

function rowToCandidate(r: CandidateRow): MiningCandidate {
  return {
    id: r.id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    age: Number(r.age ?? 0),
    lastExtractionAt: r.last_extraction_at,
    matchedText: r.matched_text ?? "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Record a candidate, keeping the MOST RECENT extraction when one already exists.
 *
 * The primary key is `${siteId}:${patientId}` so the scan is idempotent: reading
 * the same window twice cannot list a patient twice. Because the scan walks
 * BACKWARDS, a later run finds OLDER appointments, so `last_extraction_at` is
 * only overwritten when the new one is newer — which it rarely is, and the guard
 * costs nothing.
 */
export async function upsertCandidate(input: {
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  age: number;
  lastExtractionAt: string;
  matchedText: string;
}): Promise<boolean> {
  const db = serviceClient();
  const id = `${input.siteId}:${input.dentallyPatientId}`;
  const { data: existing, error: readErr } = await db
    .from("previsit_mining_candidate")
    .select("id, last_extraction_at")
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw readErr;

  if (existing) {
    const prev = (existing as { last_extraction_at: string }).last_extraction_at;
    if (prev >= input.lastExtractionAt) return false; // nothing newer to record
    const { error } = await db
      .from("previsit_mining_candidate")
      .update({
        last_extraction_at: input.lastExtractionAt,
        matched_text: input.matchedText,
        age: input.age,
        patient_name: input.patientName,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw error;
    return false; // an update is not a NEW candidate; the counter must not double it
  }

  const { error } = await db.from("previsit_mining_candidate").insert({
    id,
    site_id: input.siteId,
    dentally_patient_id: input.dentallyPatientId,
    patient_name: input.patientName,
    age: input.age,
    last_extraction_at: input.lastExtractionAt,
    matched_text: input.matchedText,
  });
  if (error) {
    // A unique violation means a concurrent run got there first. Not new, not an
    // error worth failing the run for.
    if ((error as { code?: string }).code === "23505") return false;
    throw error;
  }
  return true;
}

export async function listCandidates(args: {
  siteIds: string[];
  limit?: number;
}): Promise<MiningCandidate[]> {
  if (args.siteIds.length === 0) return [];
  const db = serviceClient();
  const { data, error } = await db
    .from("previsit_mining_candidate")
    .select(CANDIDATE_COLUMNS)
    .in("site_id", args.siteIds)
    .order("last_extraction_at", { ascending: false })
    .limit(args.limit ?? 300);
  if (error) throw error;
  return ((data ?? []) as CandidateRow[]).map(rowToCandidate);
}
