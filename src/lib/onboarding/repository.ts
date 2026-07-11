import { serviceClient } from "@/lib/supabase/server";
import type {
  OnboardingAddress,
  OnboardingConsent,
  OnboardingDental,
  OnboardingFile,
  OnboardingMedical,
  OnboardingStatus,
  OnboardingSubmission,
} from "./types";

// Onboarding owns one server-only table: onboarding_submission (one row per completed
// form). Documents live in the private `onboarding` Storage bucket; the row only holds
// references. Access is via the service-role client only — the public submit + upload
// endpoints validate + rate-limit before writing, and the internal list + file
// endpoints are requireUser + client-scoped.

/** The private Storage bucket for onboarding documents (created out of band). */
export const ONBOARDING_BUCKET = "onboarding";

// ---------------------------------------------------------------------------
// Row shape + mapper.
// ---------------------------------------------------------------------------

interface SubmissionRow {
  id: string;
  client_id: string;
  site_id: string | null;
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
  phone: string | null;
  email: string | null;
  address: OnboardingAddress | null;
  medical: OnboardingMedical | null;
  dental: OnboardingDental | null;
  heard_about: string | null;
  files: OnboardingFile[] | null;
  consent: OnboardingConsent | null;
  custom: Record<string, string> | null;
  status: string;
  created_at: string;
}

function rowToSubmission(r: SubmissionRow): OnboardingSubmission {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    firstName: r.first_name,
    lastName: r.last_name,
    dateOfBirth: r.date_of_birth,
    phone: r.phone,
    email: r.email,
    address: r.address,
    medical: r.medical,
    dental: r.dental,
    heardAbout: r.heard_about,
    files: Array.isArray(r.files) ? r.files : [],
    consent: r.consent,
    custom: r.custom ?? null,
    status: r.status as OnboardingStatus,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

export interface CreateSubmissionInput {
  clientId: string;
  /** The onboarding form this came from, or null for the default /onboard/<client> flow. */
  formId?: string | null;
  siteId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: OnboardingAddress | null;
  medical?: OnboardingMedical | null;
  dental?: OnboardingDental | null;
  heardAbout?: string | null;
  files?: OnboardingFile[];
  consent?: OnboardingConsent | null;
  custom?: Record<string, string> | null;
}

export async function createSubmission(
  input: CreateSubmissionInput,
): Promise<OnboardingSubmission> {
  const db = serviceClient();
  const { data, error } = await db
    .from("onboarding_submission")
    .insert({
      client_id: input.clientId,
      form_id: input.formId ?? null,
      site_id: input.siteId ?? null,
      first_name: input.firstName ?? null,
      last_name: input.lastName ?? null,
      date_of_birth: input.dateOfBirth ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      address: input.address ?? null,
      medical: input.medical ?? null,
      dental: input.dental ?? null,
      heard_about: input.heardAbout ?? null,
      files: input.files ?? [],
      consent: input.consent ?? null,
      custom: input.custom ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToSubmission(data as SubmissionRow);
}

/** Move a submission through the review workflow (new -> reviewed -> registered/archived). */
export async function setStatus(
  id: string,
  status: OnboardingStatus,
): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("onboarding_submission")
    .update({ status })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** All submissions for a client, newest first (staff worklist). Pass `siteIds` to
 *  scope to the dashboard's selected site(s); rows with NO site (the generic
 *  /onboard/<client> flow, where the patient chose no site) are always included so
 *  they can be triaged from any site's view rather than silently disappearing. */
export async function listSubmissions(
  clientId: string,
  limit = 200,
  siteIds?: string[],
): Promise<OnboardingSubmission[]> {
  const db = serviceClient();
  let q = db
    .from("onboarding_submission")
    .select("*")
    .eq("client_id", clientId);
  if (siteIds && siteIds.length > 0) {
    q = q.or(`site_id.in.(${siteIds.join(",")}),site_id.is.null`);
  }
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as SubmissionRow[]).map(rowToSubmission);
}

/**
 * A lightweight roll-up of NEW submissions for the notifications badge: an exact
 * count plus the newest timestamp, WITHOUT pulling every full row (each carries the
 * answers jsonb, re-served on every notifications build). Selects `created_at` only.
 */
export async function countNewSubmissions(
  clientId: string,
): Promise<{ count: number; newestAt: string | null }> {
  const db = serviceClient();
  const { data, count, error } = await db
    .from("onboarding_submission")
    .select("created_at", { count: "exact" })
    .eq("client_id", clientId)
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = (data as { created_at: string }[] | null) ?? [];
  return { count: count ?? rows.length, newestAt: rows[0]?.created_at ?? null };
}

export async function getSubmission(
  id: string,
): Promise<OnboardingSubmission | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("onboarding_submission")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToSubmission(data as SubmissionRow) : null;
}

// ---------------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------------

/**
 * Mint a short-lived signed URL for a document in the private `onboarding` bucket.
 * The caller MUST have already validated that `path` is under the requesting
 * client's prefix (onboarding/<clientSlug>/...) before calling this — this helper
 * does not enforce tenancy, it only signs.
 */
export async function signFileUrl(
  path: string,
  expiresSeconds: number,
): Promise<string | null> {
  const db = serviceClient();
  const { data, error } = await db.storage
    .from(ONBOARDING_BUCKET)
    .createSignedUrl(path, expiresSeconds);
  if (error || !data) return null;
  return data.signedUrl;
}
