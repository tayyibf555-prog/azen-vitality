import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type {
  StaffPolicy,
  StaffPolicySignature,
  StaffSignature,
} from "./esign";

// ===========================================================================
// public.staff_policy + public.staff_policy_signature — server-only (service role).
//
// THE EVIDENCE RULES, enforced here as well as in the schema:
//   - A new version is a NEW ROW. Nothing here updates a policy's wording, storage
//     path or version, because a signature binds to a version and rewriting a
//     version underneath a signature would fabricate evidence.
//   - Nothing here DELETES a policy. The FK is `on delete restrict` and there is
//     deliberately no delete function to match: a signed version must survive.
//     Withdrawing a policy sets `retired_at`, which keeps the row and the
//     signatures against it.
//   - A signature is upserted per (client, staff, policy). Re-signing after a new
//     version replaces the affirmation of wording that is no longer in force, and
//     the version it binds to is stamped from the POLICY ROW, never from the body.
//
// LOUD ON FAILURE: reads throw on a real error and report `ready:false` only when
// the migration is unapplied.
// ===========================================================================

const POLICY_TABLE = "staff_policy";
const SIGNATURE_TABLE = "staff_policy_signature";

interface PolicyRow {
  id: string;
  client_id: string;
  slug: string;
  title: string;
  version: number;
  storage_path: string;
  mime: string;
  size_bytes: number;
  effective_from: string;
  retired_at: string | null;
  created_by: string | null;
  created_at: string;
}

interface SignatureRow {
  id: string;
  client_id: string;
  staff_id: string;
  policy_id: string;
  policy_version: number;
  signature: StaffSignature;
  signed_at: string;
  ip_hash: string | null;
  user_agent: string | null;
}

function rowToPolicy(r: PolicyRow): StaffPolicy {
  return {
    id: r.id,
    clientId: r.client_id,
    slug: r.slug,
    title: r.title,
    version: r.version,
    storagePath: r.storage_path,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    effectiveFrom: r.effective_from,
    retiredAt: r.retired_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function rowToSignature(r: SignatureRow): StaffPolicySignature {
  return {
    id: r.id,
    clientId: r.client_id,
    staffId: r.staff_id,
    policyId: r.policy_id,
    policyVersion: r.policy_version,
    signature: r.signature,
    signedAt: r.signed_at,
    ipHash: r.ip_hash,
    userAgent: r.user_agent,
  };
}

function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "42703";
}

export interface PolicyReadResult {
  ready: boolean;
  policies: StaffPolicy[];
}

export interface SignatureReadResult {
  ready: boolean;
  signatures: StaffPolicySignature[];
}

/** Every version of every policy for a practice, newest version first. */
export async function listPolicies(clientId: string, limit = 300): Promise<PolicyReadResult> {
  const { data, error } = await serviceClient()
    .from(POLICY_TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("slug", { ascending: true })
    .order("version", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingRelation(error)) return { ready: false, policies: [] };
    throw error;
  }
  return { ready: true, policies: (data ?? []).map((r) => rowToPolicy(r as PolicyRow)) };
}

/** One policy version by id, client-scoped. Null when it is not this practice's. */
export async function getPolicy(clientId: string, id: string): Promise<StaffPolicy | null> {
  const { data, error } = await serviceClient()
    .from(POLICY_TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw error;
  }
  return data ? rowToPolicy(data as PolicyRow) : null;
}

export interface CreatePolicyInput {
  clientId: string;
  slug: string;
  title: string;
  version: number;
  storagePath: string;
  mime: string;
  sizeBytes: number;
  effectiveFrom: string;
  createdBy: string | null;
}

/**
 * Publish a policy version. THROWS on failure.
 *
 * The version is allocated by the caller from `nextPolicyVersion` over the rows it
 * just read. The unique (client_id, slug, version) is the real guarantee: if two
 * managers publish at once, the second insert fails rather than producing two
 * different documents both calling themselves version 4.
 */
export async function createPolicy(input: CreatePolicyInput): Promise<StaffPolicy> {
  const { data, error } = await serviceClient()
    .from(POLICY_TABLE)
    .insert({
      client_id: input.clientId,
      slug: input.slug,
      title: input.title,
      version: input.version,
      storage_path: input.storagePath,
      mime: input.mime,
      size_bytes: input.sizeBytes,
      effective_from: input.effectiveFrom,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToPolicy(data as PolicyRow);
}

/**
 * Retire every EARLIER version of a slug once a new one is published.
 *
 * Retiring, never deleting: the rows and their signatures stay, and
 * `currentPolicies` stops offering the old wording for signature. Best effort and
 * reported, not thrown — the new version is already published and correct, and a
 * failure here leaves an older version visible, which is untidy rather than unsafe.
 */
export async function retireEarlierVersions(
  clientId: string,
  slug: string,
  belowVersion: number,
  atIso: string,
): Promise<boolean> {
  const { error } = await serviceClient()
    .from(POLICY_TABLE)
    .update({ retired_at: atIso })
    .eq("client_id", clientId)
    .eq("slug", slug)
    .lt("version", belowVersion)
    .is("retired_at", null);
  return !error;
}

/** Every signature for a practice (the compliance view). */
export async function listSignatures(
  clientId: string,
  limit = 2000,
): Promise<SignatureReadResult> {
  const { data, error } = await serviceClient()
    .from(SIGNATURE_TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("signed_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingRelation(error)) return { ready: false, signatures: [] };
    throw error;
  }
  return { ready: true, signatures: (data ?? []).map((r) => rowToSignature(r as SignatureRow)) };
}

/** One person's signatures. The staff id comes from the SESSION, never from a body. */
export async function listSignaturesForStaff(
  clientId: string,
  staffId: string,
): Promise<SignatureReadResult> {
  const { data, error } = await serviceClient()
    .from(SIGNATURE_TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("staff_id", staffId)
    .limit(500);
  if (error) {
    if (isMissingRelation(error)) return { ready: false, signatures: [] };
    throw error;
  }
  return { ready: true, signatures: (data ?? []).map((r) => rowToSignature(r as SignatureRow)) };
}

export interface RecordSignatureInput {
  clientId: string;
  /** Resolved from the caller's SESSION via findStaffByAppUser. Never from a body. */
  staffId: string;
  policyId: string;
  /** Read from the POLICY ROW, never supplied by the client. */
  policyVersion: number;
  signature: StaffSignature;
  signedAt: string;
  ipHash: string | null;
  userAgent: string | null;
}

/**
 * Record (or re-record, after a new version) one person's signature. THROWS on
 * failure: telling somebody they have signed when nothing was stored is exactly the
 * failure this whole feature exists to prevent.
 */
export async function recordSignature(
  input: RecordSignatureInput,
): Promise<StaffPolicySignature> {
  const { data, error } = await serviceClient()
    .from(SIGNATURE_TABLE)
    .upsert(
      {
        client_id: input.clientId,
        staff_id: input.staffId,
        policy_id: input.policyId,
        policy_version: input.policyVersion,
        signature: input.signature,
        signed_at: input.signedAt,
        ip_hash: input.ipHash,
        user_agent: input.userAgent,
      },
      { onConflict: "client_id,staff_id,policy_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return rowToSignature(data as SignatureRow);
}
