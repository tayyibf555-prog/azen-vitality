import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type {
  Fp17CapturedVia,
  Fp17Consent,
  Fp17Declaration,
  Fp17DeclarationChoice,
  Fp17DeclarationSummary,
  Fp17Signature,
  Fp17Status,
} from "./types";

// FP17 owns one server-only table: fp17_declaration (one row per captured consent +
// exemption declaration). Access is via the service-role client only — the public
// submit endpoint validates + kill-switches + rate-limits + budgets before writing,
// and the internal list endpoint is requireUser + client-scoped + module-guarded.
//
// LOUD ON FAILURE: every read throws on a DB error rather than returning [] — an
// empty list must mean "no declarations captured", never "the read failed". The
// list route turns a throw into an honest failure panel (FP17_COPY.readFailed), not
// a confident empty state. This is the repo's worst historical defect class.
//
// NOTHING HERE IS SUBMITTED TO THE NHS (Compass). This is our own record. The
// gate that decides whether capture happens at all is the kill switch
// (isSystemEnabled(clientId, "fp17")), checked at the API layer, not here.

const TABLE = "fp17_declaration";

// ---------------------------------------------------------------------------
// Row shape + mappers.
// ---------------------------------------------------------------------------

interface DeclarationRow {
  id: string;
  client_id: string;
  site_id: string | null;
  dentally_patient_id: string | null;
  patient_name: string | null;
  date_of_birth: string | null;
  consent: Fp17Consent | null;
  exemption_category: string;
  exemption_evidence_ack: boolean;
  declaration_truth: boolean;
  signature: Fp17Signature | null;
  captured_via: string;
  status: string;
  created_at: string;
}

function rowToDeclaration(r: DeclarationRow): Fp17Declaration {
  return {
    id: r.id,
    clientId: r.client_id,
    siteId: r.site_id,
    dentallyPatientId: r.dentally_patient_id,
    patientName: r.patient_name,
    dateOfBirth: r.date_of_birth,
    consent: r.consent,
    exemptionCategory: r.exemption_category as Fp17DeclarationChoice,
    exemptionEvidenceAck: Boolean(r.exemption_evidence_ack),
    declarationTruth: Boolean(r.declaration_truth),
    signature: r.signature,
    capturedVia: r.captured_via as Fp17CapturedVia,
    status: r.status as Fp17Status,
    createdAt: r.created_at,
  };
}

/** Drop the signature VALUE for a list view — keep only method + signedAt. */
function toSummary(d: Fp17Declaration): Fp17DeclarationSummary {
  const { signature, ...rest } = d;
  return {
    ...rest,
    signature: signature ? { method: signature.method, signedAt: signature.signedAt } : null,
  };
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

export interface CreateDeclarationInput {
  clientId: string;
  /** Resolved from the signed link token, not the request body. */
  siteId: string | null;
  dentallyPatientId: string | null;
  patientName: string | null;
  dateOfBirth: string | null;
  consent: Fp17Consent | null;
  exemptionCategory: string;
  exemptionEvidenceAck: boolean;
  declarationTruth: boolean;
  signature: Fp17Signature | null;
  capturedVia: Fp17CapturedVia;
}

export async function createDeclaration(
  input: CreateDeclarationInput,
): Promise<Fp17Declaration> {
  const db = serviceClient();
  const { data, error } = await db
    .from(TABLE)
    .insert({
      client_id: input.clientId,
      site_id: input.siteId,
      dentally_patient_id: input.dentallyPatientId,
      patient_name: input.patientName,
      date_of_birth: input.dateOfBirth,
      consent: input.consent,
      exemption_category: input.exemptionCategory,
      exemption_evidence_ack: input.exemptionEvidenceAck,
      declaration_truth: input.declarationTruth,
      signature: input.signature,
      captured_via: input.capturedVia,
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowToDeclaration(data as DeclarationRow);
}

/** Move a declaration through staff triage (new -> reviewed -> archived). */
export async function setStatus(id: string, status: Fp17Status): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from(TABLE).update({ status }).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Reads. LIST-SAFE: the signature value is never returned in a summary.
// ---------------------------------------------------------------------------

/**
 * A client's declarations, newest first (staff worklist). Pass `siteIds` to scope to
 * the dashboard's selected site(s); rows with NO site (a generic link) are always
 * included so they can be triaged from any site's view rather than disappearing.
 * Throws on a read error — never returns [] for a failure.
 */
export async function listDeclarations(
  clientId: string,
  limit = 200,
  siteIds?: string[],
): Promise<Fp17DeclarationSummary[]> {
  const db = serviceClient();
  let q = db.from(TABLE).select("*").eq("client_id", clientId);
  if (siteIds && siteIds.length > 0) {
    q = q.or(`site_id.in.(${siteIds.join(",")}),site_id.is.null`);
  }
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as DeclarationRow[]).map(rowToDeclaration).map(toSummary);
}

/**
 * Count of NEW declarations for a client (for a badge), plus the newest timestamp,
 * without pulling every full row. Same site-scoping rule as listDeclarations.
 */
export async function countNewDeclarations(
  clientId: string,
  siteIds?: string[],
): Promise<{ count: number; newestAt: string | null }> {
  const db = serviceClient();
  let q = db
    .from(TABLE)
    .select("created_at", { count: "exact" })
    .eq("client_id", clientId)
    .eq("status", "new");
  if (siteIds && siteIds.length > 0) {
    q = q.or(`site_id.in.(${siteIds.join(",")}),site_id.is.null`);
  }
  const { data, count, error } = await q.order("created_at", { ascending: false }).limit(1);
  if (error) throw error;
  const rows = (data as { created_at: string }[] | null) ?? [];
  return { count: count ?? rows.length, newestAt: rows[0]?.created_at ?? null };
}

/** One declaration by id, full (signature included). Throws on error. */
export async function getDeclaration(id: string): Promise<Fp17Declaration | null> {
  const db = serviceClient();
  const { data, error } = await db.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToDeclaration(data as DeclarationRow) : null;
}
